export const EXIT_SUCCESS = 0 as const;
export const EXIT_INVOCATION_ERROR = 1 as const;
export const EXIT_STRICT_UNKNOWN = 2 as const;

export type TiError =
  | { readonly kind: 'CliError';              readonly message: string }
  | { readonly kind: 'ConfigError';           readonly message: string; readonly path?: string }
  | { readonly kind: 'SchemaOutOfRangeError'; readonly message: string; readonly onDisk: number; readonly supported: { min: number; max: number } }
  | { readonly kind: 'StorageWriteError';     readonly message: string; readonly path?: string }
  | { readonly kind: 'MapNotFoundError';      readonly message: string }
  | { readonly kind: 'ShardCorruptError';     readonly message: string; readonly shardPath: string }
  | { readonly kind: 'UnknownInputError';     readonly message: string; readonly inputs: readonly string[] }
  | { readonly kind: 'AdapterError';          readonly message: string; readonly framework: string }
  | { readonly kind: 'CoverageParseError';    readonly message: string; readonly framework: string }
  | { readonly kind: 'LockHeldError';         readonly message: string; readonly holderPid: number; readonly command: string; readonly startedAt: string }
  | { readonly kind: 'LockHostMismatchError'; readonly message: string; readonly holderHostname: string; readonly localHostname: string };

export type ExitContext = {
  readonly strict: boolean;
  readonly anyAdapterSucceeded?: boolean;
};

export function exitCodeFor(err: TiError, ctx: ExitContext): 0 | 1 | 2 {
  switch (err.kind) {
    case 'CliError':
    case 'ConfigError':
    case 'SchemaOutOfRangeError':
    case 'StorageWriteError':
    case 'MapNotFoundError':
    case 'LockHeldError':
    case 'LockHostMismatchError':
      return EXIT_INVOCATION_ERROR;
    case 'ShardCorruptError':
      return ctx.strict ? EXIT_INVOCATION_ERROR : EXIT_SUCCESS;
    case 'UnknownInputError':
      return ctx.strict ? EXIT_STRICT_UNKNOWN : EXIT_SUCCESS;
    case 'AdapterError':
    case 'CoverageParseError':
      return ctx.anyAdapterSucceeded === false ? EXIT_INVOCATION_ERROR : EXIT_SUCCESS;
  }
}

export type Severity = 'error' | 'warning' | 'info';

export function stderrLine(err: TiError, severity: Severity): string {
  return `ti: ${severity}: ${err.message}`;
}
