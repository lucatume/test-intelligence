import { resolve } from 'node:path';
import type { Fact } from '../../facts/types.js';
import { parseFact } from '../../facts/parse.js';
import type { PhpWorker } from './spawn.js';

export interface ExtractPhpInput {
  readonly projectRoot: string;
  readonly relPath: string;
  readonly worker: PhpWorker;
  readonly phpUnitBaseClasses?: readonly string[];
}

export async function extractPhpFile(input: ExtractPhpInput): Promise<Fact[]> {
  const abs = resolve(input.projectRoot, input.relPath);
  const res = await input.worker.extract(abs, input.phpUnitBaseClasses, input.relPath);
  const env = res as { op?: string; file?: string; facts?: unknown[] };
  if (env.op !== 'facts' || !Array.isArray(env.facts)) return [];

  const out: Fact[] = [];
  for (const raw of env.facts) {
    rewriteAbsToRel(raw, input.projectRoot);
    const parsed = parseFact(raw);
    if (parsed.kind === 'ok') out.push(parsed.value);
  }
  return out;
}

function rewriteAbsToRel(node: unknown, root: string): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) rewriteAbsToRel(n, root);
    return;
  }
  const rec = node as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    const v = rec[k];
    if (typeof v === 'string' && v.startsWith(root + '/')) {
      rec[k] = v.slice(root.length + 1).replace(/\\/g, '/');
    } else if (v !== null && typeof v === 'object') {
      rewriteAbsToRel(v, root);
    }
  }
}
