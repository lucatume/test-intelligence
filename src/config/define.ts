import type { UserConfig, ValidatedConfig } from './parse.js';

// `defineConfig` is identity at runtime — it exists so users authoring `ti.config.ts`
// get TS autocompletion against the input shape. The full validation runs in `parseConfig`.
export function defineConfig(config: UserConfig): UserConfig {
  return config;
}

export type { UserConfig, ValidatedConfig };
