/**
 * The owner record is ALIVE through the production wiring (identity-security piece 2b; Testing Integrity
 * Phase 1): server.ts's calls into ownerRecordWiring build a real store over a real machine identity, the
 * route answers 200 (not 503), the mesh handlers answer instead of "no handler", and turning it off
 * answers 503.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import * as ownerRecordWiring from '../../src/core/ownerRecordWiring.js';

const AUTH = 'test-owner-record-lifecycle';

function config(tmp: string, extra: Record<string, unknown> = {}): InstarConfig {
  const stateDir = path.join(tmp, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'orl', agentName: 'ORL' }));
  return {
    projectName: 'orl', projectDir: tmp, stateDir, port: 0, authToken: AUTH, requestTimeoutMs: 10000, version: '0.10.3',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {}, ...extra,
  } as InstarConfig;
}

describe('owner record lifecycle (production wiring)', () => {
  let tmp: string;
  beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'or-life-')); });
  afterEach(() => ownerRecordWiring.resetOwnerRecordWiringForTests());
  afterAll(() => { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/e2e/identity-piece2b-owner-record-lifecycle.test.ts:cleanup' }); });

  it('server.ts calls the wiring at boot, registers the mesh handlers, starts the sync and passes the route', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf8');
    expect(src).toContain('ownerRecordWiring.wireOwnerRecordStore(config as never, coordinator.managers.identityManager);');
    expect(src).toContain('...(ownerRecordWiring.ownerRecordMeshHandlers()');
    expect(src).toContain('ownerRecordWiring.startOwnerRecordSync({');
    expect(src).toContain('ownerRecord: ownerRecordWiring.ownerRecordRouteDeps,');
  });

  it('is alive: a real machine identity, the route answers 200 and the store can bootstrap', async () => {
    const cfg = config(path.join(tmp, 'alive'));
    const identity = new MachineIdentityManager(cfg.stateDir);
    await identity.generateIdentity({ name: 'test-machine' });
    const store = ownerRecordWiring.wireOwnerRecordStore(cfg as never, identity);
    expect(store).not.toBeNull();
    const server = new AgentServer({ config: cfg, sessionManager: createMockSessionManager() as never, state: new StateManager(cfg.stateDir), ownerRecord: ownerRecordWiring.ownerRecordRouteDeps });
    let r = await request(server.getApp()).get('/owner-record').set({ Authorization: `Bearer ${AUTH}` });
    expect(r.status).toBe(200);
    expect(r.body.gate.act).toBe('basic');
    store!.bootstrap();
    r = await request(server.getApp()).get('/owner-record').set({ Authorization: `Bearer ${AUTH}` });
    expect(r.body).toMatchObject({ status: 'ok', machineKeys: [identity.loadIdentity().machineId] });
  });

  it('the mesh handlers answer, not "no handler" (disabled until the sync starts, then live)', () => {
    const cfg = config(path.join(tmp, 'mesh'));
    const identity = new MachineIdentityManager(cfg.stateDir);
    ownerRecordWiring.wireOwnerRecordStore(cfg as never, identity);
    const h = ownerRecordWiring.ownerRecordMeshHandlers();
    expect(h['owner-record-pull']({ type: 'owner-record-pull', have: [], after: null }, 'm_peer')).toMatchObject({ ok: false, reason: 'owner-record disabled' });
    ownerRecordWiring.startOwnerRecordSync({ config: cfg as never, identity, selfMachineId: 'm_self', send: async () => ({ ok: false }), leaseHolder: () => null, splitBrain: () => false, degrade: () => {} });
    expect(h['owner-record-pull']({ type: 'owner-record-pull', have: [], after: null }, 'm_peer')).toMatchObject({ hasRecord: false, entries: [] });
  });

  it('piece 2c: the production sync sends its build in every pull, and the route reports the fence', async () => {
    const cfg = config(path.join(tmp, 'fence'));
    const identity = new MachineIdentityManager(cfg.stateDir);
    await identity.generateIdentity({ name: 'fence-machine' });
    ownerRecordWiring.wireOwnerRecordStore(cfg as never, identity);
    const sent: unknown[] = [];
    const sync = ownerRecordWiring.startOwnerRecordSync({ config: cfg as never, identity, selfMachineId: identity.loadIdentity().machineId, send: async (_m, cmd) => { sent.push(cmd); return { ok: false }; }, leaseHolder: () => null, splitBrain: () => false, degrade: () => {} });
    (identity as unknown as { getActiveMachines: () => Array<{ machineId: string }> }).getActiveMachines = () => [{ machineId: 'm_peer' }];
    await sync!.tick();
    expect(sent[0]).toMatchObject({ type: 'owner-record-pull', build: expect.any(String), guards: ['fence-lease', 'fence-routing', 'approver-record'] }); // piece 2d's live guards
    const server = new AgentServer({ config: cfg, sessionManager: createMockSessionManager() as never, state: new StateManager(cfg.stateDir), ownerRecord: ownerRecordWiring.ownerRecordRouteDeps });
    const r = await request(server.getApp()).get('/owner-record').set({ Authorization: `Bearer ${AUTH}` });
    expect(r.body.fence).toMatchObject({ inForce: null, selfBuild: expect.any(String) });
  });

  it('turned off: no store and the route answers 503', async () => {
    const cfg = config(path.join(tmp, 'off'), { security: { ownerRecord: { enabled: false } } });
    expect(ownerRecordWiring.wireOwnerRecordStore(cfg as never, new MachineIdentityManager(cfg.stateDir))).toBeNull();
    const server = new AgentServer({ config: cfg, sessionManager: createMockSessionManager() as never, state: new StateManager(cfg.stateDir), ownerRecord: ownerRecordWiring.ownerRecordRouteDeps });
    const r = await request(server.getApp()).get('/owner-record').set({ Authorization: `Bearer ${AUTH}` });
    expect(r.status).toBe(503);
  });
});
