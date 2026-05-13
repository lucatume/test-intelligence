import type { FrameworkClass } from '../config/parse.js';
import type { FrameworkName, Language, ProjectRelativePath } from '../types.js';

// Re-exported from foundation for ergonomic in-zone use.
export type { Language } from '../types.js';
export { ALL_LANGUAGES } from '../types.js';

export interface DiscoveredFile {
  readonly path: ProjectRelativePath;
  readonly language: Language;
  readonly vendor: boolean;
  readonly framework: FrameworkName | null;
  readonly frameworkClass: FrameworkClass | null;
}
