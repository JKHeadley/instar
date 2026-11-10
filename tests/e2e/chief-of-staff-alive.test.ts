// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" test for the Chief of Staff status surface
 * (docs/specs/chief-of-staff-topic.md §5): GET /chief-of-staff and
 * GET /chief-of-staff/projects/:key.
 *
 * Boots the REAL AgentServer twice on the production init path: once with no loop
 * (the feature is dev-gated off — the routes must answer an honest 503, never a
 * fabricated empty status), and once with a REAL ChiefOfStaffLoop over a real
 * CoherenceJournal (200 with the real shape; a bound project appears in the summary
 * and its detail; an unknown key is 404).
 */
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import { CHIEF_OF_STAFF_KIND_REGISTRATION, CHIEF_OF_STAFF_RECORD_KIND, CHIEF_OF_STAFF_STORE_KEY, buildBindingPut, type UnionEntry } from '../../src/core/ChiefOfStaffStore.js';
import { ChiefOfStaffLoop, CHIEF_OF_STAFF_LOOP_DEFAULTS } from '../../src/core/ChiefOfStaffLoop.js';

const AUTH = 'test-e2e-cos';
const CK = 'telegram:141014';
const tmpDirs: string[] = [];

function mkConfig(): { config: InstarConfig; stateDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-alive-e2e-')); tmpDirs.push(tmpDir);
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
  const config = {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH, requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  } as unknown as InstarConfig;
  return { config, stateDir };
}
const sm = () => ({ listRunningSessions: () => [], getSession: () => null }) as never;
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

afterAll(() => { for (const d of tmpDirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/chief-of-staff-alive.test.ts' }); });

describe('Chief of Staff E2E (feature is alive)', () => {
  it('without the loop (dev-gated off) the routes answer an honest 503', async () => {
    const { config, stateDir } = mkConfig();
    const server = new AgentServer({ config, sessionManager: sm(), state: new StateManager(stateDir) });
    await server.start();
    try {
      const r = await request(server.getApp()).get('/chief-of-staff').set(auth());
      expect(r.status).toBe(503); expect(r.body.error).toMatch(/not enabled/);
      const d = await request(server.getApp()).get(`/chief-of-staff/projects/${encodeURIComponent(CK)}`).set(auth());
      expect(d.status).toBe(503);
    } finally { await server.stop(); }
  });

  it('with a real loop over a real journal the routes are alive (200) with the real shape', async () => {
    const { config, stateDir } = mkConfig();
    const reg = new ReplicatedKindRegistry(); reg.register(CHIEF_OF_STAFF_KIND_REGISTRATION);
    const journal = new CoherenceJournal({ stateDir, machineId: 'm1', flushIntervalMs: 1_000_000 }); journal.open(); journal.setReplicatedKindRegistry(reg);
    let t = Date.parse('2026-11-09T12:00:00Z');
    const emitter = new ReplicatedRecordEmitter({ journal, clock: new HybridLogicalClock({ node: 'm1', now: () => (t += 1000) }), registry: reg, origin: 'm1', stores: () => ({ [CHIEF_OF_STAFF_STORE_KEY]: { enabled: true } }), loadWitness: () => undefined });
    const loadUnion = (): UnionEntry[] => journal.readTail(CHIEF_OF_STAFF_RECORD_KIND, 10_000).entries.map((e) => ({ data: e.data as Record<string, unknown>, origin: 'm1' }));
    const loop = new ChiefOfStaffLoop({
      now: () => Date.now(), machineId: 'm1', enabled: () => true, holdsLease: () => true, config: () => CHIEF_OF_STAFF_LOOP_DEFAULTS,
      journal: { emit: (k, b) => { const r = emitter.emit(CHIEF_OF_STAFF_STORE_KEY, k, b); return { outcome: r.outcome, ...(r.seq !== undefined ? { seq: r.seq } : {}) }; }, loadUnion },
      verifyRenewal: () => true,
      gather: async () => { throw new Error('not exercised here'); },
      judge: async () => null,
      protocol: { claim: async () => ({ outcome: 'rejected', reason: 'e2e' }), standDown: () => false, settleOpenIntent: async () => undefined, operatorLeaseLive: () => false } as never,
      mirrorInitiativeStatus: () => {}, sendNote: async () => {}, sendImmediate: async () => {}, statusUrl: () => 'http://localhost/chief-of-staff', localHour: () => 8,
    });
    // One confirmed binding, written through the real emitter.
    emitter.emit(CHIEF_OF_STAFF_STORE_KEY, `binding:${CK}`, buildBindingPut({ conversationKey: CK, goal: 'Ship the thing', doneDefinition: [{ id: 'd1', kind: 'judgment', text: 'owner says done' }], checkCadenceHours: 24, linked: { repos: [], branches: [], domains: [] }, confirmedBy: 'owner', confirmedAt: new Date().toISOString() } as never));
    journal.flush();

    const server = new AgentServer({ config, sessionManager: sm(), state: new StateManager(stateDir), chiefOfStaffLoop: loop });
    await server.start();
    try {
      const r = await request(server.getApp()).get('/chief-of-staff').set(auth());
      expect(r.status).toBe(200); expect(r.body.error).toBeUndefined();
      expect(r.body.lease).toEqual(expect.objectContaining({ live: expect.any(Boolean) }));
      expect(r.body.protocol).toBeNull(); // no protocol injected in this boot — reported as null, not fabricated
      expect(Array.isArray(r.body.projects)).toBe(true);
      expect(r.body.projects.map((p: { conversationKey: string }) => p.conversationKey)).toEqual([CK]);
      expect(r.body.projects[0].goal).toBe('Ship the thing');

      const d = await request(server.getApp()).get(`/chief-of-staff/projects/${encodeURIComponent(CK)}`).set(auth());
      expect(d.status).toBe(200); expect(d.body.conversationKey).toBe(CK); expect(Array.isArray(d.body.checks)).toBe(true); expect(Array.isArray(d.body.intents)).toBe(true);

      const nf = await request(server.getApp()).get('/chief-of-staff/projects/telegram:1').set(auth());
      expect(nf.status).toBe(404);

      const noAuth = await request(server.getApp()).get('/chief-of-staff');
      expect(noAuth.status).toBe(401);

      // §1.4: the CoS topic is a system topic — adopted by standbys and listed to the console like Attention/Updates.
      new StateManager(stateDir).set('chief-of-staff-topic', 900);
      const sys = await request(server.getApp()).get('/telegram/system-topics').set(auth());
      expect(sys.status).toBe(200); expect(sys.body.topics.chiefOfStaff).toBe(900);
      const st = await request(server.getApp()).get('/chief-of-staff').set(auth());
      expect(st.body.conversationKey).toBe('telegram:900');
    } finally { await server.stop(); journal.close(); }
  });
});
