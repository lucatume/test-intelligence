import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import type { TiError } from '../errors.js';
import type { FrameworkName } from '../types.js';

export type InputSource =
  | { readonly kind: 'args'; readonly values: readonly string[] }
  | { readonly kind: 'stdin' };

export type OutputFormat = 'args' | 'json';

export type ParsedCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | {
      readonly kind: 'tests';
      readonly fromSources: InputSource;
      readonly framework: FrameworkName;
      readonly format: OutputFormat;
      readonly minConfidence: number | undefined;
      readonly strict: boolean;
    }
  | {
      readonly kind: 'sources';
      readonly fromTests: InputSource;
      readonly format: OutputFormat;
      readonly minConfidence: number | undefined;
      readonly strict: boolean;
    }
  | { readonly kind: 'explain'; readonly target: string }
  | { readonly kind: 'unlock'; readonly force: boolean };

export type ParseArgvInput = {
  readonly argv: readonly string[];
  readonly stdinIsTty: boolean;
};

function cliError(message: string): Result<ParsedCommand, TiError> {
  return err<TiError>({ kind: 'CliError', message });
}

export function parseArgv(input: ParseArgvInput): Result<ParsedCommand, TiError> {
  const { argv } = input;
  if (argv.length === 0) return ok({ kind: 'help' });
  const head = argv[0];
  if (head === '--help' || head === '-h') return ok({ kind: 'help' });
  if (head === '--version' || head === '-v') return ok({ kind: 'version' });
  return cliError(`unknown command '${String(head)}' — run 'ti --help' for usage`);
}
