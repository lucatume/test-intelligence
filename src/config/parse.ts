import * as P from '../parse.js';
import type { ParseResult, Infer } from '../parse.js';

const runnerSchema = P.object({
  bin: P.string,
  args: P.withDefault(P.array(P.string), [] as string[]),
});

const envSchema = P.optional(P.record(P.string));

const frameworkSchema = P.object({
  runner: runnerSchema,
  coverage: P.optional(P.enumOf(['pcov', 'xdebug', 'v8', 'babel', 'istanbul'] as const)),
  env: envSchema,
});

const frameworksInnerSchema = P.object(
  {
    phpunit: P.optional(frameworkSchema),
    jest: P.optional(frameworkSchema),
    playwright: P.optional(frameworkSchema),
  },
  { strict: true },
);
type FrameworksShape = P.Infer<typeof frameworksInnerSchema>;
const frameworksSchema = P.withDefault(
  frameworksInnerSchema,
  {} as FrameworksShape,
);

const viewsInnerSchema = P.object(
  {
    http: P.optional(P.object({})),
    rest: P.optional(P.object({})),
    cli: P.optional(P.object({})),
  },
  { strict: true },
);
type ViewsShape = P.Infer<typeof viewsInnerSchema>;
const viewsSchema = P.withDefault(
  viewsInnerSchema,
  {} as ViewsShape,
);

const confidenceSchema = P.withDefault(
  P.object({
    runtime: P.refine(P.number, (n) => n >= 0 && n <= 1 ? null : 'must be in [0, 1]'),
    static: P.refine(P.number, (n) => n >= 0 && n <= 1 ? null : 'must be in [0, 1]'),
    heuristic: P.refine(P.number, (n) => n >= 0 && n <= 1 ? null : 'must be in [0, 1]'),
  }),
  { runtime: 1.0, static: 0.7, heuristic: 0.3 },
);

const buildSchema = P.withDefault(
  P.object({
    testTimeoutSeconds: P.withDefault(
      P.refine(P.number, (n) => n > 0 ? null : 'must be positive'),
      60,
    ),
    parallel: P.withDefault(P.boolean, true),
    maxCoverageArtifactBytes: P.withDefault(
      P.refine(P.number, (n) => n > 0 ? null : 'must be positive'),
      500 * 1024 * 1024,
    ),
  }),
  { testTimeoutSeconds: 60, parallel: true, maxCoverageArtifactBytes: 500 * 1024 * 1024 },
);

const configSchema = P.object({
  frameworks: frameworksSchema,
  views: viewsSchema,
  confidence: confidenceSchema,
  build: buildSchema,
  ignore: P.withDefault(P.array(P.string), [] as string[]),
  allowSymlinkTargets: P.withDefault(P.array(P.string), [] as string[]),
});

export type ValidatedConfig = Infer<typeof configSchema>;

// UserConfig is the recursively-relaxed shape that users write — defaults fill in ValidatedConfig.
export type UserConfig = Partial<ValidatedConfig> & {
  frameworks?: Partial<NonNullable<ValidatedConfig['frameworks']>>;
};

export function parseConfig(raw: unknown): ParseResult<ValidatedConfig> {
  return configSchema.parse(raw);
}
