import { describe, it, expect } from 'vitest';
import { classifyFile } from '../../src/discover/framework.js';
import { parseConfig } from '../../src/config/parse.js';

const cfg = (() => {
  const r = parseConfig({});
  if (r.kind === 'err') throw new Error('default config must parse');
  return r.value;
})();

describe('classifyFile', () => {
  it('identifies .ts as ts', () => {
    expect(classifyFile('src/a.ts', cfg)?.language).toBe('ts');
  });
  it('identifies .tsx, .jsx, .mjs, .cjs, .php', () => {
    expect(classifyFile('a.tsx', cfg)?.language).toBe('tsx');
    expect(classifyFile('a.jsx', cfg)?.language).toBe('jsx');
    expect(classifyFile('a.mjs', cfg)?.language).toBe('mjs');
    expect(classifyFile('a.cjs', cfg)?.language).toBe('cjs');
    expect(classifyFile('a.php', cfg)?.language).toBe('php');
  });
  it('returns null for unsupported extensions', () => {
    expect(classifyFile('readme.md', cfg)).toBeNull();
    expect(classifyFile('src/a.css', cfg)).toBeNull();
  });

  it('classifies a Jest test by default glob', () => {
    const c = classifyFile('tests/cart.test.ts', cfg);
    expect(c?.framework).toBe('jest');
    expect(c?.frameworkClass).toBe('unit');
  });
  it('classifies a spec file as Jest by default', () => {
    expect(classifyFile('src/a.spec.tsx', cfg)?.framework).toBe('jest');
  });
  it('non-test .ts gets framework=null', () => {
    expect(classifyFile('src/cart.ts', cfg)?.framework).toBeNull();
  });
  it('honors a playwright glob', () => {
    const cfgPw = parseConfig({
      tests: { playwright: { fileGlobs: ['e2e/**/*.spec.ts'] } },
    });
    if (cfgPw.kind === 'err') throw new Error('config must parse');
    const c = classifyFile('e2e/login.spec.ts', cfgPw.value);
    expect(c?.framework).toBe('playwright');
    expect(c?.frameworkClass).toBe('e2e');
  });
  it('PHPUnit by path heuristic', () => {
    const c = classifyFile('tests/CartTest.php', cfg);
    expect(c?.framework).toBe('phpunit');
    expect(c?.frameworkClass).toBe('unit');
  });
  it('overrides framework class via tests.classes rule', () => {
    const cfgOverride = parseConfig({
      tests: {
        classes: [{ paths: ['e2e/**'], class: 'e2e' }],
      },
    });
    if (cfgOverride.kind === 'err') throw new Error('config must parse');
    const c = classifyFile('e2e/login.test.ts', cfgOverride.value);
    expect(c?.framework).toBe('jest');
    expect(c?.frameworkClass).toBe('e2e');
  });
});
