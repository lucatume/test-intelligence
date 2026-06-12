import type Database from 'better-sqlite3';

/**
 * Connection-local change tracking for the update path.
 *
 * TEMP triggers on `fact` / `fact_anchor` record the owning file_id of every
 * mutation between install and read. One concentrated mechanism catches all
 * fact writers — per-file extract rewrites, the cross-file resolver
 * passes, and the core-admin bootstrap synthesis — without threading
 * "which files did you touch" through each of them. TEMP objects never
 * appear in the persisted schema and die with the connection.
 */
export function installFactChangeTracker(db: Database.Database): void {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS ti_changed_file (file_id INTEGER PRIMARY KEY) WITHOUT ROWID;
    CREATE TEMP TRIGGER IF NOT EXISTS ti_trg_fact_ins AFTER INSERT ON fact
      BEGIN INSERT OR IGNORE INTO ti_changed_file VALUES (new.file_id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS ti_trg_fact_del AFTER DELETE ON fact
      BEGIN INSERT OR IGNORE INTO ti_changed_file VALUES (old.file_id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS ti_trg_fact_upd AFTER UPDATE ON fact
      BEGIN
        INSERT OR IGNORE INTO ti_changed_file VALUES (old.file_id);
        INSERT OR IGNORE INTO ti_changed_file VALUES (new.file_id);
      END;
    CREATE TEMP TRIGGER IF NOT EXISTS ti_trg_fa_ins AFTER INSERT ON fact_anchor
      BEGIN
        INSERT OR IGNORE INTO ti_changed_file
          SELECT file_id FROM fact WHERE id = new.fact_id;
      END;
    -- Note: when clearFactsForFile deletes fact rows, the fact_anchor CASCADE
    -- may fire after the parent fact row is already gone, so this subquery
    -- yields nothing. That is fine: the ti_trg_fact_del trigger already
    -- recorded the file_id from the fact DELETE.
    CREATE TEMP TRIGGER IF NOT EXISTS ti_trg_fa_del AFTER DELETE ON fact_anchor
      BEGIN
        INSERT OR IGNORE INTO ti_changed_file
          SELECT file_id FROM fact WHERE id = old.fact_id;
      END;
  `);
}

export function readChangedFileIds(db: Database.Database): ReadonlySet<number> {
  const rows = db.prepare('SELECT file_id FROM ti_changed_file').all() as Array<{ file_id: number }>;
  return new Set(rows.map((r) => r.file_id));
}

export function dropFactChangeTracker(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS ti_trg_fact_ins;
    DROP TRIGGER IF EXISTS ti_trg_fact_del;
    DROP TRIGGER IF EXISTS ti_trg_fact_upd;
    DROP TRIGGER IF EXISTS ti_trg_fa_ins;
    DROP TRIGGER IF EXISTS ti_trg_fa_del;
    DROP TABLE IF EXISTS ti_changed_file;
  `);
}

/**
 * Snapshot every (file_id, anchor_id) pair before extraction so the scope
 * computation can identify anchor keys a changed file GAINED. ~500k rows on
 * a large repo = low hundreds of ms — paid only on the update path, against
 * a ~19 s traverse saving.
 */
export function snapshotFactAnchors(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS ti_pre_fact_anchor;
    CREATE TEMP TABLE ti_pre_fact_anchor AS
      SELECT DISTINCT f.file_id AS file_id, fa.anchor_id AS anchor_id
      FROM fact f JOIN fact_anchor fa ON fa.fact_id = f.id;
  `);
}
