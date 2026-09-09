import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import * as selection from '../src/shared/audio-selection.mjs';

function mainHarness(platform = 'linux') {
  const handlers = new Map();
  const inputs = [
    { id: '1', app: 'mpv', sink: 'speakers' },
    { id: '2', app: 'Spotify', sink: 'speakers' },
    { id: '3', app: 'Mumble', sink: 'speakers' },
  ];
  let timer, displayHandler;
  const context = createContext({
    ...selection, join, console,
    process: { platform, env: {} },
    app: { commandLine: { appendSwitch() {} }, whenReady: () => ({ then() {} }), on() {} },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    session: { defaultSession: { setDisplayMediaRequestHandler: handler => { displayHandler = handler; } } },
    desktopCapturer: { getSources: async () => [{ id: 'screen:0', name: 'Screen' }] },
    setTimeout: callback => { callback(); },
    setInterval: callback => { timer = callback; return { unref() {} }; },
    clearInterval: () => { timer = undefined; },
    execFile(command, args, _options, callback) {
      assert.equal(command, 'pactl');
      let output = '';
      if (args[0] === 'get-default-sink') output = 'speakers';
      if (args.join(' ') === 'list short sinks') output = '1 speakers\n2 ezs-tap';
      if (args[0] === 'load-module') output = '123';
      if (args.join(' ') === 'list sink-inputs') {
        output = inputs.map(input => `Sink Input #${input.id}\n Sink: ${input.sink}\n application.name = "${input.app}"\n media.name = "Playback"`).join('\n');
        output += '\nSink Input #900\n Sink: speakers\n application.name = "Loopback"\n media.name = "ezs-tap loopback"';
      }
      if (args[0] === 'move-sink-input') {
        const input = inputs.find(input => input.id === args[1]);
        if (input) input.sink = args[2];
      }
      callback(null, output);
    },
  });
  const source = readFileSync(new URL('../src/main/electron.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('const here = dirname(fileURLToPath(import.meta.url));', 'const here = "/tmp";');
  runInContext(source + '\nfunction pendingAudio() { return audioOperations; }', context);
  return {
    inputs,
    call: (name, ...args) => handlers.get(`ez:${name}`)(null, ...args),
    tick: async () => { timer?.(); await context.pendingAudio(); },
    capture: async () => {
      context.registerCapture();
      return new Promise(resolve => displayHandler({}, resolve));
    },
  };
}

test('multi-select routes both apps, and release restores their original outputs', async () => {
  const app = mainHarness();
  const result = await app.call('beginMonitorCapture', { mode: 'include', apps: ['mpv', 'Spotify'] });
  assert.equal(result.ok, true);
  assert.deepEqual(app.inputs.map(input => input.sink), ['ezs-tap', 'ezs-tap', 'speakers']);
  await app.call('releaseAudioTap');
  assert.ok(app.inputs.every(input => input.sink === 'speakers'));
});

test('exclusions survive new streams and changing back to a single app', async () => {
  const app = mainHarness();
  await app.call('beginMonitorCapture', { mode: 'exclude', apps: ['Mumble'] });
  app.inputs.push({ id: '4', app: 'Mumble', sink: 'speakers' }, { id: '5', app: 'mpv', sink: 'speakers' });
  await app.tick();
  assert.equal(app.inputs[3].sink, 'speakers');
  assert.equal(app.inputs[4].sink, 'ezs-tap');
  await app.call('beginMonitorCapture', { mode: 'include', apps: ['Spotify'] });
  assert.deepEqual(app.inputs.map(input => input.sink), ['speakers', 'ezs-tap', 'speakers', 'speakers', 'speakers']);
  await app.call('releaseAudioTap');
});

test('no selected apps releases routing; legacy single-app settings migrate', async () => {
  const app = mainHarness();
  await app.call('beginMonitorCapture', 'app:mpv');
  assert.equal(app.inputs[0].sink, 'ezs-tap');
  await app.call('beginMonitorCapture', { mode: 'include', apps: [] });
  assert.ok(app.inputs.every(input => input.sink === 'speakers'));
});

test('Windows grants system loopback only when audio is enabled', async () => {
  const app = mainHarness('win32');
  assert.equal((await app.capture()).audio, 'loopback');
  await app.call('setCaptureAudio', false);
  assert.equal((await app.capture()).audio, undefined);
  assert.equal((await mainHarness().capture()).audio, undefined);
});
