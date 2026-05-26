import type ts from 'typescript';
import type { UserPattern } from './declarative/pattern.js';
import type { FrameworkName, Language, ProjectRelativePath } from '../types.js';
import type { PhpWorker } from './php/spawn.js';

export interface ExtractInput {
  readonly projectRoot: string;
  readonly path: ProjectRelativePath;
  readonly language: Language;
  readonly framework: FrameworkName | null;
  readonly compilerOptions: ts.CompilerOptions;
  readonly patterns: readonly UserPattern[];
  readonly phpWorker?: PhpWorker;
  readonly includeBuiltins?: boolean;
  readonly phpUnitBaseClasses?: readonly string[];
  readonly wrapperIndexComplete?: boolean;
}

export interface ExtractError {
  readonly kind: 'ExtractError';
  readonly path: string;
  readonly message: string;
}
