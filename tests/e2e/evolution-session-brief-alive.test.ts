// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for the evolution fast-track
 * lane (PROP-969, Dawn cross-pollination).
 *
 * Per TESTING-INTEGRITY-SPEC: boots the REAL AgentServer — the path server.ts
 * uses — with a REAL EvolutionManager over a real stateDir, and verifies:
 *   - GET /evolution/session-brief is ALIVE on the production path (200, not
 *     404/503), i.e. the routeCtx.evolution thread is real and not null;
 *   - the route is Bearer-gated (401 without);
 *   - a slipped commitment created through the production POST route comes back
 *     in the brief with surfacing text a hook could echo verbatim;
 *   - that row PERSISTS across a restart (a fresh server over the SAME stateDir)
 *     — the forcing-function property: an unresolved deadline re-surfaces next
 *     session rather than dying with the process that noticed it;
 *   - resolving it through the production PATCH route takes it OUT of the lane,
 *     so the nag has a real exit and does not become unskippable noise.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

/**
 * The shared mock plus the `on` emitter AgentServer subscribes to. The shared
 * one is used rather than a local literal because it carries
 * getCachedRunningSessions() — without it GET /health 500s, and the hook test
 * below reads that as "no output" since the hook exits 0 on an unhealthy server.
 */
function sessionManagerForBoot() {
  return Object.assign(createMockSessionManager() as any, { on: vi.fn() });
}

function bootConfig(tmpDir: string, stateDir: string, auth: string, port = 0): InstarConfig {
  return {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port, authToken: auth,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
}

async function bootServer(tmpDir: string, stateDir: string, auth: string, port = 0): Promise<AgentServer> {
  const server = new AgentServer({
    config: bootConfig(tmpDir, stateDir, auth, port),
    sessionManager: sessionManagerForBoot(),
    state: new StateManager(stateDir),
    evolution: new EvolutionManager({ stateDir }),
  });
  await server.start();
  return server;
}

describe('Evolution session brief E2E lifecycle — feature is alive', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-session-brief';
  const auth = () => ({ Authorization: `Bearer ${AUTH}` });
  const intent = () => ({ 'X-Instar-Request': '1' });
  let slippedId: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-brief-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    server = await bootServer(tmpDir, stateDir, AUTH);
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/evolution-session-brief-alive.test.ts' });
  });

  it('GET /evolution/session-brief is ALIVE on the production path (200, not 503)', async () => {
    const res = await request(app).get('/evolution/session-brief').set(auth());

    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(Array.isArray(res.body.lines)).toBe(true);
    expect(typeof res.body.overdueCount).toBe('number');
    expect(typeof res.body.datedPendingCount).toBe('number');
  });

  it('requires Bearer auth', async () => {
    const res = await request(app).get('/evolution/session-brief');
    expect(res.status).toBe(401);
  });

  it('surfaces a commitment that slipped, created through the production POST route', async () => {
    const created = await request(app)
      .post('/evolution/actions')
      .set(auth())
      .set(intent())
      .send({
        title: 'Flip the RIG shadow gate to enforce',
        description: 'The soak window closed four days ago and nothing fired the flip.',
        priority: 'critical',
        dueBy: new Date(Date.now() - 96 * 3_600_000).toISOString(),
        source: { context: 'two of three suspension layers are observation-only' },
      });
    expect(created.status).toBe(201);
    slippedId = created.body.action?.id ?? created.body.id;
    expect(slippedId).toBeTruthy();

    const brief = await request(app).get('/evolution/session-brief').set(auth());

    expect(brief.status).toBe(200);
    expect(brief.body.overdueCount).toBe(1);
    expect(brief.body.items[0].id).toBe(slippedId);
    expect(brief.body.items[0].blocking).toBe('two of three suspension layers are observation-only');
    expect(brief.body.lines[0]).toContain('1 OVERDUE');
    expect(brief.body.lines[1]).toContain(slippedId);
  });

  it('re-surfaces the unresolved row after a restart — the forcing function outlives the process', async () => {
    const restarted = await bootServer(tmpDir, stateDir, AUTH);
    try {
      const brief = await request(restarted.getApp()).get('/evolution/session-brief').set(auth());

      expect(brief.status).toBe(200);
      expect(brief.body.overdueCount).toBe(1);
      expect(brief.body.items[0].id).toBe(slippedId);
    } finally {
      await restarted.stop();
    }
  });

  it('leaves the lane once resolved through the production PATCH route', async () => {
    const patched = await request(app)
      .patch(`/evolution/actions/${slippedId}`)
      .set(auth())
      .set(intent())
      .send({ status: 'completed', resolution: 'Flipped to enforce; decision log reviewed.' });
    expect(patched.status).toBe(200);

    const brief = await request(app).get('/evolution/session-brief').set(auth());

    expect(brief.body.overdueCount).toBe(0);
    expect(brief.body.lines).toEqual([]);
    // The resolution is now evidence in the follow-through rate rather than a
    // row that vanished without a trace.
    expect(brief.body.onTimeRate).toEqual({ met: 0, total: 1, rate: 0 });
  });
});

/**
 * Run the hook WITHOUT blocking the event loop. The server the hook curls lives
 * in this same process, so a synchronous child (execFileSync) deadlocks: the
 * hook waits on a localhost response the blocked loop can never send, and the
 * test reads as a 60s ETIMEDOUT rather than as the deadlock it is.
 */
const execFileAsync = promisify(execFile);

/**
 * The wiring half. An endpoint the hook never calls is PROP-1072 all over again
 * — a token written by fifteen skills and read by nothing — so this runs the
 * REAL installed hook script against a REAL listening server and asserts the
 * slipped commitment reaches stdout. A string assertion on the template would
 * prove the text exists; only executing it proves the forcing function fires.
 */
describe('session-start hook executes the forcing function end to end', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let port: number;
  const AUTH = 'test-e2e-hook-brief';

  async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address();
        const p = typeof addr === 'object' && addr ? addr.port : 0;
        probe.close(() => resolve(p));
      });
    });
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-brief-hook-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    port = await freePort();
    // The hook reads the port out of config.json, so it has to be the real one.
    // projectName MUST match the booted server's: /evolution/* gates the
    // X-Instar-AgentId header against it and 403s on a mismatch. /health does
    // not, so a mismatch here would let the hook past its health gate and then
    // silently print nothing — which reads as "the feature is off".
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port, projectName: 'e2e', agentName: 'E2E' }));
    server = await bootServer(tmpDir, stateDir, AUTH, port);
  }, 60_000);

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/evolution-session-brief-alive.test.ts#hook' });
  });

  it('prints the slipped commitment when the real hook runs against the real server', async () => {
    const created = await request(server.getApp())
      .post('/evolution/actions')
      .set({ Authorization: `Bearer ${AUTH}` })
      .set({ 'X-Instar-Request': '1' })
      .send({
        title: 'Close the shadow-mode soak',
        description: 'Deadline passed with no mechanism to fire the flip.',
        priority: 'critical',
        dueBy: new Date(Date.now() - 72 * 3_600_000).toISOString(),
        source: { context: 'the gate is observation-only in production' },
      });
    expect(created.status).toBe(201);
    const id = created.body.action?.id ?? created.body.id;

    const hookPath = path.join(__dirname, '../../src/templates/hooks/session-start.sh');
    const { stdout } = await execFileAsync('bash', [hookPath], {
      cwd: tmpDir,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: tmpDir,
        INSTAR_AUTH_TOKEN: AUTH,
        INSTAR_AGENT_ID: 'e2e',
        CLAUDE_USER_PROMPT: 'what should I pick up first?',
      },
      encoding: 'utf-8',
      timeout: 60_000,
    });

    // Count is not asserted here: both hook tests share one server, so it
    // depends on test order. Exact counts live in the unit and route tests,
    // where the action queue is isolated per case.
    expect(stdout).toMatch(/EVOLUTION FAST-TRACK: \d+ OVERDUE/);
    expect(stdout).toContain(id);
    expect(stdout).toContain('the gate is observation-only in production');
  }, 90_000);

  /**
   * The hook that actually RUNS on an agent is not the file above: `instar init`
   * writes `.instar/hooks/instar/session-start.sh` from
   * PostUpdateMigrator.getHookContent('session-start') — an inline string — and
   * wires THAT path as the SessionStart hook. Nothing installs
   * src/templates/hooks/session-start.sh. So the forcing function has to be in
   * the generated hook, and this proves it fires there, executed exactly as
   * `instar init` would have written it.
   */
  it('prints the slipped commitment from the INSTALLED hook instar init generates', async () => {
    const created = await request(server.getApp())
      .post('/evolution/actions')
      .set({ Authorization: `Bearer ${AUTH}` })
      .set({ 'X-Instar-Request': '1' })
      .send({
        title: 'Land the inherited-claim gate',
        description: 'Filed, diagnosed, never landed.',
        priority: 'high',
        dueBy: new Date(Date.now() - 36 * 3_600_000).toISOString(),
        source: { context: 'handoff claims are repeated unverified' },
      });
    expect(created.status).toBe(201);
    const id = created.body.action?.id ?? created.body.id;

    const migrator = new PostUpdateMigrator({
      projectDir: tmpDir,
      stateDir,
      port,
      hasTelegram: false,
      projectName: 'e2e',
    });
    const installedPath = path.join(stateDir, 'hooks', 'instar', 'session-start.sh');
    fs.mkdirSync(path.dirname(installedPath), { recursive: true });
    fs.writeFileSync(installedPath, migrator.getHookContent('session-start'), { mode: 0o755 });

    const { stdout } = await execFileAsync('bash', [installedPath], {
      cwd: tmpDir,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: tmpDir,
        INSTAR_AUTH_TOKEN: AUTH,
        CLAUDE_HOOK_MATCHER: 'startup',
      },
      encoding: 'utf-8',
      timeout: 60_000,
    });

    expect(stdout).toMatch(/EVOLUTION FAST-TRACK: \d+ OVERDUE/);
    expect(stdout).toContain(id);
    expect(stdout).toContain('handoff claims are repeated unverified');
  }, 90_000);

  it('prints no fast-track block at all once nothing is overdue', async () => {
    const open = await request(server.getApp()).get('/evolution/actions?status=pending').set({ Authorization: `Bearer ${AUTH}` });
    for (const action of open.body.actions ?? []) {
      await request(server.getApp())
        .patch(`/evolution/actions/${action.id}`)
        .set({ Authorization: `Bearer ${AUTH}` })
        .set({ 'X-Instar-Request': '1' })
        .send({ status: 'completed', resolution: 'resolved in the hook test' });
    }

    const hookPath = path.join(__dirname, '../../src/templates/hooks/session-start.sh');
    const { stdout } = await execFileAsync('bash', [hookPath], {
      cwd: tmpDir,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: tmpDir,
        INSTAR_AUTH_TOKEN: AUTH,
        INSTAR_AGENT_ID: 'e2e',
      },
      encoding: 'utf-8',
      timeout: 60_000,
    });

    expect(stdout).not.toContain('EVOLUTION FAST-TRACK');
  }, 90_000);
});
