/**
 * Bypasses brand type construction for test fixtures. Tests that need to
 * synthesize `SourcePath`, `TestFilePath`, `Confidence`, etc. without going
 * through the production parsers use this helper to force a cast. Production
 * code never uses this — it's not exported from `src/`.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function unsafeCoerce<T>(v: unknown): T {
  return v as T;
}
