import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

// Exercise the real HTTP and ingest routes with an isolated server and fake LiveKit API.
test('public previews require host consent, no password, and a connected host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ezs-previews-'));
  const fake = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{}'); });
  fake.listen(0, '127.0.0.1');
  await once(fake, 'listening');
  const portProbe = createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  let child;
  const sockets = [];
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await cp(resolve('src/server'), join(root, 'src/server'), { recursive: true });
    await symlink(resolve('node_modules'), join(root, 'node_modules'));
    await mkdir(join(root, 'dist'), { recursive: true });
    await symlink(resolve('dist/web'), join(root, 'dist/web'));
    child = spawn(process.execPath, ['--experimental-strip-types', join(root, 'src/server/index.ts')], {
      env: { ...process.env, NODE_ENV: 'test', API_PORT: String(port), HOST_PASSWORD: 'test-host',
        LIVEKIT_API_SECRET: 'test-secret-012345678901234567890123456789',
        LIVEKIT_HTTP_URL: `http://127.0.0.1:${fake.address().port}`, PUBLIC_URL: `http://127.0.0.1:${port}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const base = `http://127.0.0.1:${port}`;
    for (let n = 0; ; n++) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
      if (n > 100) throw new Error('server did not start');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    async function room(options) {
      const response = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostPassword: 'test-host', ...options }) });
      assert.equal(response.status, 200);
      const created = await response.json();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/ingest/${created.roomId}`, ['ezs', created.ingestToken]);
      sockets.push(ws);
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
      return { ...created, ws, url: `${base}/api/rooms/${created.roomId}/preview` };
    }
    const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==', 'base64');
    const upload = (r, token = r.ingestToken) => fetch(r.url, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg' }, body: jpeg });
    const toggle = (r, enabled) => fetch(r.url, { method: 'POST',
      headers: { authorization: `Bearer ${r.ingestToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) });
    const page = async r => (await fetch(`${base}/r/${r.roomId}`)).text();
    const publicRoom = await room({ previews: true });
    assert.equal((await fetch(publicRoom.url)).status, 404);
    assert.equal((await upload(publicRoom, 'wrong')).status, 403);
    assert.equal((await upload(publicRoom)).status, 200);
    assert.match(await page(publicRoom), /property="og:image"/);
    assert.match(await page(publicRoom), /preview\?v=\d+/);
    const image = await fetch(publicRoom.url);
    assert.equal(image.headers.get('content-type'), 'image/jpeg');
    assert.equal(image.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
    assert.equal((await fetch(publicRoom.url, { method: 'HEAD' })).status, 200);
    await toggle(publicRoom, false);
    assert.equal((await fetch(publicRoom.url)).status, 404);
    assert.doesNotMatch(await page(publicRoom), /property="og:image"/);
    assert.equal((await upload(publicRoom)).status, 403);
    await toggle(publicRoom, true);
    assert.equal((await upload(publicRoom)).status, 200);
    publicRoom.ws.close();
    await new Promise(resolve => publicRoom.ws.addEventListener('close', resolve));
    assert.equal((await fetch(publicRoom.url)).status, 404);
    assert.doesNotMatch(await page(publicRoom), /property="og:image"/);
    for (const options of [{ previews: false }, { previews: true, password: 'private' }]) {
      const r = await room(options);
      assert.equal((await upload(r)).status, 403);
      assert.doesNotMatch(await page(r), /property="og:image"/);
      if (options.password) {
        assert.equal((await (await toggle(r, true)).json()).enabled, false);
        assert.equal((await upload(r)).status, 403);
      }
    }
    assert.equal((await fetch(`${base}/api/rooms/missing/preview`)).status, 404);
  } finally {
    for (const ws of sockets) ws.close();
    if (child) { child.kill(); await once(child, 'exit'); }
    await new Promise(resolve => fake.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
