import { describe, expect, it, vi } from 'vitest';
import { MacDesktopHost } from '../../src/core/MacDesktopHost.js';
import request from 'supertest';
import { isolateNativeObservation } from '../fixtures/native-observation/isolation.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { PROVEN_MACOS_VERSIONS } from '../../src/core/DesktopProvenVersions.js';

async function boot(remoteEnabled: boolean, fixtureDir?: string) {
  const dir = fixtureDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-locked-boot-'));
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'desktop-locked', port: 0 }));
  const machineId = (await new MachineIdentityManager(stateDir).generateIdentity({ name: 'Echo Mac' })).machineId;
  const config = {
    projectName: 'desktop-locked', projectDir: dir, stateDir, port: 0,
    authToken: 'desktop-locked-e2e', dashboardPin: '123456', developmentAgent: true,
    remoteDesktop: { enabled: remoteEnabled, frontMachineId: machineId, ...(fixtureDir ? { retainedHelper: false } : {}) },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
  const server = new AgentServer({ config, state: new StateManager(stateDir), telegram: null, meshSelfId: machineId,
    listPoolMachines: () => [{ machineId, nickname: 'Echo Mac', online: true }] as never,
    sessionManager: { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [] } as never });
  try { await server.start(); }
  catch (error) {
    await server.stop();
    if (fixtureDir) await vi.waitFor(() => expect((server as any).desktopLockedController?.sweeping ?? false).toBe(false), { timeout: 10_000 });
    throw error;
  }
  return { server, dir };
}
const auth = { Authorization: 'Bearer desktop-locked-e2e' };

describe('locked-screen access on the production boot path', () => {
  it('ships with no proven macOS', () => {
    expect(PROVEN_MACOS_VERSIONS).toHaveLength(0);
  });

  it('stays dark when remote desktop is off', async () => {
    const { server, dir } = await boot(false);
    try {
      expect((await request(server.getApp()).get('/desktop/locked/status').set(auth)).status).toBe(503);
    } finally { await server.stop(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test cleanup' }); }
  });

  // Reads the real helper's locked state, so it runs only on a Mac set aside for
  // real-helper tests (INSTAR_REAL_DESKTOP_HELPER_TESTS=1); otherwise the route must answer, not hang.
  it.skipIf(process.platform !== 'darwin' || process.env.INSTAR_REAL_DESKTOP_HELPER_TESTS === '1')('answers 503 with a reason when the helper is not available to tests', async () => {
    const { server, dir } = await boot(true);
    try {
      const status = await request(server.getApp()).get('/desktop/locked/status').set(auth);
      expect([200, 503]).toContain(status.status);
      if (status.status === 503) expect(status.body.code).toMatch(/^(mac-desktop-host-[a-z-]+|locked-state-unreadable)$/);
    } finally { await server.stop(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test cleanup' }); }
  });

  it.skipIf(process.platform !== 'darwin' || process.env.INSTAR_REAL_DESKTOP_HELPER_TESTS !== '1')('is alive on a Mac and refuses to turn on', async () => {
    const { server, dir } = await boot(true);
    try {
      const status = await request(server.getApp()).get('/desktop/locked/status').set(auth);
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({ enabled: false, active: false, refusal: 'unsupported-macos' });
      const pin = await request(server.getApp()).post('/dashboard/unlock').send({ pin: '123456' });
      expect(pin.status).toBe(200);
      const session = pin.body.operatorSessionToken as string | undefined;
      expect(typeof session).toBe('string');
      expect(session!.length).toBeGreaterThan(0);
      const reply = await request(server.getApp()).post('/desktop/locked/settings')
        .set({ ...auth, 'X-Instar-Request': '1', 'X-Instar-Operator-Session': session! }).send({ enabled: true });
      expect(reply.status).toBe(409);
      expect(reply.body.error).toBe('unsupported-macos');
      const after = await request(server.getApp()).get('/desktop/locked/status').set(auth);
      expect(after.body.enabled).toBe(false);
    } finally { await server.stop(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test cleanup' }); }
  });
});

// Production AgentServer construction, actual host spawn and HTTP status; only an inert executable.
it.skipIf(process.platform !== 'darwin')('wires native actor diagnostics from production boot through exact child exit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-observer-isolated-boot-'));
  const isolation = isolateNativeObservation(dir); // BEFORE constructing or starting AgentServer
  let server: AgentServer | undefined;
  try {
    ({ server } = await boot(true, dir));
    const host = (server as any).macDesktopHost as MacDesktopHost;
    const controller = (server as any).desktopLockedController;
    expect(host).toBeInstanceOf(MacDesktopHost);
    expect(controller.root).toBe(isolation.root);
    expect((host as any).lockedRoot).toBe(isolation.root);
    expect((host as any).packagedBinary()).toBe(isolation.helper);
    expect(isolation.attemptedRealPaths).toEqual([]);
    const before = await request(server.getApp()).get('/desktop/locked/status').set(auth);
    expect(before.status).toBe(200);
    expect(before.body.guardObservation.instanceId).toBe(host.getRelockGuardObservation().instanceId);
    await host.startRelockGuard('12345678-1234-1234-1234-123456789abc.0');
    await vi.waitFor(() => expect(host.getRelockGuardObservation().entries[0].exit).toBe('exited'), { timeout: 10_000 });
    const after = await request(server.getApp()).get('/desktop/locked/status').set(auth);
    expect(after.status).toBe(200);
    expect(after.body.guardObservation).toMatchObject({ complete: true, sequence: 1,
      entries: [{ spawn: 'spawned', exit: 'exited', exitCode: 0, signal: null }] });
  } finally {
    try {
      await server?.stop();
      if (server) await vi.waitFor(() => expect((server as any).desktopLockedController?.sweeping ?? false).toBe(false), { timeout: 10_000 });
      expect(isolation.attemptedRealPaths).toEqual([]);
    } finally {
      isolation.restore();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'native observer e2e cleanup' });
    }
  }
});
