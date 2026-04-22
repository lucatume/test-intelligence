import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import boundariesPlugin from 'eslint-plugin-boundaries';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  ...tseslint.configs.strictTypeChecked,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      import: importPlugin,
      boundaries: boundariesPlugin,
    },
    settings: {
      'boundaries/elements': [
        { type: 'result',    pattern: 'src/result.ts' },
        { type: 'parse',     pattern: 'src/parse.ts' },
        { type: 'types',     pattern: 'src/types.ts' },
        { type: 'clock',     pattern: 'src/clock.ts' },
        { type: 'paths',     pattern: 'src/paths.ts' },
        { type: 'ids',       pattern: 'src/ids.ts' },
        { type: 'errors',    pattern: 'src/errors.ts' },
        { type: 'config',    pattern: 'src/config/**' },
        { type: 'storage',   pattern: 'src/storage/**' },
        { type: 'index',     pattern: 'src/index.ts' },
        { type: 'test',      pattern: 'tests/**' },
      ],
      'import/resolver': {
        typescript: { project: './tsconfig.json' },
      },
    },
    rules: {
      'import/no-cycle': ['error', { maxDepth: Infinity }],
      'import/no-duplicates': 'error',
      'boundaries/element-types': ['error', {
        default: 'allow',
        rules: [
          // Foundations may not depend on higher layers
          { from: 'result',  disallow: ['parse', 'types', 'clock', 'paths', 'ids', 'errors', 'config', 'storage'] },
          { from: 'parse',   disallow: ['types', 'clock', 'paths', 'ids', 'errors', 'config', 'storage'] },
          { from: 'types',   disallow: ['clock', 'paths', 'ids', 'errors', 'config', 'storage'] },
          { from: 'clock',   disallow: ['paths', 'ids', 'errors', 'config', 'storage'] },
          { from: 'paths',   disallow: ['ids', 'errors', 'config', 'storage'] },
          { from: 'ids',     disallow: ['errors', 'config', 'storage'] },
          { from: 'errors',  disallow: ['config', 'storage'] },
          { from: 'config',  disallow: ['storage'] },
        ],
      }],
      // Ban the ambient time/random effects (spec §Testing strategy).
      'no-restricted-globals': ['error',
        { name: 'Date', message: 'Use Clock.now() from src/clock.ts — no ambient time.' },
      ],
      'no-restricted-syntax': ['error',
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: 'Use Random from src/clock.ts — no ambient randomness.',
        },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Tests may depend on anything and may coerce brand types.
    files: ['tests/**/*.ts'],
    rules: {
      'boundaries/element-types': 'off',
    },
  },
);
