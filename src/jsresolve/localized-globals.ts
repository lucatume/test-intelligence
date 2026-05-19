import type Database from 'better-sqlite3';

export interface LocalizedGlobals {
  // Resolve <objectName>.<key> data for a JS file, scoped by the enqueue
  // handle: returns the data map only when `jsFile` is enqueued under the
  // same handle that localized `objectName`. Returns null otherwise.
  lookup(objectName: string, jsFile: string): Readonly<Record<string, string>> | null;
}

export function buildLocalizedGlobals(db: Database.Database): LocalizedGlobals {
  // Build byObject: Map<objectName, Array<{handle, data}>>
  const byObject = new Map<string, Array<{ handle: string; data: Record<string, string> }>>();

  const localizeRows = db
    .prepare(`SELECT payload FROM fact WHERE kind = 'script-localize'`)
    .all() as { payload: string }[];

  for (const row of localizeRows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (
      typeof payload !== 'object' ||
      payload === null ||
      typeof (payload as Record<string, unknown>)['objectName'] !== 'string' ||
      typeof (payload as Record<string, unknown>)['handle'] !== 'string' ||
      typeof (payload as Record<string, unknown>)['data'] !== 'object' ||
      (payload as Record<string, unknown>)['data'] === null
    ) {
      continue;
    }
    const p = payload as { handle: string; objectName: string; data: Record<string, string> };
    const entries = byObject.get(p.objectName) ?? [];
    entries.push({ handle: p.handle, data: p.data });
    byObject.set(p.objectName, entries);
  }

  // Build handleToFiles: Map<handle, Set<jsPath>>
  // Join enqueue-script facts → fact_anchor (subject: script-handle:<h>) → fact_anchor (target: js-module:<path>)
  const handleToFiles = new Map<string, Set<string>>();

  const enqueueRows = db
    .prepare(
      `SELECT f.id AS fact_id, a.key AS anchor_key, fa.role AS role
       FROM fact f
       JOIN fact_anchor fa ON fa.fact_id = f.id
       JOIN anchor a ON a.id = fa.anchor_id
       WHERE f.kind = 'enqueue-script'`,
    )
    .all() as { fact_id: number; anchor_key: string; role: string }[];

  // Group by fact_id to pair subject and target anchors
  const enqueueByFact = new Map<number, { subject: string | null; target: string | null }>();
  for (const row of enqueueRows) {
    const entry = enqueueByFact.get(row.fact_id) ?? { subject: null, target: null };
    if (row.role === 'subject' && row.anchor_key.startsWith('script-handle:')) {
      entry.subject = row.anchor_key.slice('script-handle:'.length);
    } else if (row.role === 'target' && row.anchor_key.startsWith('js-module:')) {
      entry.target = row.anchor_key.slice('js-module:'.length);
    }
    enqueueByFact.set(row.fact_id, entry);
  }

  for (const { subject, target } of enqueueByFact.values()) {
    if (subject === null || target === null) continue;
    const files = handleToFiles.get(subject) ?? new Set<string>();
    files.add(target);
    handleToFiles.set(subject, files);
  }

  return {
    lookup(objectName: string, jsFile: string): Readonly<Record<string, string>> | null {
      const entries = byObject.get(objectName);
      if (entries === undefined || entries.length === 0) return null;

      // Find the entry whose handle enqueues jsFile.
      // Fast path: when the object is localized exactly once AND ti recorded no
      // enqueue-script facts for that handle, there is no file→handle link to
      // scope against, so return the data unconditionally. When the handle DOES
      // have enqueue facts, the strict `files.has(jsFile)` check always applies.
      if (entries.length === 1 && entries[0] !== undefined) {
        const entry = entries[0];
        const files = handleToFiles.get(entry.handle);
        if (files === undefined) {
          // Handle has no enqueue records — unique-name fast path.
          return entry.data;
        }
        return files.has(jsFile) ? entry.data : null;
      }

      // Multiple entries: find the one whose handle enqueues jsFile.
      for (const entry of entries) {
        const files = handleToFiles.get(entry.handle);
        if (files !== undefined && files.has(jsFile)) {
          return entry.data;
        }
      }
      return null;
    },
  };
}
