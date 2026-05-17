CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY NOT NULL
);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE file (
  id              INTEGER PRIMARY KEY,
  path            TEXT NOT NULL UNIQUE,
  language        TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  extracted_at    TEXT NOT NULL,
  is_test         INTEGER NOT NULL,
  framework       TEXT,
  framework_class TEXT
);
CREATE INDEX file_path_idx ON file(path);

CREATE TABLE fact (
  id          INTEGER PRIMARY KEY,
  file_id     INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  resolved    INTEGER NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  payload     TEXT NOT NULL
);
CREATE INDEX fact_file_idx ON fact(file_id);
CREATE INDEX fact_kind_idx ON fact(kind);

CREATE TABLE anchor (
  id   INTEGER PRIMARY KEY,
  key  TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL
);
CREATE INDEX anchor_type_idx ON anchor(type);

CREATE TABLE fact_anchor (
  fact_id   INTEGER NOT NULL REFERENCES fact(id) ON DELETE CASCADE,
  anchor_id INTEGER NOT NULL REFERENCES anchor(id),
  role      TEXT NOT NULL,
  PRIMARY KEY (fact_id, anchor_id, role)
);
CREATE INDEX fact_anchor_anchor_idx ON fact_anchor(anchor_id, role);

CREATE TABLE test (
  test_id          TEXT PRIMARY KEY,
  file_id          INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  framework        TEXT NOT NULL,
  framework_class  TEXT NOT NULL,
  fact_id          INTEGER NOT NULL REFERENCES fact(id) ON DELETE CASCADE
);
-- Index test(fact_id) so the fact->test ON DELETE CASCADE is index-resolved.
-- Without it, clearFactsForFile's per-fact DELETE forces a full SCAN of
-- `test` to enforce the cascade — the dominant cost of a re-build.
CREATE INDEX test_fact_idx ON test(fact_id);

-- edge intentionally has no REFERENCES — it is rebuilt by the derive phase
-- and tolerates brief dangling rows during rebuild. `provenance` is a JSON
-- array of fact_ids that contributed to this edge; it replaces the v1
-- edge_provenance table, which has been dropped.
CREATE TABLE edge (
  test_id    TEXT NOT NULL,
  source     TEXT NOT NULL,
  confidence REAL NOT NULL,
  partial    INTEGER NOT NULL,
  evidence   TEXT NOT NULL,
  derived_at TEXT NOT NULL,
  provenance TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (test_id, source)
);
CREATE INDEX edge_source_idx ON edge(source);

-- LLM-resolution pass cache. One row per (expr_hash, pass). cite_verified is
-- 1 for a stored structural/project-constant row whose citation the importer
-- re-read and confirmed; data-dependent-unresolvable rows are cache markers
-- with cite_verified = 0 and empty cite fields.
CREATE TABLE resolution (
  expr_hash      TEXT NOT NULL,
  pass           TEXT NOT NULL,
  resolved_value TEXT NOT NULL,
  classification TEXT NOT NULL,
  cite_path      TEXT NOT NULL,
  cite_line      INTEGER NOT NULL,
  cite_verified  INTEGER NOT NULL,
  imported_at    TEXT NOT NULL,
  PRIMARY KEY (expr_hash, pass)
);
CREATE INDEX resolution_class_idx ON resolution(classification);
