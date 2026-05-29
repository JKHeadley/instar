/**
 * Integration — cross-session coordination routes (light, advisory signal).
 * Spec: docs/specs/cross-session-coordination.md.
 *
 * Mounts the REAL router with a REAL CrossSessionCoordinator and exercises the
 * full HTTP surface end-to-end. Reproduces the damaging incident shape: while
 * session A has announced it is building a fix, session B's durable actions
 * (config-flag flip + commitment withdraw) come back carrying a
 * `coordinationWarning` — the visible "another session is acting" signal Justin
 * approved. Nothing is ever blocked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { CrossSessionCoordinator } from '../../src/monitoring/CrossSessionCoordinator.js';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface Server { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('cross-session coordination routes', () => {
  let tmpDir: string;
  let projectDir: string;
  let server: Server | undefined;

  function buildApp(opts: { coordinator: CrossSessionCoordinator | null; withdrawOk?: boolean } ): express.Express {
    const app = express();
    app.use(express.json());
    const ctx: any = {
      crossSessionCoordinator: opts.coordinator,
      // Minimal commitmentTracker stub — the withdraw route only needs a truthy
      // withdraw(); this test exercises the COORDINATION wiring, not CommitmentTracker.
      commitmentTracker: { withdraw: () => opts.withdrawOk !== false },
      config: { authToken: 'test', stateDir: projectDir, projectDir, port: 0 },
      stateDir: projectDir,
    };
    app.use(createRoutes(ctx));
    return app;
  }

  function makeCoordinator(enabled = true): CrossSessionCoordinator {
    return new CrossSessionCoordinator({ stateDir: projectDir, enabled });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsession-routes-'));
    projectDir = tmpDir;
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    // Seed a config file so PATCH /config has something to merge into.
    fs.writeFileSync(
      path.join(projectDir, '.instar', 'config.json'),
      JSON.stringify({ monitoring: { collaborationRedrive: { enabled: true } } }, null, 2),
    );
  });

  afterEach(async () => {
    if (server) { await server.close(); server = undefined; }
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/cross-session-coordination-routes.test.ts' });
  });

  it('GET /coordination/recent returns 200 (feature alive, not 503) when wired', async () => {
    server = await listen(buildApp({ coordinator: makeCoordinator() }));
    const resp = await fetch(`${server.url}/coordination/recent`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.enabled).toBe(true);
    expect(body.count).toBe(0);
    expect(Array.isArray(body.actions)).toBe(true);
  });

  it('GET + POST 503 when no coordinator is configured', async () => {
    server = await listen(buildApp({ coordinator: null }));
    expect((await fetch(`${server.url}/coordination/recent`)).status).toBe(503);
    const post = await fetch(`${server.url}/coordination/intent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activity: 'x' }),
    });
    expect(post.status).toBe(503);
  });

  it('POST /coordination/intent records and is visible via GET /coordination/recent', async () => {
    server = await listen(buildApp({ coordinator: makeCoordinator() }));
    const post = await fetch(`${server.url}/coordination/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Instar-Session': 'session-A' },
      body: JSON.stringify({ activity: 'building PR 495 fix for the redrive flood', area: 'monitoring' }),
    });
    expect(post.status).toBe(201);
    const body = await post.json();
    expect(body.recorded).toBe(true);
    expect(body.id).toMatch(/^intent-/);
    expect(body.coordinationWarning).toBeNull(); // first action — nothing concurrent

    const recent = await (await fetch(`${server.url}/coordination/recent`)).json();
    expect(recent.count).toBe(1);
    expect(recent.actions[0].reason).toContain('building PR 495 fix');
    expect(recent.actions[0].actor).toBe('session-A');
  });

  it('rejects an empty / oversized activity (400)', async () => {
    server = await listen(buildApp({ coordinator: makeCoordinator() }));
    const empty = await fetch(`${server.url}/coordination/intent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activity: '' }),
    });
    expect(empty.status).toBe(400);
  });

  it('a SECOND session announcing intent sees the first session (coordinationWarning)', async () => {
    server = await listen(buildApp({ coordinator: makeCoordinator() }));
    await fetch(`${server.url}/coordination/intent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Instar-Session': 'session-A' },
      body: JSON.stringify({ activity: 'building PR 495 fix' }),
    });
    const bResp = await fetch(`${server.url}/coordination/intent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Instar-Session': 'session-B' },
      body: JSON.stringify({ activity: 'hitting the safety brake' }),
    });
    const b = await bResp.json();
    expect(b.coordinationWarning).toBeTruthy();
    expect(b.coordinationWarning).toMatch(/another\/unknown session/);
    expect(b.concurrent).toHaveLength(1);
    expect(b.concurrent[0].actor).toBe('session-A');
  });

  it('THE INCIDENT: a config-flag flip while another session is building surfaces a warning + writes config', async () => {
    server = await listen(buildApp({ coordinator: makeCoordinator() }));
    // Session A announces it is building the fix.
    await fetch(`${server.url}/coordination/intent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Instar-Session': 'session-A' },
      body: JSON.stringify({ activity: 'building PR 495 fix for the redrive flood' }),
    });
    // Session B flips the engine flag off (the "safety brake").
    const patch = await fetch(`${server.url}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Instar-Session': 'session-B' },
      body: JSON.stringify({ monitoring: { collaborationRedrive: { enabled: false } } }),
    });
    expect(patch.status).toBe(200);
    const body = await patch.json();
    expect(body.success).toBe(true);
    // The flip really happened (not blocked) ...
    const written = JSON.parse(fs.readFileSync(path.join(projectDir, '.instar', 'config.json'), 'utf8'));
    expect(written.monitoring.collaborationRedrive.enabled).toBe(false);
    // ... AND it carried the advisory warning about session A.
    expect(body.coordinationWarning).toBeTruthy();
    expect(body.coordinationWarning).toMatch(/config flip monitoring\.collaborationRedrive\.enabled/);
  });

  it('a commitment withdrawal while another session is active surfaces a warning (never blocks)', async () => {
    server = await listen(buildApp({ coordinator: makeCoordinator() }));
    await fetch(`${server.url}/coordination/intent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Instar-Session': 'session-A' },
      body: JSON.stringify({ activity: 'building the fix' }),
    });
    const wResp = await fetch(`${server.url}/commitments/CMT-42/withdraw`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Instar-Session': 'session-B' },
      body: JSON.stringify({ reason: 'safety brake — withdrawing stale reply commitments' }),
    });
    expect(wResp.status).toBe(200);
    const w = await wResp.json();
    expect(w.withdrawn).toBe(true); // the action still succeeded — advisory only
    expect(w.coordinationWarning).toBeTruthy();
    expect(w.coordinationWarning).toMatch(/another\/unknown session/);
  });

  it('passive (disabled) coordinator: GET still 200 but records nothing and never warns', async () => {
    server = await listen(buildApp({ coordinator: makeCoordinator(false) }));
    const intent = await fetch(`${server.url}/coordination/intent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Instar-Session': 'A' },
      body: JSON.stringify({ activity: 'thing' }),
    });
    const ib = await intent.json();
    expect(ib.recorded).toBe(false);
    const recent = await (await fetch(`${server.url}/coordination/recent`)).json();
    expect(recent.enabled).toBe(false);
    expect(recent.count).toBe(0);
  });
});
