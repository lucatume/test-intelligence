import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { runJsResolve, restMethodForCall } from '../../src/jsresolve/index.js';
import Database from 'better-sqlite3';
import { applyInitialSchema } from '../../src/store/migrations.js';
import { upsertFile, insertFact, upsertAnchor, insertFactAnchor } from '../../src/store/writers.js';
import { extractTsFile } from '../../src/extract/ts/extract.js';
import { synthesizeCompilerOptions } from '../../src/extract/ts/compiler.js';
import { WP_JS_PATTERNS } from '../../src/extract/declarative/wp-js-patterns.js';
import type { Fact } from '../../src/facts/types.js';
import { useTmpDir } from '../helpers/tmpDir.js';

const EPOCH = '2026-05-19T00:00:00.000Z';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  applyInitialSchema(db);
  return db;
}

// Insert one extracted fact (file row + fact row + its anchors) into the
// store using the real writers, mirroring runBuild's per-file path.
function seedFact(db: Database.Database, relPath: string, fact: Fact): number {
  const fileId = upsertFile(db, {
    path: relPath,
    language: 'js',
    contentHash: 'a'.repeat(64),
    extractedAt: EPOCH,
    isTest: false,
    framework: null,
    frameworkClass: null,
  });
  const factId = insertFact(db, {
    fileId,
    kind: fact.kind,
    resolved: fact.resolved,
    startLine: fact.location.startLine,
    endLine: fact.location.endLine,
    payload: fact.payload,
  });
  for (const a of fact.anchors) {
    const anchorId = upsertAnchor(db, { key: a.key, type: a.key.split(':')[0] ?? '' });
    insertFactAnchor(db, { factId, anchorId, role: a.role });
  }
  return factId;
}

describe('runJsResolve', () => {
  it('returns a zero summary for a store with no unresolved caller facts', () => {
    const db = new Database(':memory:');
    applyInitialSchema(db);
    const summary = runJsResolve(db, { projectRoot: '/nonexistent' });
    expect(summary).toEqual({ examined: 0, resolved: 0 });
  });

  describe('resolves unresolved rest-call-js facts interprocedurally', () => {
    const getTmp = useTmpDir('ti-jsresolve-idx-');

    it('resolves a cross-file apiFetch path and leaves a dynamic caller untouched', async () => {
      const root = getTmp();

      // Fixture: cfg.js exports the path constant; caller.js imports and calls
      // apiFetch with it. dynamic.js calls apiFetch with a runtime variable.
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src/cfg.js'), `export const PRODUCTS_PATH = '/wc/v3/products';\n`);
      writeFileSync(
        join(root, 'src/caller.js'),
        `import { PRODUCTS_PATH } from './cfg.js';\napiFetch({ path: PRODUCTS_PATH });\n`,
      );
      writeFileSync(
        join(root, 'src/dynamic.js'),
        `apiFetch({ path: window.dynamicPath });\n`,
      );

      const db = freshDb();
      const opts = synthesizeCompilerOptions(root);

      // Run ti's REAL extraction over the fixtures and seed the resulting
      // facts — not hand-written shapes — so the test exercises what ti emits.
      const callerFacts = await extractTsFile({
        projectRoot: root, relPath: 'src/caller.js', language: 'js',
        framework: null, compilerOptions: opts, patterns: WP_JS_PATTERNS,
      });
      const dynamicFacts = await extractTsFile({
        projectRoot: root, relPath: 'src/dynamic.js', language: 'js',
        framework: null, compilerOptions: opts, patterns: WP_JS_PATTERNS,
      });

      const callerRest = callerFacts.find((f) => f.kind === 'rest-call-js');
      const dynamicRest = dynamicFacts.find((f) => f.kind === 'rest-call-js');
      expect(callerRest).toBeDefined();
      expect(dynamicRest).toBeDefined();
      if (callerRest === undefined || dynamicRest === undefined) return;

      // Sanity-check the real extractor shape: unresolved, no anchors.
      expect(callerRest.resolved).toBe(false);
      expect(callerRest.anchors).toEqual([]);

      const resolvedFactId = seedFact(db, 'src/caller.js', callerRest);
      const dynamicFactId = seedFact(db, 'src/dynamic.js', dynamicRest);

      const summary = runJsResolve(db, { projectRoot: root });

      // Both facts were examined; only one resolved.
      expect(summary).toEqual({ examined: 2, resolved: 1 });

      // The resolvable fact is now resolved=1.
      const resolvedRow = db
        .prepare('SELECT resolved, payload FROM fact WHERE id = ?')
        .get(resolvedFactId) as { resolved: number; payload: string };
      expect(resolvedRow.resolved).toBe(1);
      const resolvedPayload = JSON.parse(resolvedRow.payload) as Record<string, unknown>;
      expect(resolvedPayload['route']).toBe('/wc/v3/products');
      expect((resolvedPayload['meta'] as Record<string, unknown>)['resolvedBy']).toBe('js-interprocedural');
      expect(resolvedPayload['unresolved']).toBeUndefined();

      // A fresh fact_anchor row to a PHP-listener-shaped key was inserted.
      const anchorKeys = (
        db
          .prepare(
            `SELECT a.key FROM fact_anchor fa JOIN anchor a ON a.id = fa.anchor_id
             WHERE fa.fact_id = ? AND fa.role = 'target'`,
          )
          .all(resolvedFactId) as { key: string }[]
      ).map((r) => r.key);
      expect(anchorKeys).toEqual(['rest:GET /wc/v3/products']);

      // The dynamic fact is still unresolved.
      const dynamicRow = db
        .prepare('SELECT resolved FROM fact WHERE id = ?')
        .get(dynamicFactId) as { resolved: number };
      expect(dynamicRow.resolved).toBe(0);

      db.close();
    });

    it('partial-folds a rest path to a narrow-wildcard anchor when one template part is dynamic', async () => {
      const root = getTmp();

      // Fixture: cfg.js exports a namespace constant; caller.js builds the
      // apiFetch path with a template that mixes the cross-file constant with
      // a function-parameter `id` that has no resolvable call site. Under the
      // partial-fold contract the resolved path is `wc-admin/items/{*}` —
      // a narrow wildcard (one {*} segment, namespace is concrete). The
      // orchestrator must accept this shape; broad wildcards (>1 {*} or
      // {*} in the first segment) are still rejected.
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src/cfg.js'), "export const NS = 'wc-admin';\n");
      writeFileSync(
        join(root, 'src/caller.js'),
        "import { NS } from './cfg.js';\n" +
          "function update(id) { apiFetch({ path: `${NS}/items/${id}` }); }\n" +
          "update(42);\n",
      );

      const db = freshDb();
      const opts = synthesizeCompilerOptions(root);
      const callerFacts = await extractTsFile({
        projectRoot: root, relPath: 'src/caller.js', language: 'js',
        framework: null, compilerOptions: opts, patterns: WP_JS_PATTERNS,
      });
      const callerRest = callerFacts.find((f) => f.kind === 'rest-call-js');
      expect(callerRest).toBeDefined();
      if (callerRest === undefined) return;
      expect(callerRest.resolved).toBe(false);

      const factId = seedFact(db, 'src/caller.js', callerRest);

      const summary = runJsResolve(db, { projectRoot: root });
      expect(summary.resolved).toBe(1);

      const row = db
        .prepare('SELECT resolved, payload FROM fact WHERE id = ?')
        .get(factId) as { resolved: number; payload: string };
      expect(row.resolved).toBe(1);
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      expect(payload['route']).toBe('wc-admin/items/{*}');
      expect((payload['meta'] as Record<string, unknown>)['resolvedBy']).toBe('js-interprocedural');

      const anchorKeys = (
        db
          .prepare(
            `SELECT a.key FROM fact_anchor fa JOIN anchor a ON a.id = fa.anchor_id
             WHERE fa.fact_id = ?`,
          )
          .all(factId) as { key: string }[]
      ).map((r) => r.key);
      expect(anchorKeys).toContain('rest:GET /wc-admin/items/{*}');

      db.close();
    });

    it('rejects a broad-wildcard partial fold (>1 {*} segment in path)', async () => {
      const root = getTmp();

      // Fixture: one resolvable const + two unresolvable exported-function
      // parameters → partial fold produces `'/list/{*}/{*}'` (anyResolved=true
      // because PRIMARY folds, but two {*} segments make this a broad
      // wildcard — would match too many listener anchors to be useful).
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'src/caller.js'),
        "const PRIMARY = 'list';\n" +
          "export function go(b, c) { apiFetch({ path: `/${PRIMARY}/${b}/${c}` }); }\n" +
          "go('1', '2');\n",
      );

      const db = freshDb();
      const opts = synthesizeCompilerOptions(root);
      const callerFacts = await extractTsFile({
        projectRoot: root, relPath: 'src/caller.js', language: 'js',
        framework: null, compilerOptions: opts, patterns: WP_JS_PATTERNS,
      });
      const callerRest = callerFacts.find((f) => f.kind === 'rest-call-js');
      expect(callerRest).toBeDefined();
      if (callerRest === undefined) return;

      const factId = seedFact(db, 'src/caller.js', callerRest);

      runJsResolve(db, { projectRoot: root });

      // Fact must stay unresolved — a broad wildcard would only re-introduce
      // the wildcard fan-out the bridge metric is designed to exclude.
      const row = db.prepare('SELECT resolved FROM fact WHERE id = ?').get(factId) as { resolved: number };
      expect(row.resolved).toBe(0);

      db.close();
    });

    it('strips a query string from a resolved rest path before forming the anchor', async () => {
      const root = getTmp();

      // Fixture: caller.js builds an apiFetch path that includes query args.
      // The PHP `register_rest_route` listener side never carries query args
      // (those are request params, not part of the route), so the caller-side
      // anchor key must drop them too — otherwise the literal anchor
      // `rest:GET /wc-admin/options` (which exists on the listener side) is
      // missed.
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src/cfg.js'), "export const PATH = '/wc-admin/options?options=foo,bar';\n");
      writeFileSync(
        join(root, 'src/caller.js'),
        "import { PATH } from './cfg.js';\napiFetch({ path: PATH });\n",
      );

      const db = freshDb();
      const opts = synthesizeCompilerOptions(root);
      const callerFacts = await extractTsFile({
        projectRoot: root, relPath: 'src/caller.js', language: 'js',
        framework: null, compilerOptions: opts, patterns: WP_JS_PATTERNS,
      });
      const callerRest = callerFacts.find((f) => f.kind === 'rest-call-js');
      expect(callerRest).toBeDefined();
      if (callerRest === undefined) return;

      const factId = seedFact(db, 'src/caller.js', callerRest);
      runJsResolve(db, { projectRoot: root });

      const anchorKeys = (
        db
          .prepare(
            `SELECT a.key FROM fact_anchor fa JOIN anchor a ON a.id = fa.anchor_id
             WHERE fa.fact_id = ?`,
          )
          .all(factId) as { key: string }[]
      ).map((r) => r.key);
      expect(anchorKeys).toContain('rest:GET /wc-admin/options');
      expect(anchorKeys.some((k) => k.includes('?'))).toBe(false);

      db.close();
    });

    it('repoints an existing {*}-placeholder anchor when the template folds to a literal', async () => {
      const root = getTmp();

      // Fixture: cfg.js exports a path segment; caller.js builds the apiFetch
      // path with a template literal that references the cross-file constant.
      // At extract time SEG is unresolved, so the engine renders the path as
      // the skeleton `/wc/v3/{*}` and emits a `rest:GET /wc/v3/{*}` anchor.
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src/cfg.js'), `export const SEG = 'products';\n`);
      writeFileSync(
        join(root, 'src/caller.js'),
        `import { SEG } from './cfg.js';\napiFetch({ path: \`/wc/v3/\${SEG}\` });\n`,
      );

      const db = freshDb();
      const opts = synthesizeCompilerOptions(root);

      const callerFacts = await extractTsFile({
        projectRoot: root, relPath: 'src/caller.js', language: 'js',
        framework: null, compilerOptions: opts, patterns: WP_JS_PATTERNS,
      });
      const callerRest = callerFacts.find((f) => f.kind === 'rest-call-js');
      expect(callerRest).toBeDefined();
      if (callerRest === undefined) return;

      // Sanity-check: the real extractor seeds a {*}-bearing anchor, so the
      // test genuinely exercises the repoint branch (not the insert branch).
      expect(callerRest.resolved).toBe(false);
      expect(callerRest.anchors.map((a) => a.key)).toEqual(['rest:GET /wc/v3/{*}']);

      const factId = seedFact(db, 'src/caller.js', callerRest);

      const summary = runJsResolve(db, { projectRoot: root });
      expect(summary).toEqual({ examined: 1, resolved: 1 });

      // The fact is resolved.
      const row = db
        .prepare('SELECT resolved, payload FROM fact WHERE id = ?')
        .get(factId) as { resolved: number; payload: string };
      expect(row.resolved).toBe(1);
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      expect((payload['meta'] as Record<string, unknown>)['resolvedBy']).toBe('js-interprocedural');

      // The {*} anchor link was repointed: old key gone, literal key present.
      const anchorKeys = (
        db
          .prepare(
            `SELECT a.key FROM fact_anchor fa JOIN anchor a ON a.id = fa.anchor_id
             WHERE fa.fact_id = ?`,
          )
          .all(factId) as { key: string }[]
      ).map((r) => r.key);
      expect(anchorKeys).not.toContain('rest:GET /wc/v3/{*}');
      expect(anchorKeys).toContain('rest:GET /wc/v3/products');

      db.close();
    });
  });

  describe('resolves ajax-action-from-url facts interprocedurally (issue 1)', () => {
    const getTmp = useTmpDir('ti-jsresolve-ajax-url-');

    it('extracts the action token from a cross-file URL and produces ajax:<token> anchor', async () => {
      const root = getTmp();

      // Fixture: constants.js exports a URL that embeds the action in a query
      // param; caller.js imports it and calls $.post with no data.action arg.
      // At extraction time the URL is an unresolved identifier, so the engine
      // cannot extract the action — the fact is unresolved with no anchor.
      // runJsResolve resolves the URL interprocedurally and must extract the
      // action token from it, NOT return the raw URL as the anchor key.
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'src/constants.js'),
        `export const AJAX_URL = 'https://example.com/wp-admin/admin-ajax.php?action=wc_x';\n`,
      );
      writeFileSync(
        join(root, 'src/caller.js'),
        `import { AJAX_URL } from './constants.js';\n$.post(AJAX_URL);\n`,
      );

      const db = freshDb();
      const opts = synthesizeCompilerOptions(root);

      const callerFacts = await extractTsFile({
        projectRoot: root, relPath: 'src/caller.js', language: 'js',
        framework: null, compilerOptions: opts, patterns: WP_JS_PATTERNS,
      });

      // The ajax-action-from-url pattern produces an unresolved ajax-call-js fact
      // (no anchor, because the action couldn't be extracted from the cross-file URL).
      const unresolvedFact = callerFacts.find(
        (f) => f.kind === 'ajax-call-js' && !f.resolved && f.anchors.length === 0,
      );
      expect(unresolvedFact, 'expected an unresolved ajax-call-js fact with no anchor').toBeDefined();
      if (unresolvedFact === undefined) return;

      const factId = seedFact(db, 'src/caller.js', unresolvedFact);

      const summary = runJsResolve(db, { projectRoot: root });
      expect(summary.resolved).toBe(1);

      // The resolved anchor must be ajax:wc_x, NOT a URL-shaped key.
      const anchorKeys = (
        db
          .prepare(
            `SELECT a.key FROM fact_anchor fa JOIN anchor a ON a.id = fa.anchor_id
             WHERE fa.fact_id = ? AND fa.role = 'target'`,
          )
          .all(factId) as { key: string }[]
      ).map((r) => r.key);
      expect(anchorKeys).toEqual(['ajax:wc_x']);

      // The payload action must also be the bare token.
      const row = db
        .prepare('SELECT resolved, payload FROM fact WHERE id = ?')
        .get(factId) as { resolved: number; payload: string };
      expect(row.resolved).toBe(1);
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      expect(payload['action']).toBe('wc_x');

      db.close();
    });
  });

  describe('resolved rest-call-js payload keeps method in sync (issue 2)', () => {
    const getTmp = useTmpDir('ti-jsresolve-rest-method-');

    it('sets payload.method to match the anchor key method on resolution', async () => {
      const root = getTmp();

      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src/cfg.js'), `export const PRODUCTS_PATH = '/wc/v3/products';\n`);
      writeFileSync(
        join(root, 'src/caller.js'),
        `import { PRODUCTS_PATH } from './cfg.js';\napiFetch({ path: PRODUCTS_PATH });\n`,
      );

      const db = freshDb();
      const opts = synthesizeCompilerOptions(root);

      const callerFacts = await extractTsFile({
        projectRoot: root, relPath: 'src/caller.js', language: 'js',
        framework: null, compilerOptions: opts, patterns: WP_JS_PATTERNS,
      });
      const callerRest = callerFacts.find((f) => f.kind === 'rest-call-js');
      expect(callerRest).toBeDefined();
      if (callerRest === undefined) return;

      const factId = seedFact(db, 'src/caller.js', callerRest);

      const summary = runJsResolve(db, { projectRoot: root });
      expect(summary.resolved).toBe(1);

      // The anchor key is rest:GET /wc/v3/products; the payload method must
      // also be GET (not whatever the original unresolved payload said).
      const anchorKeys = (
        db
          .prepare(
            `SELECT a.key FROM fact_anchor fa JOIN anchor a ON a.id = fa.anchor_id
             WHERE fa.fact_id = ? AND fa.role = 'target'`,
          )
          .all(factId) as { key: string }[]
      ).map((r) => r.key);
      expect(anchorKeys).toEqual(['rest:GET /wc/v3/products']);

      const row = db
        .prepare('SELECT resolved, payload FROM fact WHERE id = ?')
        .get(factId) as { resolved: number; payload: string };
      expect(row.resolved).toBe(1);
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      expect(payload['method']).toBe('GET');
      // The method in payload matches the method token in the anchor key.
      const anchorMethod = (anchorKeys[0] ?? '').split(':')[1]?.split(' ')[0];
      expect(payload['method']).toBe(anchorMethod);

      db.close();
    });
  });

  describe('resolves threaded REST method via TypeChecker (issue B)', () => {
    const getTmp = useTmpDir('ti-jsresolve-rest-method-thread-');

    it('lifts a cross-file method constant onto the resolved anchor', async () => {
      const root = getTmp();

      // Fixture: cfg.js exports both the path and the method as cross-file
      // constants; caller.js imports both. The path import keeps the fact
      // unresolved at per-file extraction (the extractor has no TypeChecker),
      // so runJsResolve picks it up. The method import is the case under
      // test — without the lift, the resolved anchor defaults to GET.
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'src/cfg.js'),
        `export const PRODUCTS_PATH = '/wc/v3/products';\nexport const METHOD = 'POST';\n`,
      );
      writeFileSync(
        join(root, 'src/caller.js'),
        `import { PRODUCTS_PATH, METHOD } from './cfg.js';\n` +
          `apiFetch({ path: PRODUCTS_PATH, method: METHOD });\n`,
      );

      const db = freshDb();
      const opts = synthesizeCompilerOptions(root);

      const callerFacts = await extractTsFile({
        projectRoot: root, relPath: 'src/caller.js', language: 'js',
        framework: null, compilerOptions: opts, patterns: WP_JS_PATTERNS,
      });
      const callerRest = callerFacts.find((f) => f.kind === 'rest-call-js');
      expect(callerRest).toBeDefined();
      if (callerRest === undefined) return;

      const factId = seedFact(db, 'src/caller.js', callerRest);
      const summary = runJsResolve(db, { projectRoot: root });
      expect(summary.resolved).toBe(1);

      const anchorKeys = (
        db
          .prepare(
            `SELECT a.key FROM fact_anchor fa JOIN anchor a ON a.id = fa.anchor_id
             WHERE fa.fact_id = ? AND fa.role = 'target'`,
          )
          .all(factId) as { key: string }[]
      ).map((r) => r.key);
      expect(anchorKeys).toEqual(['rest:POST /wc/v3/products']);

      const row = db
        .prepare('SELECT payload FROM fact WHERE id = ?')
        .get(factId) as { payload: string };
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      expect(payload['method']).toBe('POST');

      db.close();
    });

    it('lifts a method threaded through a function parameter', async () => {
      const root = getTmp();

      // Fixture: caller.js defines a helper whose two parameters feed apiFetch
      // — both `path` and `method` come from the parameters. The single call
      // site binds them to 'PUT' and '/wc/v3/products'. The path-through-param
      // case is already known to keep the fact unresolved at extraction, so
      // jsresolve picks it up. The method-through-param is the case under
      // test — the existing path-side resolution follows single-call-site
      // parameters via getResolvedSignature; this verifies the method side
      // does the same.
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'src/caller.js'),
        `function update(path, method) { apiFetch({ path, method }); }\n` +
          `update('/wc/v3/products', 'PUT');\n`,
      );

      const db = freshDb();
      const opts = synthesizeCompilerOptions(root);
      const callerFacts = await extractTsFile({
        projectRoot: root, relPath: 'src/caller.js', language: 'js',
        framework: null, compilerOptions: opts, patterns: WP_JS_PATTERNS,
      });
      const callerRest = callerFacts.find((f) => f.kind === 'rest-call-js');
      expect(callerRest).toBeDefined();
      if (callerRest === undefined) return;

      const factId = seedFact(db, 'src/caller.js', callerRest);
      runJsResolve(db, { projectRoot: root });

      const anchorKeys = (
        db
          .prepare(
            `SELECT a.key FROM fact_anchor fa JOIN anchor a ON a.id = fa.anchor_id
             WHERE fa.fact_id = ? AND fa.role = 'target'`,
          )
          .all(factId) as { key: string }[]
      ).map((r) => r.key);
      expect(anchorKeys).toEqual(['rest:PUT /wc/v3/products']);

      db.close();
    });
  });

  // Drift guard: restMethodForCall hand-re-encodes the REST method of each
  // rest-call-js pattern in WP_JS_PATTERNS. A future pattern it does not cover
  // turns this red.
  it('restMethodForCall covers every rest-call-js pattern in WP_JS_PATTERNS', () => {
    const restPatterns = WP_JS_PATTERNS.filter((p) => p.emit === 'rest-call-js');
    expect(restPatterns.length).toBeGreaterThan(0);

    for (const pattern of restPatterns) {
      // The method is the token between `rest:` and the first space in the
      // pattern's anchor template (`rest:<METHOD> <route-binding>`).
      const template = pattern.anchor?.template ?? '';
      const m = /^rest:(\S+)\s/.exec(template);
      expect(m, `pattern template "${template}" must start with rest:<METHOD> `).not.toBeNull();
      const expectedMethod = m?.[1] ?? '';

      // Build the callee the pattern matches: a bare identifier for a
      // function-call, or `<receiver>.<name>` for a method-call.
      const { name, receiver } = pattern.match;
      const calleeSrc = receiver !== undefined ? `${receiver}.${name}` : name;
      const sf = ts.createSourceFile(
        'p.ts', `${calleeSrc}();`, ts.ScriptTarget.Latest, true,
      );
      const stmt = sf.statements[0];
      expect(stmt !== undefined && ts.isExpressionStatement(stmt)
        && ts.isCallExpression(stmt.expression)).toBe(true);
      const call = (stmt as ts.ExpressionStatement).expression as ts.CallExpression;

      expect(
        restMethodForCall(call),
        `restMethodForCall(${calleeSrc}) should yield ${expectedMethod}`,
      ).toBe(expectedMethod);
    }
  });

  describe('restMethodForCall reads the literal method from the call args', () => {
    function makeCall(src: string): ts.CallExpression {
      const sf = ts.createSourceFile('p.ts', src, ts.ScriptTarget.Latest, true);
      const stmt = sf.statements[0];
      if (stmt === undefined || !ts.isExpressionStatement(stmt)
          || !ts.isCallExpression(stmt.expression)) {
        throw new Error(`expected a single call expression: ${src}`);
      }
      return stmt.expression;
    }

    it('reads apiFetch({ method: "POST", ... }) as POST', () => {
      expect(restMethodForCall(makeCall("apiFetch({ path: '/x', method: 'POST' });"))).toBe('POST');
    });

    it('uppercases a lowercase method string from apiFetch', () => {
      expect(restMethodForCall(makeCall("apiFetch({ path: '/x', method: 'put' });"))).toBe('PUT');
    });

    it('reads fetch(url, { method: "DELETE" }) as DELETE', () => {
      expect(restMethodForCall(makeCall("fetch('/x', { method: 'DELETE' });"))).toBe('DELETE');
    });

    it('defaults to GET when apiFetch arg has no method property', () => {
      expect(restMethodForCall(makeCall("apiFetch({ path: '/x' });"))).toBe('GET');
    });

    it('defaults to GET when fetch is called without an init object', () => {
      expect(restMethodForCall(makeCall("fetch('/x');"))).toBe('GET');
    });

    it('defaults to GET when apiFetch is called with no args', () => {
      // Mirrors the drift-guard shape.
      expect(restMethodForCall(makeCall("apiFetch();"))).toBe('GET');
    });

    it('defaults to GET when the method value is a non-literal expression', () => {
      expect(restMethodForCall(makeCall("apiFetch({ path: '/x', method: m });"))).toBe('GET');
    });

    it('defaults to GET when the apiFetch config is an identifier (not an object literal)', () => {
      // Interprocedural resolution of identifier-shape configs is out of scope
      // for restMethodForCall; the orchestrator only has AST access here.
      expect(restMethodForCall(makeCall("apiFetch(opts);"))).toBe('GET');
    });

    it('keeps axios.<method> behavior unchanged', () => {
      expect(restMethodForCall(makeCall("axios.post('/x');"))).toBe('POST');
    });
  });
});
