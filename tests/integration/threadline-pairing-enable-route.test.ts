/**
 * POST /threadline/pairing/enable — the route's wiring on a real AgentServer
 * (upgrades/side-effects/threadline-enable-without-restart.md).
 *
 * The production-path e2e (tests/e2e/threadline/pairing-enable-without-restart.test.ts) covers
 * enable → supervised restart → invite. This covers what it cannot: the route reads the
 * restart gate through the AutoUpdater, maps the asking session's id to its name so the asker
 * never holds its own restart, and defers (writing config, not the restart flag) while another
 * session is working.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { HandshakeManager } from '../../src/threadline/HandshakeManager.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { startFakeLifeline, type FakeLifeline } from '../helpers/fakeLifeline.js';
import { processStartMs } from '../../src/core/processIdentity.js';

const AUTH = 'route-auth';

describe('POST /threadline/pairing/enable (route wiring)', () => {
  let project: TempProject | null = null;
  let server: AgentServer | null = null;
  let lifeline: FakeLifeline | null = null;
  afterEach(async () => { lifeline?.stop(); lifeline = null; await server?.stop(); project?.cleanup(); server = null; project = null; });

  async function boot(blockersSeen: string[][], activeOthers: string[], extraConfig: Partial<InstarConfig> = {}) {
    project = createTempProject();
    const config = {
      projectName: 'pp', projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 5000, version: '0.9.81', developmentAgent: false,
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {}, users: [],
      threadline: { relayEnabled: false },
      ...extraConfig,
    } as InstarConfig;
    fs.writeFileSync(path.join(project.stateDir, 'config.json'), JSON.stringify(config));
    // The lifeline that brings the server back after a restart: a real process whose command line is
    // an Instar lifeline (lifelineRunning checks the lock's pid really runs one).
    lifeline = await startFakeLifeline(project.stateDir);
    const sessionManager = createMockSessionManager() as unknown as Record<string, unknown>;
    sessionManager.listRunningSessions = () => [{ id: 'sid-asker', name: 'PP topic', tmuxSession: 'pp-topic' }];
    // The update restart gate as AutoUpdater exposes it: healthy sessions, minus the excluded.
    const autoUpdater = {
      getStatus: () => ({ pendingUpdate: null }),
      getRestartBlockers: (exclude: (n: string) => boolean) => {
        const all = ['PP topic', ...activeOthers];
        blockersSeen.push(all.filter((n) => exclude(n)));
        return all.filter((n) => !exclude(n));
      },
    };
    server = new AgentServer({
      config, sessionManager: sessionManager as never, state: project.state,
      handshakeManager: new HandshakeManager(project.stateDir, 'pp'), autoUpdater: autoUpdater as never,
    } as never);
    await server.start();
    const port = (server as unknown as { server: { address(): { port: number } } }).server.address().port;
    return async (body: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}/threadline/pairing/enable`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close', Authorization: `Bearer ${AUTH}` }, body: JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
  }
  const flagExists = () => fs.existsSync(path.join(project!.stateDir, 'state', 'restart-requested.json'));

  it('the asking session (by its INSTAR_SESSION_ID) never holds its own restart', async () => {
    const seen: string[][] = [];
    const call = await boot(seen, []);
    const r = await call({ sessionId: 'sid-asker' });
    expect(r.status).toBe(202);
    expect(r.body.state).toBe('restarting');
    expect(seen[0]).toEqual(['PP topic']); // excluded by name, resolved from the id
    expect(flagExists()).toBe(true);
  });

  it('another active session defers the restart: config written, no flag, the blocker named', async () => {
    const call = await boot([], ['job-digest']);
    const r = await call({ sessionId: 'sid-asker' });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ state: 'deferred', blockingSessions: ['job-digest'], backInSeconds: 60 });
    expect(flagExists()).toBe(false);
    const disk = JSON.parse(fs.readFileSync(path.join(project!.stateDir, 'config.json'), 'utf-8'));
    expect(disk.threadline).toMatchObject({ relayEnabled: true, verifiedPairing: { enabled: true } });    // GET reports the waiting request (Bearer only).
    const port = (server as unknown as { server: { address(): { port: number } } }).server.address().port;
    const get = async (bearer: boolean) => fetch(`http://127.0.0.1:${port}/threadline/pairing/enable`, { headers: { Connection: 'close', ...(bearer ? { Authorization: `Bearer ${AUTH}` } : {}) } });
    expect((await get(false)).status).toBe(401);
    const st = await (await get(true)).json() as Record<string, unknown>;
    expect(st).toMatchObject({ ready: false, deferred: true, last: null });
  });

  it('without the session id the asker counts against itself (and the response names it)', async () => {
    const call = await boot([], []);
    const r = await call({});
    expect(r.body).toMatchObject({ state: 'deferred', blockingSessions: ['PP topic'] });
  });

  it('no running lifeline: no restart (the server would not come back), 503 with the reason', async () => {
    const call = await boot([], []);
    SafeFsExecutor.safeUnlinkSync(path.join(project!.stateDir, 'lifeline.lock'), { operation: 'tests/integration/threadline-pairing-enable-route.test.ts' });
    const r = await call({ sessionId: 'sid-asker' });
    expect(r.status).toBe(503);
    expect(r.body.state).toBe('restart-unavailable');
    expect(String(r.body.reason)).toContain('no lifeline');
    expect(flagExists()).toBe(false);
  });

  it('a lock whose pid now runs something else (the test runner) is not a lifeline: 503, no flag', async () => {
    const call = await boot([], []);
    fs.writeFileSync(path.join(project!.stateDir, 'lifeline.lock'), JSON.stringify({ pid: process.pid, procStart: processStartMs(process.pid) }));
    const r = await call({ sessionId: 'sid-asker' });
    expect(r.status).toBe(503);
    expect(r.body.state).toBe('restart-unavailable');
    expect(flagExists()).toBe(false);
  });

  it('a quiet standby machine does not restart and does not write config', async () => {
    const call = await boot([], [], { multiMachine: { telegramPolling: false } } as never);
    const r = await call({ sessionId: 'sid-asker' });
    expect(r.status).toBe(409);
    expect(r.body.state).toBe('unavailable-here');
    expect(flagExists()).toBe(false);
    const disk = JSON.parse(fs.readFileSync(path.join(project!.stateDir, 'config.json'), 'utf-8'));
    expect(disk.threadline.relayEnabled).toBe(false);
  });
});
