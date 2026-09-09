import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveBuffer } from '../src/renderer/live-buffer.ts';

test('startup waits for a short cushion; normal playback does not seek', () => {
  const buffer = new LiveBuffer();
  assert.equal(buffer.update(100, 0.1).play, false);
  assert.equal(buffer.update(300, 0.4).play, true);
  assert.deepEqual(buffer.update(500, 0.2), { play: true, seekBehind: null });
});
test('repeated stalls grow a bounded buffer and stable playback reduces it', () => {
  const buffer = new LiveBuffer();
  for (let now = 2000; now < 20_000; now += 2000) {
    buffer.update(now, 1);
    buffer.stalled(now);
    assert.equal(buffer.update(now, 0.1).play, false);
  }
  assert.equal(buffer.target, 0.8);
  buffer.update(60_000, 1);
  assert.ok(buffer.target < 0.8);
});
test('a network backlog seeks to a bounded live offset instead of accumulating delay', () => {
  const buffer = new LiveBuffer();
  assert.equal(buffer.update(1000, 5).seekBehind, 0.35);
});
