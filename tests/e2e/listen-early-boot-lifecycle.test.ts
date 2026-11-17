// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * E2E "the feature is alive": listen early during boot (2026-11-16).
 *
 * Mirrors the production order in commands/server.ts: bootReadiness().init, the
 * boot beacon opens the port, subsystems mark ready, the beacon hands the port to
 * the real AgentServer, which marks ready on listen. On the REAL port:
 *   - during boot: every route, /health included, a typed 503 with Retry-After and
 *     bootReadiness.state "starting" (what a peer sees instead of ECONNREFUSED);
 *   - after the handoff: /health bootReadiness.state "ready", earlyListen set, the
 *     boot length persisted for the next estimate, and previousRestart naming the
 *     (unattributed) restart that ended the last process;
 *   - POST /server/restart is alive (202, not 404/503) and writes an attributed flag.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { BootHealthBeacon } from '../../src/server/BootHealthBeacon.js';
import { bootReadiness, resetBootReadinessForTests, BOOT_STATE_HEADER } from '../../src/server/BootReadiness.js';
import { recordRestartRequest } from '../../src/core/restartRequestAttribution.js';

const TOKEN = 'listen-early-e2e-token';

async function freePort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

describe('listen early: boot beacon → real server handoff (alive on the production order)', () => {
  let tmpDir: string;
  let stateDir: string;
  let port: number;
  let beacon: BootHealthBeacon;
  let server: AgentServer | null = null;
  const url = (p: string) => `http://127.0.0.1:${port}${p}`;

  beforeAll(async () => {
    resetBootReadinessForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'listen-early-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'listen-early-e2e' }));
    // The previous process was ended by a hand-written flag that named nobody.
    // Consumed 3 minutes ago: inside previousRestart's 10-minute window, outside the route's
    // 2-minute restart rate limit (the last case asks for a restart).
    recordRestartRequest(stateDir, { requestedAt: '2026-11-16T19:42:12Z', plannedRestart: true, reason: 'load operatorGhLogin' }, 'foreground-watcher', new Date(Date.now() - 3 * 60_000));
    port = await freePort();

    // Production order (commands/server.ts startServer).
    bootReadiness().init(stateDir);
    bootReadiness().mark('config');
    beacon = new BootHealthBeacon(port, '127.0.0.1');
    await beacon.start();
    bootReadiness().mark('instance-lock');
  });

  afterAll(async () => {
    await beacon?.stop();
    await server?.stop();
    resetBootReadinessForTests();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/listen-early-boot-lifecycle.test.ts' });
  });

  it('during boot the port is open: /health and a peer route both get a typed 503 "starting" with Retry-After', async () => {
    const health = await fetch(url('/health'));
    // 503, never 200: a 200 means "serving" to every existing caller.
    expect(health.status).toBe(503);
    expect(health.headers.get(BOOT_STATE_HEADER)).toBe('starting');
    const hb = await health.json() as { status: string; bootReadiness: { state: string; phase: string; subsystems: Record<string, string> } };
    expect(hb.status).toBe('starting');
    expect(hb.bootReadiness.state).toBe('starting');
    expect(hb.bootReadiness.phase).toBe('instance-lock');
    expect(hb.bootReadiness.subsystems.config).toBe('ready');

    const peer = await fetch(url('/conversation-graph/message'), { method: 'POST', body: '{}' });
    expect(peer.status).toBe(503);
    expect(peer.headers.get(BOOT_STATE_HEADER)).toBe('starting');
    expect(Number(peer.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await peer.json() as { error: string }).error).toBe('starting');
  });

  it('after the handoff the real server answers on the same port with bootReadiness "ready"', async () => {
    bootReadiness().mark('sessions');
    await beacon.stop();
    const config = {
      projectName: 'listen-early-e2e', projectDir: tmpDir, stateDir, port, authToken: TOKEN,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    server = new AgentServer({
      config,
      sessionManager: { listRunningSessions: () => [], getSession: () => null, getCachedRunningSessions: () => ({ count: 0, sessions: [] }) } as never,
      state: new StateManager(stateDir),
    });
    await server.start();

    const res = await fetch(url('/health'), { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get(BOOT_STATE_HEADER)).toBeNull();
    const body = await res.json() as { bootReadiness: { state: string; earlyListen: { host: string } | null; subsystems: Record<string, string>; previousRestart: { attributed: boolean; requestedBy: string | null; reason: string } | null } };
    expect(body.bootReadiness.state).toBe('ready');
    expect(body.bootReadiness.earlyListen?.host).toBe('127.0.0.1');
    expect(body.bootReadiness.subsystems.http).toBe('ready');
    expect(body.bootReadiness.subsystems.messaging).toBe('not-started');
    expect(body.bootReadiness.previousRestart).toMatchObject({ attributed: false, requestedBy: null, reason: 'load operatorGhLogin' });

    // The boot length is kept for the next boot's Retry-After estimate.
    const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'boot-readiness.json'), 'utf8'));
    expect(persisted.v).toBe(1);
    expect(persisted.bootMs).toBeGreaterThan(0);
  });

  it('POST /server/restart is alive on the real server and writes an attributed request', async () => {
    const res = await fetch(url('/server/restart'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestedBy: 'listen-early-e2e', reason: 'prove the route is alive' }),
    });
    expect(res.status).toBe(202);
    const flag = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'restart-requested.json'), 'utf8'));
    expect(flag).toMatchObject({ requestedBy: 'listen-early-e2e', plannedRestart: true });
  });
});
