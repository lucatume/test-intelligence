import type { ValidatedConfig } from '../config/parse.js';
import type { Clock } from '../clock.js';

export interface BuildOptions {
  readonly projectRoot: string;
  readonly config: ValidatedConfig;
  readonly clock: Clock;
  readonly onlyPaths?: readonly string[];
  readonly stderr: { write(s: string): void };
  readonly verbosity?: 'quiet' | 'normal' | 'verbose';
  // Worker location override (where vendor-php/bin/ti-php-extract.php lives).
  // Defaults to process.cwd() if omitted.
  readonly repoRoot?: string;
}

export interface BuildSummary {
  readonly filesExtracted: number;
  readonly factsInserted: number;
  readonly testsFound: number;
  readonly edgesWritten: number;
  readonly testsBounded: number;
  readonly elapsedMillis: number;
}

export interface BuildError {
  readonly kind: 'BuildError';
  readonly message: string;
}
