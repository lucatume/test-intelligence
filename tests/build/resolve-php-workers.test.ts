import { describe, it, expect } from 'vitest';
import { resolvePhpWorkers } from '../../src/build/run.js';

describe('resolvePhpWorkers', () => {
  it('defaults to cpus-2 clamped to [1,8]', () => {
    expect(resolvePhpWorkers({ configured: undefined, cpuCount: 16 })).toBe(8);
    expect(resolvePhpWorkers({ configured: undefined, cpuCount: 6 })).toBe(4);
    expect(resolvePhpWorkers({ configured: undefined, cpuCount: 2 })).toBe(1);
    expect(resolvePhpWorkers({ configured: undefined, cpuCount: 1 })).toBe(1);
  });

  it('honors the configured value, clamped to >= 1', () => {
    expect(resolvePhpWorkers({ configured: 3, cpuCount: 16 })).toBe(3);
    expect(resolvePhpWorkers({ configured: 0, cpuCount: 16 })).toBe(1);
    expect(resolvePhpWorkers({ configured: 1.9, cpuCount: 16 })).toBe(1);
  });

  it('scales down by php file count when a count is given', () => {
    expect(resolvePhpWorkers({ configured: undefined, cpuCount: 16, phpFileCount: 0 })).toBe(1);
    expect(resolvePhpWorkers({ configured: undefined, cpuCount: 16, phpFileCount: 32 })).toBe(1);
    expect(resolvePhpWorkers({ configured: undefined, cpuCount: 16, phpFileCount: 33 })).toBe(2);
    expect(resolvePhpWorkers({ configured: undefined, cpuCount: 16, phpFileCount: 10 })).toBe(1);
    expect(resolvePhpWorkers({ configured: undefined, cpuCount: 16, phpFileCount: 100 })).toBe(4);
    expect(resolvePhpWorkers({ configured: undefined, cpuCount: 16, phpFileCount: 10000 })).toBe(8);
    expect(resolvePhpWorkers({ configured: 8, cpuCount: 16, phpFileCount: 3 })).toBe(1);
  });

  it('does not scale down on a full build (no count)', () => {
    expect(resolvePhpWorkers({ configured: undefined, cpuCount: 16, phpFileCount: undefined })).toBe(8);
  });
});
