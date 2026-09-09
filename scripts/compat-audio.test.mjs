import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const processors = {};
runInNewContext(readFileSync(new URL('../src/renderer/compat-audio.worklet.js', import.meta.url), 'utf8'), {
  AudioWorkletProcessor: class { port = { postMessage() {} }; },
  registerProcessor: (name, ctor) => { processors[name] = ctor; },
  sampleRate: 48000, Int16Array, Float32Array,
});
const render = (player, frames = 128) => {
  const output = new Float32Array(frames);
  player.process([], [[output]]);
  return output;
};
const send = (player, value, frames = 960, rate = 48000) =>
  player.port.onmessage({ data: { samples: new Int16Array(frames).fill(value), rate } });

test('audio drains once, then stays silent; resumes after a stall', () => {
  const player = new processors['compat-playback']();
  send(player, 16384); send(player, 16384);
  assert.ok(render(player, 1920).every(x => x === 0.5));
  for (let i = 0; i < 100; i++) assert.ok(render(player).every(x => x === 0));
  send(player, -16384); send(player, -16384);
  assert.ok(render(player, 1920).every(x => x === -0.5));
});
test('network bursts discard old audio and keep at most 200ms', () => {
  const player = new processors['compat-playback']();
  for (let i = 0; i < 100; i++) send(player, i * 100);
  assert.ok(player.seconds <= 0.200001);
  assert.ok(render(player)[0] >= 8900 / 32768);
});
test('resamples 24kHz input to the device clock and resets on RTC switch', () => {
  const player = new processors['compat-playback']();
  send(player, 16384, 960, 24000);
  assert.ok(render(player, 1920).every(x => x === 0.5));
  assert.ok(render(player).every(x => x === 0));
  send(player, 16384, 960, 24000);
  player.port.onmessage({ data: { reset: true } });
  assert.ok(render(player).every(x => x === 0));
});
test('capture sends silence after a source pauses, without reusing its last audio', () => {
  const capture = new processors['compat-capture']();
  const packets = [];
  capture.port.postMessage = data => packets.push(data);
  capture.process([[new Float32Array(960).fill(0.5)]]);
  for (let i = 0; i < 15; i++) capture.process([[]]);
  assert.equal(packets.length, 3);
  assert.ok(packets[0].every(x => x === 0.5));
  assert.ok(packets[1].every(x => x === 0));
  assert.ok(packets[2].every(x => x === 0));
});
