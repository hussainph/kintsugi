import { get } from 'node:http';

// Node 24's bundled undici can throw setTypeOfService EINVAL outside fetch's
// promise when macOS resets a socket during startup/shutdown (undici#6075).
// Readiness probes need neither undici nor a pool that outlives a scratch app.
export function probeFrontend(port, timeout = 1000) {
  return new Promise((done) => {
    let timer;
    const finish = (ready) => { clearTimeout(timer); done(ready); };
    const request = get({ host: '127.0.0.1', port, path: '/', agent: false }, (response) => {
      response.on('error', () => finish(false));
      response.on('aborted', () => finish(false));
      response.on('end', () => finish(response.statusCode >= 200 && response.statusCode < 300));
      response.resume();
    });
    request.on('error', () => finish(false));
    // Absolute deadline, not a socket-idle timeout: a streaming response must
    // not keep a readiness probe alive after the startup budget expires.
    timer = setTimeout(() => { request.destroy(); finish(false); }, timeout);
  });
}

export async function waitForFrontend(port, output) {
  // The existing readiness budget is 600 x 100 ms. Keep it bounded even when
  // a server accepts connections but never finishes its response.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await probeFrontend(port, Math.max(1, Math.min(1000, deadline - Date.now())))) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`frontend never started:\n${output().slice(-4000)}`);
}
