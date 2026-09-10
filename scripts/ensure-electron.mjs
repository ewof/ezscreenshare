import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const directory = dirname(require.resolve('electron/package.json'));
let installed = false;
try { installed = existsSync(require('electron')); } catch {}
if (!installed) {
  console.log('Restoring the Electron runtime…');
  const result = spawnSync(process.execPath, [join(directory, 'install.js')], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
