import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { runDeclarativePatterns } from '../../../src/extract/declarative/engine.js';
import type { UserPattern } from '../../../src/extract/declarative/pattern.js';

function parse(rel: string, src: string): ts.SourceFile {
  return ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

describe('runDeclarativePatterns', () => {
  it('matches function-call by name and binds an object arg', () => {
    const sf = parse('src/a.ts', "apiFetch({ path: '/myplugin/v1/items' });");
    const pattern: UserPattern = {
      match: { lang: 'ts', nodeKind: 'function-call', name: 'apiFetch' },
      bind: { config: { arg: 0, type: 'object' } },
      emit: 'rest-call-js',
    };
    const facts = runDeclarativePatterns(sf, 'src/a.ts', [pattern]);
    expect(facts).toHaveLength(1);
    const [f] = facts;
    if (!f) throw new Error('no fact');
    expect(f.kind).toBe('rest-call-js');
  });

  it('matches method-call with receiver constraint', () => {
    const sf = parse('src/a.ts', "jQuery.post(url, data);");
    const pattern: UserPattern = {
      match: { lang: 'ts', nodeKind: 'method-call', name: 'post', receiver: 'jQuery' },
      bind: {},
      emit: 'ajax-call-js',
    };
    const facts = runDeclarativePatterns(sf, 'src/a.ts', [pattern]);
    expect(facts).toHaveLength(1);
  });

  it('does not match when receiver differs', () => {
    const sf = parse('src/a.ts', "axios.post(url);");
    const pattern: UserPattern = {
      match: { lang: 'ts', nodeKind: 'method-call', name: 'post', receiver: 'jQuery' },
      bind: {},
      emit: 'ajax-call-js',
    };
    expect(runDeclarativePatterns(sf, 'src/a.ts', [pattern])).toEqual([]);
  });

  it('marks fact resolved=false when a string binding sees a variable', () => {
    const sf = parse('src/a.ts', "apiFetch(opts);");
    const pattern: UserPattern = {
      match: { lang: 'ts', nodeKind: 'function-call', name: 'apiFetch' },
      bind: { config: { arg: 0, type: 'string' } },
      emit: 'rest-call-js',
    };
    const facts = runDeclarativePatterns(sf, 'src/a.ts', [pattern]);
    expect(facts).toHaveLength(1);
    const [f] = facts;
    if (!f) throw new Error('no fact');
    expect(f.resolved).toBe(false);
  });

  it('emits no facts when no patterns are passed', () => {
    const sf = parse('src/a.ts', "apiFetch('/x');");
    expect(runDeclarativePatterns(sf, 'src/a.ts', [])).toEqual([]);
  });

  it('reads a template literal with substitutions as a {*} skeleton', () => {
    const sf = parse('src/a.ts', "apiFetch({ path: `/wc/v3/products/${id}` });");
    const pattern: UserPattern = {
      match: { lang: 'ts', nodeKind: 'function-call', name: 'apiFetch' },
      bind: { config: { arg: 0, type: 'object' } },
      emit: 'rest-call-js',
      anchor: { template: 'rest:GET {config.path}', role: 'target' },
    };
    const facts = runDeclarativePatterns(sf, 'src/a.ts', [pattern]);
    expect(facts).toHaveLength(1);
    const [f] = facts;
    if (!f) throw new Error('no fact');
    expect((f.payload as { config?: { path?: string } }).config?.path).toBe('/wc/v3/products/{*}');
    expect(f.anchors[0]?.key).toBe('rest:GET /wc/v3/products/{*}');
    expect(f.resolved).toBe(false);
  });

  it('does not consume tagged template literals as a string skeleton', () => {
    const sf = parse('src/a.ts', "apiFetch({ path: html`/x/${id}` });");
    const pattern: UserPattern = {
      match: { lang: 'ts', nodeKind: 'function-call', name: 'apiFetch' },
      bind: { config: { arg: 0, type: 'object' } },
      emit: 'rest-call-js',
    };
    const facts = runDeclarativePatterns(sf, 'src/a.ts', [pattern]);
    expect(facts).toHaveLength(1);
    const [f] = facts;
    if (!f) throw new Error('no fact');
    expect((f.payload as { config?: { path?: string } }).config?.path).toBeUndefined();
  });

  it('resolves an object bind passed by identifier to a same-file declaration', () => {
    const sf = parse(
      'src/a.ts',
      "var data = { action: 'wc_save' }; $.ajax({ url: ajaxurl, data: data });",
    );
    const pattern: UserPattern = {
      match: { lang: 'ts', nodeKind: 'method-call', name: 'ajax', receiver: '$' },
      bind: { config: { arg: 0, type: 'object' } },
      emit: 'ajax-call-js',
      anchor: { template: 'ajax:{config.data.action}', role: 'target' },
    };
    const facts = runDeclarativePatterns(sf, 'src/a.ts', [pattern]);
    expect(facts).toHaveLength(1);
    const [f] = facts;
    if (!f) throw new Error('no fact');
    expect(f.resolved).toBe(true);
    expect(f.anchors[0]?.key).toBe('ajax:wc_save');
  });

  it('resolves a string bind passed by identifier to a same-file declaration', () => {
    const sf = parse('src/a.ts', "const path = '/myplugin/v1/x'; apiFetch({ path: path });");
    const pattern: UserPattern = {
      match: { lang: 'ts', nodeKind: 'function-call', name: 'apiFetch' },
      bind: { config: { arg: 0, type: 'object' } },
      emit: 'rest-call-js',
      anchor: { template: 'rest:GET {config.path}', role: 'target' },
    };
    const facts = runDeclarativePatterns(sf, 'src/a.ts', [pattern]);
    const [f] = facts;
    if (!f) throw new Error('no fact');
    expect(f.anchors[0]?.key).toBe('rest:GET /myplugin/v1/x');
  });

  it('does not chase identifier-to-identifier (depth-1 stop)', () => {
    const sf = parse(
      'src/a.ts',
      "var inner = { action: 'wc_y' }; var data = inner; $.ajax({ data: data });",
    );
    const pattern: UserPattern = {
      match: { lang: 'ts', nodeKind: 'method-call', name: 'ajax', receiver: '$' },
      bind: { config: { arg: 0, type: 'object' } },
      emit: 'ajax-call-js',
      anchor: { template: 'ajax:{config.data.action}', role: 'target' },
    };
    const facts = runDeclarativePatterns(sf, 'src/a.ts', [pattern]);
    const [f] = facts;
    if (!f) throw new Error('no fact');
    expect(f.resolved).toBe(false);
  });

  it('uses last-writer-wins on duplicate variable names', () => {
    const sf = parse(
      'src/a.ts',
      "var data = { action: 'first' }; var data = { action: 'second' }; $.ajax({ data: data });",
    );
    const pattern: UserPattern = {
      match: { lang: 'ts', nodeKind: 'method-call', name: 'ajax', receiver: '$' },
      bind: { config: { arg: 0, type: 'object' } },
      emit: 'ajax-call-js',
      anchor: { template: 'ajax:{config.data.action}', role: 'target' },
    };
    const facts = runDeclarativePatterns(sf, 'src/a.ts', [pattern]);
    const [f] = facts;
    if (!f) throw new Error('no fact');
    expect(f.anchors[0]?.key).toBe('ajax:second');
  });

  it('resolves an identifier used as an object property value', () => {
    const sf = parse(
      'src/a.ts',
      "var act = 'wc_prop'; $.ajax({ data: { action: act } });",
    );
    const pattern: UserPattern = {
      match: { lang: 'ts', nodeKind: 'method-call', name: 'ajax', receiver: '$' },
      bind: { config: { arg: 0, type: 'object' } },
      emit: 'ajax-call-js',
      anchor: { template: 'ajax:{config.data.action}', role: 'target' },
    };
    const facts = runDeclarativePatterns(sf, 'src/a.ts', [pattern]);
    const [f] = facts;
    if (!f) throw new Error('no fact');
    expect(f.anchors[0]?.key).toBe('ajax:wc_prop');
  });

  it('leaves a binding unresolved when an identifier has no matching declaration', () => {
    const sf = parse('src/a.ts', "$.ajax({ data: missing });");
    const pattern: UserPattern = {
      match: { lang: 'ts', nodeKind: 'method-call', name: 'ajax', receiver: '$' },
      bind: { config: { arg: 0, type: 'object' } },
      emit: 'ajax-call-js',
      anchor: { template: 'ajax:{config.data.action}', role: 'target' },
    };
    const facts = runDeclarativePatterns(sf, 'src/a.ts', [pattern]);
    const [f] = facts;
    if (!f) throw new Error('no fact');
    expect(f.resolved).toBe(false);
  });

  it('folds a + concat of string literals into a skeleton keeping literal segments', () => {
    const sf = parse('src/a.ts', "fetch('/wc/v3/products/' + id + '/variations');");
    const pattern: UserPattern = {
      match: { lang: 'ts', nodeKind: 'function-call', name: 'fetch' },
      bind: { url: { arg: 0, type: 'string' } },
      emit: 'rest-call-js',
      anchor: { template: 'rest:GET {url}', role: 'target' },
    };
    const facts = runDeclarativePatterns(sf, 'src/a.ts', [pattern]);
    const [f] = facts;
    if (!f) throw new Error('no fact');
    expect((f.payload as { url?: string }).url).toBe('/wc/v3/products/{*}/variations');
  });

  it('folds a leading dynamic concat operand to {*}', () => {
    const sf = parse('src/a.ts', "fetch(base + '?action=wc_x');");
    const pattern: UserPattern = {
      match: { lang: 'ts', nodeKind: 'function-call', name: 'fetch' },
      bind: { url: { arg: 0, type: 'string' } },
      emit: 'rest-call-js',
    };
    const facts = runDeclarativePatterns(sf, 'src/a.ts', [pattern]);
    const [f] = facts;
    if (!f) throw new Error('no fact');
    expect((f.payload as { url?: string }).url).toBe('{*}?action=wc_x');
  });
});

describe('unresolved block stamping', () => {
  const doActionPattern: UserPattern = {
    match: { lang: 'ts', nodeKind: 'function-call', name: 'doAction' },
    bind: { hook: { arg: 0, type: 'string' } },
    emit: 'hook-fire',
    anchor: { template: 'hook:{hook}', role: 'target' },
  };
  const addActionPattern: UserPattern = {
    match: { lang: 'ts', nodeKind: 'function-call', name: 'addAction' },
    bind: {
      hook: { arg: 0, type: 'string' },
      callback: { arg: 1, type: 'string', optional: true },
    },
    emit: 'hook-listener',
    anchor: { template: 'hook:{hook}', role: 'subject' },
  };

  function runForSource(src: string, patterns: readonly UserPattern[]) {
    const sf = parse('src/u.ts', src);
    return runDeclarativePatterns(sf, 'src/u.ts', patterns);
  }

  it('stamps the enclosing class::method scope on an unresolved fact', () => {
    const facts = runForSource(
      'class Widget { run(h: string) { doAction(h); } }',
      [doActionPattern],
    );
    const fire = facts.find((f) => f.kind === 'hook-fire');
    expect(fire?.resolved).toBe(false);
    const u = (fire?.payload as { unresolved?: { scope: string } }).unresolved;
    expect(u?.scope).toBe('Widget::run');
  });

  it('stamps (file) scope for a file-scope unresolved fact', () => {
    const facts = runForSource('doAction(h);', [doActionPattern]);
    const u = (
      facts.find((f) => f.kind === 'hook-fire')?.payload as {
        unresolved?: { scope: string };
      }
    ).unresolved;
    expect(u?.scope).toBe('(file)');
  });

  it('captures the unresolved expression source text', () => {
    const facts = runForSource('addAction(`woo-${x}`, cb);', [addActionPattern]);
    const u = (
      facts.find((f) => f.kind === 'hook-listener')?.payload as {
        unresolved?: { fields: { field: string; expression: string }[] };
      }
    ).unresolved;
    expect(u?.fields[0]?.field).toBe('hook');
    expect(u?.fields[0]?.expression).toBe('`woo-${x}`');
  });

  it('emits no unresolved block on a resolved fact', () => {
    const facts = runForSource("doAction('init');", [doActionPattern]);
    const payload = facts.find((f) => f.kind === 'hook-fire')?.payload as {
      unresolved?: unknown;
    };
    expect(payload.unresolved).toBeUndefined();
  });

  it('resolves the enclosing function name for a free-function scope', () => {
    const facts = runForSource('function fireIt(h) { doAction(h); }', [doActionPattern]);
    const u = (
      facts.find((f) => f.kind === 'hook-fire')?.payload as {
        unresolved?: { scope: string };
      }
    ).unresolved;
    expect(u?.scope).toBe('fireIt');
  });
});
