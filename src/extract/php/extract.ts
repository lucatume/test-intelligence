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

export interface FlushDeferredInput {
  readonly projectRoot: string;
  readonly worker: PhpWorker;
}

export interface WrapperIndexEntry {
  readonly wrapperName: string;
  readonly wraps: string;
  readonly defFile: string;
  readonly defStartLine: number;
  readonly defEndLine: number;
  readonly argSpecsJson: string;
  readonly source: 'auto' | 'config';
}

export interface FlushDeferredResult {
  readonly facts: Fact[];
  readonly wrapperIndex: WrapperIndexEntry[];
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

export async function flushDeferredPhpFacts(input: FlushDeferredInput): Promise<FlushDeferredResult> {
  const res = await input.worker.flushDeferred();
  const env = res as { op?: string; facts?: unknown[]; wrapperIndex?: unknown[] };
  if (env.op !== 'facts' || !Array.isArray(env.facts)) {
    return { facts: [], wrapperIndex: [] };
  }

  const facts: Fact[] = [];
  for (const raw of env.facts) {
    rewriteAbsToRel(raw, input.projectRoot);
    const parsed = parseFact(raw);
    if (parsed.kind === 'ok') facts.push(parsed.value);
  }

  const wrapperIndex: WrapperIndexEntry[] = [];
  if (Array.isArray(env.wrapperIndex)) {
    for (const raw of env.wrapperIndex) {
      const entry = parseWrapperIndexEntry(raw, input.projectRoot);
      if (entry !== null) wrapperIndex.push(entry);
    }
  }

  return { facts, wrapperIndex };
}

function parseWrapperIndexEntry(raw: unknown, projectRoot: string): WrapperIndexEntry | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['wrapperName'] !== 'string') return null;
  if (typeof r['wraps'] !== 'string') return null;
  if (typeof r['defFile'] !== 'string') return null;
  if (typeof r['defStartLine'] !== 'number') return null;
  if (typeof r['defEndLine'] !== 'number') return null;
  if (typeof r['argSpecsJson'] !== 'string') return null;
  const source = r['source'];
  if (source !== 'auto' && source !== 'config') return null;

  // defFile comes as absolute from PHP worker; convert to project-relative.
  let defFile = r['defFile'];
  const prefix = projectRoot + '/';
  if (defFile.startsWith(prefix)) {
    defFile = defFile.slice(prefix.length);
  }

  return {
    wrapperName: r['wrapperName'],
    wraps: r['wraps'],
    defFile,
    defStartLine: r['defStartLine'],
    defEndLine: r['defEndLine'],
    argSpecsJson: r['argSpecsJson'],
    source,
  };
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
