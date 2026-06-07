// BootHealthBeacon (topic 21816 post-mortem, root cause #1 — Liveness Before
// Load): a minimal /health responder that answers during the heavy boot and
// cleanly releases the port at handoff so the real server can bind it.
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { BootHealthBeacon } from '../../src/server/BootHealthBeacon.js';

// Grab a free ephemeral port, then release it for the test to reuse.
async function freePort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

async function get(port: number, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.text() };
}

let beacon: BootHealthBeacon | undefined;
afterEach(async () => {
  await beacon?.stop();
  beacon = undefined;
});

describe('BootHealthBeacon', () => {
  it('answers /health with 200 ok while booting', async () => {
    const port = await freePort();
    beacon = new BootHealthBeacon(port);
    await beacon.start();
    expect(beacon.active).toBe(true);
    const r = await get(port, '/health');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ status: 'ok', phase: 'booting' });
  });

  it('answers everything else with 503 warming', async () => {
    const port = await freePort();
    beacon = new BootHealthBeacon(port);
    await beacon.start();
    const r = await get(port, '/sessions');
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body)).toMatchObject({ status: 'warming' });
  });

  it('stop() releases the port so the real server can bind it (the handoff)', async () => {
    const port = await freePort();
    beacon = new BootHealthBeacon(port);
    await beacon.start();
    await beacon.stop();
    expect(beacon.active).toBe(false);
    // The real server must be able to listen on the same port immediately.
    const real = http.createServer();
    await expect(
      new Promise<void>((resolve, reject) => {
        real.once('error', reject);
        real.listen(port, '127.0.0.1', () => resolve());
      }),
    ).resolves.toBeUndefined();
    await new Promise<void>((resolve) => real.close(() => resolve()));
  });

  it('start() and stop() are idempotent', async () => {
    const port = await freePort();
    beacon = new BootHealthBeacon(port);
    await beacon.start();
    await beacon.start(); // no throw, still single listener
    await beacon.stop();
    await beacon.stop(); // no throw when already stopped
    expect(beacon.active).toBe(false);
  });
});
