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
        // Foundation = the leaf modules every other zone may depend on.
        // Collapsed to a single zone so the DAG is enforced as a DAG, not a chain.
        { type: 'foundation', pattern: 'src/{result,parse,types,clock,paths,ids,errors}.ts' },
        { type: 'anchors',    pattern: 'src/anchors/**' },
        { type: 'store',      pattern: 'src/store/**' },
        { type: 'config',     pattern: 'src/config/**' },
        // Plan B+ zones - registered now so future code is constrained on arrival.
        { type: 'facts',      pattern: 'src/facts/**' },
        { type: 'extract',    pattern: 'src/extract/**' },
        { type: 'derive',     pattern: 'src/derive/**' },
        { type: 'query',      pattern: 'src/query/**' },
        { type: 'emit',       pattern: 'src/emit/**' },
        { type: 'discover',   pattern: 'src/discover/**' },
        { type: 'export',     pattern: 'src/export/**' },
        { type: 'cli',        pattern: 'src/cli/**' },
        { type: 'cli-entry',  pattern: 'src/cli.ts' },
        // Public barrel: may re-export from any zone exposed in the public API.
        { type: 'barrel',     pattern: 'src/index.ts' },
        { type: 'test',       pattern: 'tests/**' },
      ],
      'import/resolver': {
        typescript: { project: './tsconfig.json' },
      },
    },
    rules: {
      'import/no-cycle': ['error', { maxDepth: Infinity }],
      'import/no-duplicates': 'error',
      // DAG, not a chain: every zone has an explicit positive allow-list.
      // default: 'disallow' means anything not enumerated below is rejected.
      'boundaries/element-types': ['error', {
        default: 'disallow',
        rules: [
          { from: 'foundation', allow: ['foundation'] },
          { from: 'anchors',    allow: ['anchors', 'foundation'] },
          { from: 'store',      allow: ['store', 'foundation'] },
          { from: 'config',     allow: ['config', 'foundation'] },
          { from: 'facts',      allow: ['facts', 'anchors', 'foundation'] },
          { from: 'extract',    allow: ['extract', 'anchors', 'facts', 'foundation', 'store'] },
          { from: 'derive',     allow: ['derive', 'anchors', 'facts', 'foundation', 'store'] },
          { from: 'query',      allow: ['query', 'store', 'anchors', 'foundation'] },
          { from: 'emit',       allow: ['emit', 'foundation'] },
          { from: 'discover',   allow: ['discover', 'config', 'foundation'] },
          { from: 'export',     allow: ['export', 'store', 'foundation'] },
          { from: 'cli',        allow: ['cli', 'config', 'store', 'anchors', 'query', 'emit', 'foundation'] },
          { from: 'cli-entry',  allow: ['cli-entry', 'cli', 'foundation'] },
          // Public barrel re-exports whatever the public API surfaces.
          { from: 'barrel',     allow: ['barrel', 'config', 'foundation'] },
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
