import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { probeFrontend, waitForFrontend } from './frontend-ready.mjs';

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((done) => {
    server.closeAllConnections();
    server.close(done);
  }));
  return server.address().port;
}

test('readiness uses non-pooled HTTP and waits for a successful response', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('readiness must not use undici'); });
  let calls = 0;
  const server = createServer((_request, response) => {
    response.writeHead(++calls === 1 ? 503 : 200);
    response.end('ready');
  });
  const sockets = new Set();
  server.on('connection', (socket) => sockets.add(socket));
  const port = await listen(t, server);
  await waitForFrontend(port, () => 'test output');
  assert.equal(calls, 2, '503 is not ready; 200 is');
  assert.equal(sockets.size, 2, 'each probe has its own connection');
});

test('resets before a response settle as false without post-test async errors', async (t) => {
  const server = createServer();
  server.on('connection', (socket) => socket.resetAndDestroy());
  const port = await listen(t, server);
  // Exercise the exact reset-before-first-write window that undici mishandles.
  for (let i = 0; i < 50; i++) assert.equal(await probeFrontend(port), false);
});

test('an incomplete response settles as false', async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Length': 100 });
    response.write('short');
    response.socket.destroy();
  });
  assert.equal(await probeFrontend(await listen(t, server)), false);
});

test('a stalled response is destroyed when its probe times out', async (t) => {
  const server = createServer(() => {});
  assert.equal(await probeFrontend(await listen(t, server), 20), false);
});

test('a streaming response cannot extend the probe deadline', { timeout: 1000 }, async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200);
    const timer = setInterval(() => response.write('still loading'), 5);
    response.on('close', () => clearInterval(timer));
  });
  assert.equal(await probeFrontend(await listen(t, server), 20), false);
});
