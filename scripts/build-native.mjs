import { mkdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'dist/native');
mkdirSync(output, { recursive: true });
let compiler, args, source, binary;
if (process.platform === 'darwin') {
  source = join(root, 'src/native/macos-audio.swift');
  binary = join(output, 'macos-audio');
  compiler = 'xcrun';
  args = ['swiftc', '-parse-as-library', '-O', source, '-o', binary];
} else if (process.platform === 'win32') {
  source = join(root, 'src/native/windows-audio.cs');
  binary = join(output, 'windows-audio.exe');
  compiler = join(process.env.SystemRoot || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  args = ['/nologo', '/optimize+', '/platform:x64', '/reference:System.Web.Extensions.dll', `/out:${binary}`, source];
} else {
  console.log('Linux audio uses PipeWire; no native helper to build.');
  process.exit(0);
}
if (existsSync(binary) && statSync(binary).mtimeMs >= Math.max(statSync(source).mtimeMs, statSync(fileURLToPath(import.meta.url)).mtimeMs)) process.exit(0);
const result = spawnSync(compiler, args, { stdio: 'inherit' });
if (result.error) throw new Error(`Could not build native audio: ${result.error.message}`);
process.exit(result.status ?? 1);
