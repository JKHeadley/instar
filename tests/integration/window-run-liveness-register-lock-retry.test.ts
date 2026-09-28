/**
 * POST /window-run-liveness/register retries ONLY lock contention.
 *
 * register() takes the mutation lock synchronously (no retries) while the
 * background tick holds the same lock across awaits, so a register arriving
 * mid-tick used to answer 409 "Lock file is already being held" (seen in the
 * W32 expiry-freeze e2e under machine load, on main as well). The route now
 * yields and retries on ELOCKED only; every other error is still a 409 on the
 * first attempt. Both sides of that boundary are asserted here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface TestServer { url: string; close: () => Promise<void> }

function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

const binding = { windowId: 'w32', topicId: 36966, autonomousRunId: 'run-w32', lifecycleRunId: 'lifecycle-w32', executorId: 'echo-topic-36966' };

function lockedError(): Error {
  return Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED' });
}

describe('POST /window-run-liveness/register — lock-contention retry', () => {
  let server: TestServer | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/window-run-liveness-register-lock-retry.test.ts:cleanup' });
    dir = undefined;
  });

  async function boot(register: (input: unknown) => unknown): Promise<TestServer> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrl-register-retry-'));
    const app = express();
    app.use(express.json());
    app.use(createRoutes({ config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date(), windowRunLivenessAuthority: { register } } as never));
    return listen(app);
  }

  it('retries while the lock is held and answers 201 once it is released', async () => {
    let calls = 0;
    server = await boot(() => {
      calls++;
      if (calls <= 3) throw lockedError();
      return { status: 'preparing', ...binding };
    });
    const res = await fetch(`${server.url}/window-run-liveness/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(binding),
    });
    expect(res.status).toBe(201);
    expect(calls).toBe(4);
    expect((await res.json()).status).toBe('preparing');
  });

  it('does NOT retry a non-lock error: 409 on the first attempt', async () => {
    let calls = 0;
    server = await boot(() => {
      calls++;
      throw new Error('window-run-liveness-registration-invalid');
    });
    const res = await fetch(`${server.url}/window-run-liveness/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(binding),
    });
    expect(res.status).toBe(409);
    expect(calls).toBe(1);
    expect((await res.json()).error).toBe('window-run-liveness-registration-invalid');
  });

  it('gives up after the bounded budget and still answers 409 with the lock error', async () => {
    let calls = 0;
    server = await boot(() => { calls++; throw lockedError(); });
    const res = await fetch(`${server.url}/window-run-liveness/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(binding),
    });
    expect(res.status).toBe(409);
    expect(calls).toBe(101);
    expect((await res.json()).error).toMatch(/Lock file is already being held/);
  }, 20_000);
});
