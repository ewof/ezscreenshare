import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const directory = dirname(require.resolve('electron/package.json'));
const electronRequire = createRequire(join(directory, 'package.json'));

function platformPath() {
  switch (process.env.npm_config_platform || process.platform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'win32':
      return 'electron.exe';
    default:
      return 'electron';
  }
}

function installed() {
  return existsSync(join(directory, 'dist', platformPath()));
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function hostArch() {
  let arch = process.env.npm_config_arch || process.arch;
  if (process.platform === 'darwin' && arch === 'x64' && process.env.npm_config_arch === undefined) {
    try {
      if (spawnSync('sysctl', ['-in', 'sysctl.proc_translated'], { encoding: 'utf8' }).stdout?.trim() === '1') {
        arch = 'arm64';
      }
    } catch {}
  }
  return arch;
}

function extractZip(zip, dest) {
  mkdirSync(dest, { recursive: true });
  if (process.platform === 'darwin') run('ditto', ['-x', '-k', zip, dest]);
  else if (process.platform === 'win32') run('tar', ['-xf', zip, '-C', dest]);
  else run('unzip', ['-oq', zip, '-d', dest]);
}

if (!installed() && !process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
  console.log('Restoring the Electron runtime…');
  // Electron's install.js uses extract-zip 2.0.1, which silently stops after the
  // first file on Node 26. Try it anyway (works on older Node), then unpack with
  // the OS unzipper if the binary still is not there.
  const install = spawnSync(process.execPath, [join(directory, 'install.js')], { stdio: 'inherit' });
  if (install.error) throw install.error;
  if (install.status !== 0) process.exit(install.status ?? 1);
}

if (!installed() && !process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
  const { downloadArtifact } = electronRequire('@electron/get');
  const { version } = electronRequire('./package.json');
  const zip = await downloadArtifact({
    version,
    artifactName: 'electron',
    force: process.env.force_no_cache === 'true',
    cacheRoot: process.env.electron_config_cache,
    checksums: (process.env.electron_use_remote_checksums || process.env.npm_config_electron_use_remote_checksums)
      ? undefined
      : electronRequire('./checksums.json'),
    platform: process.env.npm_config_platform || process.platform,
    arch: hostArch(),
  });
  const dist = join(directory, 'dist');
  rmSync(dist, { recursive: true, force: true });
  extractZip(zip, dist);
  writeFileSync(join(directory, 'path.txt'), platformPath());
}

if (!installed()) {
  throw new Error('Electron failed to install correctly, please delete node_modules/electron and try installing again');
}
