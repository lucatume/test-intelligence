// `ti resolve` verb group: export / import / status. `ti` never calls an LLM
// — it exports a work bundle and imports an externally-produced, citation-
// bearing resolutions file. The per-query path is untouched.
import { readFileSync, writeFileSync } from 'node:fs';
import type { Io } from '../io.js';
import { systemClock } from '../../clock.js';
import { openStore } from '../../store/open.js';
import { HOOK_STOP_LIST_BUILTINS } from '../../config/parse.js';
import { buildBundle } from '../../resolve/build-bundle.js';
import { renderPrompt } from '../../resolve/render-prompt.js';
import { importResolutions, type DeriveParams } from '../../resolve/import-resolutions.js';
import { resolveStatus } from '../../resolve/status.js';
import { parseResolutionsFile } from '../../resolve/parse.js';
import type { FactKind } from '../../resolve/types.js';
import { loadEffectiveConfig } from './loadConfig.js';

const SUPPORTED_KINDS: ReadonlySet<string> = new Set(['hook-fire', 'hook-listener']);

export type ResolveCommandArgs =
  | {
      readonly sub: 'export';
      readonly projectRoot: string;
      readonly io: Io;
      readonly kinds: readonly string[];
      readonly limit: number;
      readonly force: boolean;
      readonly out: string;
    }
  | {
      readonly sub: 'import';
      readonly projectRoot: string;
      readonly io: Io;
      readonly input: string;
    }
  | {
      readonly sub: 'status';
      readonly projectRoot: string;
      readonly io: Io;
    };

export async function resolveCommand(args: ResolveCommandArgs): Promise<number> {
  switch (args.sub) {
    case 'export': return exportBundle(args);
    case 'import': return importBundle(args);
    case 'status': return statusReport(args);
  }
}

function exportBundle(args: Extract<ResolveCommandArgs, { sub: 'export' }>): number {
  for (const k of args.kinds) {
    if (!SUPPORTED_KINDS.has(k)) {
      args.io.stderr.write(
        `ti: resolve export supports only hook-fire / hook-listener, got "${k}"\n`,
      );
      return 1;
    }
  }
  const s = openStore(args.projectRoot);
  if (s.kind === 'err') {
    args.io.stderr.write(`ti: ${s.error.message}\n`);
    return 1;
  }
  try {
    const r = buildBundle(s.value.db, {
      kinds: args.kinds as readonly FactKind[],
      force: args.force,
      projectRoot: args.projectRoot,
      generatedAt: systemClock.now(),
    });
    if (r.kind === 'err') {
      args.io.stderr.write(`ti: ${r.error.message}\n`);
      return 1;
    }
    const units = r.value.units;
    if (units.length === 0) {
      args.io.stdout.write('ti: resolve export — nothing to resolve\n');
      return 0;
    }
    const batch = args.limit;
    const chunkCount = Math.ceil(units.length / batch);
    for (let i = 0; i < chunkCount; i++) {
      const chunk = units.slice(i * batch, i * batch + batch);
      const prompt = renderPrompt(chunk, {
        project: r.value.project,
        chunkIndex: i + 1,
        chunkCount,
      });
      const file = `${args.out}-${String(i + 1).padStart(3, '0')}.md`;
      try {
        writeFileSync(file, prompt);
      } catch (e) {
        args.io.stderr.write(`ti: failed to write ${file}: ${(e as Error).message}\n`);
        return 1;
      }
    }
    args.io.stdout.write(
      `ti: resolve export wrote ${String(units.length)} unit(s) in ` +
      `${String(chunkCount)} prompt file(s) to ${args.out}-NNN.md ` +
      `(batch ${String(batch)})\n`,
    );
    return 0;
  } finally {
    s.value.close();
  }
}

async function importBundle(args: Extract<ResolveCommandArgs, { sub: 'import' }>): Promise<number> {
  let raw: string;
  try {
    raw = readFileSync(args.input, 'utf8');
  } catch (e) {
    args.io.stderr.write(`ti: failed to read ${args.input}: ${(e as Error).message}\n`);
    return 2;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    args.io.stderr.write(`ti: ${args.input}: invalid JSON (${(e as Error).message})\n`);
    return 2;
  }
  const parsed = parseResolutionsFile(json);
  if (parsed.kind === 'err') {
    args.io.stderr.write(`ti: ${args.input}: ${parsed.error.message}\n`);
    return 2;
  }

  const config = await loadEffectiveConfig(args.projectRoot, args.io);
  if (config === null) return 1;
  const stopList = new Set<string>(HOOK_STOP_LIST_BUILTINS);
  for (const h of config.hooks.stopList.add) stopList.add(h);
  for (const h of config.hooks.stopList.remove) stopList.delete(h);
  const deriveParams: DeriveParams = {
    maxDepth: config.traversal.maxDepth,
    maxMillisPerTest: config.traversal.maxMillisPerTest,
    threshold: config.confidence.threshold,
    hookStopList: stopList,
    maxWildcardMatchesPerAnchor: config.traversal.maxWildcardMatchesPerAnchor,
  };

  const s = openStore(args.projectRoot);
  if (s.kind === 'err') {
    args.io.stderr.write(`ti: ${s.error.message}\n`);
    return 1;
  }
  try {
    const r = await importResolutions(s.value.db, parsed.value, {
      root: args.projectRoot, deriveParams, clock: systemClock,
    });
    if (r.kind === 'err') {
      args.io.stderr.write(`ti: ${r.error.message}\n`);
      return 2;
    }
    const sum = r.value;
    args.io.stdout.write(
      `ti: resolve import — applied ${String(sum.applied)}, ` +
      `rejected ${String(sum.rejected)}, stale ${String(sum.stale)}, ` +
      `classified-unresolvable ${String(sum.classifiedUnresolvable)}\n`,
    );
    for (const rej of sum.rejections) {
      args.io.stderr.write(`ti: warning: rejected ${rej.exprHash}: ${rej.reason}\n`);
    }
    return 0;
  } finally {
    s.value.close();
  }
}

function statusReport(args: Extract<ResolveCommandArgs, { sub: 'status' }>): number {
  const s = openStore(args.projectRoot);
  if (s.kind === 'err') {
    args.io.stderr.write(`ti: ${s.error.message}\n`);
    return 1;
  }
  try {
    const st = resolveStatus(s.value.db);
    args.io.stdout.write(
      `ti: resolve status\n` +
      `  unresolved  hook-fire=${String(st.unresolved['hook-fire'])} ` +
      `hook-listener=${String(st.unresolved['hook-listener'])}\n` +
      `  cached      ${String(st.cached)}  (pruned ${String(st.stale)} stale)\n` +
      `  classes     structural-rule=${String(st.classHistogram['structural-rule'])} ` +
      `project-constant=${String(st.classHistogram['project-constant'])} ` +
      `data-dependent-unresolvable=${String(st.classHistogram['data-dependent-unresolvable'])}\n`,
    );
    return 0;
  } finally {
    s.value.close();
  }
}
