import type { ValidatedConfig } from '../config/parse.js';
import type { Clock } from '../clock.js';
import type Database from 'better-sqlite3';

export interface BuildTimingOptions {
  // Emit the timings breakdown line(s) after the build-complete line.
  readonly emit?: boolean;
  // When > 0, collect the N slowest extractFile() wallclocks (and emit them
  // when emit is true). 0 / omitted means no per-file tracking.
  readonly topN?: number;
}

export interface BuildOptions {
  readonly projectRoot: string;
  readonly config: ValidatedConfig;
  readonly clock: Clock;
  readonly db?: Database.Database;
  readonly stderr: { write(s: string): void };
  readonly verbosity?: 'quiet' | 'normal' | 'verbose';
  readonly timing?: BuildTimingOptions;
  // Worker location override (where vendor-php/bin/ti-php-extract.php lives).
  // Defaults to process.cwd() if omitted.
  readonly repoRoot?: string;
}

export interface SlowFile {
  readonly path: string;
  readonly language: string;
  readonly millis: number;
}

export interface BuildTimings {
  // Wallclocks measured on the main thread via the injected Clock.
  // Store-open + PHP worker spawn + pattern registration, before the walk.
  readonly setupMs: number;
  // End-to-end wallclock of the extract loop (walk + read + extract + writes).
  readonly extractPhaseMs: number;
  // Summed extractFile() wallclock across lanes — can exceed extractPhaseMs
  // when lanes run in parallel. Useful for spotting per-language hotspots.
  readonly extractTsMs: number;
  readonly extractPhpMs: number;
  readonly extractTsFiles: number;
  readonly extractPhpFiles: number;
  // derive() top-level wallclock and its sub-phases.
  readonly derivePhaseMs: number;
  readonly deriveLoadGraphMs: number;
  readonly deriveBuildIndexMs: number;
  readonly deriveTraverseMs: number;
  readonly deriveWriteMs: number;
  readonly totalMs: number;
  // Empty unless timing.topN > 0; sorted descending by millis.
  readonly slowestFiles: readonly SlowFile[];
}

export interface BuildSummary {
  readonly filesExtracted: number;
  readonly factsInserted: number;
  readonly testsFound: number;
  readonly edgesWritten: number;
  // Total evidence-kind count across all edges:
  // SELECT COUNT(*) FROM edge, json_each(edge.evidence). Rises when extraction
  // finds a new evidence path to an already-known (test, source) pair — a more
  // sensitive quality signal than the dedup-stable edge count.
  readonly evidenceCount: number;
  readonly testsBounded: number;
  readonly elapsedMillis: number;
  readonly timings: BuildTimings;
}

export interface BuildError {
  readonly kind: 'BuildError';
  readonly message: string;
}
