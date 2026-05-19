// Outcome counts for a runJsResolve pass.
export interface JsResolveSummary {
  readonly examined: number;
  readonly resolved: number;
}

// Options for runJsResolve.
export interface JsResolveOptions {
  readonly projectRoot: string;
}
