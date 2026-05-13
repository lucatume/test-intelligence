import { matchesAny } from './glob.js';
import type { ValidatedConfig, FrameworkClass } from '../config/parse.js';
import type { FrameworkName, Language } from '../types.js';

const EXT_LANG: Record<string, Language> = {
  '.php': 'php',
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
  '.mjs': 'mjs',
  '.cjs': 'cjs',
};

// Default PHPUnit path heuristic for Plan B (content check arrives in Plan C).
const PHPUNIT_PATH_RE = /(?:^|\/)tests\/|Test\.php$/i;

export interface FileClassification {
  readonly language: Language;
  readonly framework: FrameworkName | null;
  readonly frameworkClass: FrameworkClass | null;
}

export function classifyFile(
  relPath: string,
  config: ValidatedConfig,
): FileClassification | null {
  const dot = relPath.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = relPath.slice(dot);
  const language = EXT_LANG[ext];
  if (language === undefined) return null;

  const framework = detectFramework(relPath, language, config);
  if (framework === null) {
    return { language, framework: null, frameworkClass: null };
  }

  const baseClass: FrameworkClass = framework === 'playwright' ? 'e2e' : 'unit';
  const overridden = overrideClass(relPath, config) ?? baseClass;
  return { language, framework, frameworkClass: overridden };
}

function detectFramework(
  relPath: string,
  language: Language,
  config: ValidatedConfig,
): FrameworkName | null {
  const pwGlobs = config.tests.playwright.fileGlobs ?? [];
  if (pwGlobs.length > 0 && matchesAny(relPath, pwGlobs)) return 'playwright';

  if (language === 'php') {
    return PHPUNIT_PATH_RE.test(relPath) ? 'phpunit' : null;
  }

  const jestGlobs = config.tests.jest.fileGlobs;
  if (matchesAny(relPath, jestGlobs)) return 'jest';
  return null;
}

function overrideClass(relPath: string, config: ValidatedConfig): FrameworkClass | null {
  for (const rule of config.tests.classes) {
    if (rule.paths && rule.paths.length > 0 && matchesAny(relPath, rule.paths)) {
      return rule.class;
    }
  }
  return null;
}
