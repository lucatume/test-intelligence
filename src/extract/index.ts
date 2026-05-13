import { extractTsFile } from './ts/extract.js';
import { extractPhpFile } from './php/extract.js';
import type { ExtractInput, ExtractError } from './types.js';
import type { Fact } from '../facts/types.js';
import type { Result } from '../result.js';
import { err, ok } from '../result.js';
import { WP_JS_PATTERNS } from './declarative/wp-js-patterns.js';
import { deriveAjaxListeners } from './declarative/derive-ajax-listener.js';

export async function extractFile(input: ExtractInput): Promise<Result<Fact[], ExtractError>> {
  const includeBuiltins = input.includeBuiltins !== false;
  const patterns = includeBuiltins ? [...WP_JS_PATTERNS, ...input.patterns] : input.patterns;

  switch (input.language) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      try {
        const facts = await extractTsFile({
          projectRoot: input.projectRoot,
          relPath: input.path,
          language: input.language,
          framework: input.framework,
          compilerOptions: input.compilerOptions,
          patterns,
        });
        return ok(facts);
      } catch (e) {
        return err({
          kind: 'ExtractError',
          path: input.path,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    case 'php':
      if (!input.phpWorker) return ok([]);
      try {
        const facts = await extractPhpFile({
          projectRoot: input.projectRoot,
          relPath: input.path,
          worker: input.phpWorker,
          ...(input.phpUnitBaseClasses !== undefined ? { phpUnitBaseClasses: input.phpUnitBaseClasses } : {}),
        });
        return ok([...facts, ...deriveAjaxListeners(facts)]);
      } catch (e) {
        return err({
          kind: 'ExtractError',
          path: input.path,
          message: e instanceof Error ? e.message : String(e),
        });
      }
  }
}

export type { ExtractInput, ExtractError };
export { parsePattern } from './declarative/pattern.js';
export type { UserPattern } from './declarative/pattern.js';
export { WP_PHP_PATTERNS } from './declarative/wp-php-patterns.js';
export { WP_JS_PATTERNS } from './declarative/wp-js-patterns.js';
export { startPhpWorker, hasPhpAvailable } from './php/spawn.js';
export type { PhpWorker, SpawnError } from './php/spawn.js';
