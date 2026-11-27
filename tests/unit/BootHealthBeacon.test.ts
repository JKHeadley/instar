// BootHealthBeacon (topic 21816 post-mortem, root cause #1 — Liveness Before
// Load): a minimal /health responder that answers during the heavy boot and
// cleanly releases the port at handoff so the real server can bind it.
// Since 2026-11-16 (listen early) it answers the typed BootReadiness state.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import http from 'node:http';
import { BootHealthBeacon } from '../../src/server/BootHealthBeacon.js';
import { bootReadiness, resetBootReadinessForTests, BOOT_STATE_HEADER } from '../../src/server/BootReadiness.js';

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
beforeEach(() => { resetBootReadinessForTests(); });
afterEach(async () => {
  await beacon?.stop();
  beacon = undefined;
});

describe('BootHealthBeacon', () => {
  it('carries Instar\'s machine marker on its 503 when it knows its machine (takeover-ready-pool R1)', async () => {
    const port = await freePort();
    beacon = new BootHealthBeacon(port, '127.0.0.1', 'abc123def4567890');
    await beacon.start();
    const res = await fetch(`http://127.0.0.1:${port}/api/lease/pull`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
    expect(res.headers.get('x-instar-machine')).toBe('abc123def4567890');
  });

  it('carries no marker without a machine identity', async () => {
    const port = await freePort();
    beacon = new BootHealthBeacon(port);
    await beacon.start();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.headers.get('x-instar-machine')).toBeNull();
  });

  it('answers /health with a typed 503 "starting" (never 200: a 200 means serving)', async () => {
    const port = await freePort();
    beacon = new BootHealthBeacon(port);
    await beacon.start();
    expect(beacon.active).toBe(true);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(503);
    expect(res.headers.get(BOOT_STATE_HEADER)).toBe('starting');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = await res.json() as { status: string; bootReadiness: { state: string; retryAfterSeconds?: number; subsystems: Record<string, string> } };
    // Not "ok": a reader that waits for ok (the Slack lifeline) must keep queueing.
    expect(body.status).toBe('starting');
    expect(body.bootReadiness.state).toBe('starting');
    expect(typeof body.bootReadiness.retryAfterSeconds).toBe('number');
    expect(body.bootReadiness.subsystems.http).toBe('pending');
  });

  it('answers everything else with a typed 503 "starting, retry after N s"', async () => {
    const port = await freePort();
    beacon = new BootHealthBeacon(port);
    await beacon.start();
    const res = await fetch(`http://127.0.0.1:${port}/conversation-graph/message`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
    expect(res.headers.get(BOOT_STATE_HEADER)).toBe('starting');
    const retryAfter = Number(res.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(2);
    const body = await res.json() as { error: string; retryAfterSeconds: number; message: string; bootReadiness: { state: string } };
    expect(body.error).toBe('starting');
    expect(body.retryAfterSeconds).toBe(retryAfter);
    expect(body.message).toContain(`Retry after ${retryAfter} s`);
    expect(body.bootReadiness.state).toBe('starting');
  });

  it('binds the host it is given, so mesh peers reach it (0.0.0.0 answers on loopback too)', async () => {
    const port = await freePort();
    beacon = new BootHealthBeacon(port, '0.0.0.0');
    await beacon.start();
    const r = await get(port, '/health');
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body).bootReadiness.state).toBe('starting');
    expect(bootReadiness().snapshot().earlyListen?.host).toBe('0.0.0.0');
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
