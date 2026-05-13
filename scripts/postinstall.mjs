import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const vendorPhp = resolve(root, 'vendor-php');

if (!existsSync(vendorPhp) || !statSync(vendorPhp).isDirectory()) {
  process.exit(0);
}

function has(bin) {
  const r = spawnSync(bin, ['--version'], { stdio: 'ignore', shell: false });
  return r.status === 0;
}

if (!has('php')) {
  process.stderr.write('ti: php not found on PATH — PHP extraction will not work until you install PHP 8.1+\n');
  process.exit(0);
}
if (!has('composer')) {
  process.stderr.write('ti: composer not found on PATH — run `composer install` in vendor-php/ to enable PHP extraction\n');
  process.exit(0);
}

const r = spawnSync('composer', ['install', '--no-progress', '--no-interaction'], {
  cwd: vendorPhp,
  stdio: 'inherit',
  shell: false,
});
process.exit(r.status ?? 0);
