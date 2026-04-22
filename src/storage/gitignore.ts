import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const SENTINEL = '# --- ti-managed above; user entries below ---';
const MANAGED_HEADER = [
  '# Managed by ti — do not edit these entries.',
  '# You can add your own entries below the sentinel line.',
].join('\n');
const MANAGED_ENTRIES = ['.lock', '.tmp/'];

function composeManagedSection(): string {
  return [
    MANAGED_HEADER,
    ...MANAGED_ENTRIES,
    SENTINEL,
    '',
  ].join('\n');
}

export async function ensureGitignore(tiDir: string): Promise<void> {
  const giPath = path.join(tiDir, '.gitignore');
  const managed = composeManagedSection();
  let existing: string;
  try {
    existing = await fs.readFile(giPath, 'utf8');
  } catch {
    await fs.writeFile(giPath, managed);
    return;
  }
  const sentinelIdx = existing.indexOf(SENTINEL);
  if (sentinelIdx === -1) {
    const combined = managed + existing;
    await fs.writeFile(giPath, combined);
    return;
  }
  const userPortion = existing.slice(sentinelIdx + SENTINEL.length).replace(/^\n/, '');
  const combined = managed + userPortion;
  await fs.writeFile(giPath, combined);
}
