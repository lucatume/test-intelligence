import type { FrameworkClass } from '../config/parse.js';
import type { FrameworkName, ProjectRelativePath } from '../types.js';

// Sealed language set. PHP is included even though Plan B's extractor doesn't
// handle it yet — discovery classifies all files, extraction dispatches by
// language and skips unsupported ones with a `parse-error` fact in later plans.
export type Language = 'php' | 'ts' | 'tsx' | 'js' | 'jsx' | 'mjs' | 'cjs';

export const ALL_LANGUAGES: readonly Language[] = ['php', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'];

export interface DiscoveredFile {
  readonly path: ProjectRelativePath;
  readonly language: Language;
  readonly vendor: boolean;
  readonly framework: FrameworkName | null;
  readonly frameworkClass: FrameworkClass | null;
}
