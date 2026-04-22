# src/config/ — config resolution, loading, parsing

Three-stage pipeline: **resolve** → **load** → **parse**. Each stage has its own file and its own error surface; do not collapse them.

## Stages

- `resolve.ts` — `resolveProjectRoot(startDir)` walks up from the CWD looking for `ti.config.{ts,mts,mjs,js,cjs}` (preference order matters — a user with both `.ts` and `.js` gets `.ts`). Returns `{ projectRoot, configFile }` or a `ConfigError`.
- `load.ts` — `loadConfigFile(absolutePath)` via `jiti` (handles all five extensions, including TS). Validates that the default export is an object with only the allowed top-level keys.
- `parse.ts` — schemas (built from `src/parse.ts` combinators) that turn the loaded object into a typed config. **Object schemas are strict** — unknown keys are rejected. `frameworks` and `views` are also strict.
- `define.ts` — `defineConfig(config)` identity helper giving users IDE completion on their config.

## User vs Validated

- `UserConfig` — what users author. Optional fields, sensible partials.
- `ValidatedConfig` — what `parseConfig` returns after filling defaults.

**Interior code handles only `ValidatedConfig`.** If you find yourself reading a field from `UserConfig` outside the parser, you're on the wrong side of the boundary.

## v1 scope

`views` is v1.1-reserved: the config schema accepts it (so users can start authoring), but no view provider ships in v1. Do not write code that executes view entries yet.

## Modify me when…

- A new top-level config key is added (update `CONFIG_KEYS` allowlist in `load.ts` and the `parse.ts` schema).
- The resolve order or supported config extensions change.
- The `UserConfig` / `ValidatedConfig` split changes shape (not just new fields).

Do **not** modify me for: new default values, new enum members of an existing field, or purely internal refactors.
