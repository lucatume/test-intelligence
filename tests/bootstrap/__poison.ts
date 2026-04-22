// This module deliberately throws on import.
// The poison-pill smoke test verifies vitest surfaces this as a suite failure
// and not a silent warning. If vitest config ever weakens error reporting,
// this test is the canary.
throw new Error('ti_poison_pill: this module should never load successfully');

// This export is unreachable but makes TypeScript recognize this as a module.
export {};

