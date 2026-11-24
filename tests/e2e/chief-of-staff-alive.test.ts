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
import { describe, it, expect, afterAll, vi } from 'vitest';
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
import { ChiefOfStaffPrSearch } from '../../src/core/ChiefOfStaffPrSearch.js';
import { ChiefOfStaffPriorWorkObservation } from '../../src/core/ChiefOfStaffPriorWorkObservation.js';

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
      await request(server.getApp()).get('/chief-of-staff/pr-search?q=instar.sh').set(auth()).expect(503);
      const d = await request(server.getApp()).get(`/chief-of-staff/projects/${encodeURIComponent(CK)}`).set(auth());
      expect(d.status).toBe(503);
      const ask = await request(server.getApp()).post(`/chief-of-staff/projects/${encodeURIComponent(CK)}/pause-ask`).set(auth()).send({ action: 'pause', marker: '[source: telegram 1/2 2026-11-13]' });
      expect(ask.status).toBe(503);
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

    config.developmentAgent = true;
    const chiefOfStaffPrSearch = new ChiefOfStaffPrSearch({ readToken: () => 'e2e-fixture' });
    const server = new AgentServer({ config, sessionManager: sm(), state: new StateManager(stateDir), chiefOfStaffLoop: loop, chiefOfStaffPrSearch });
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
      // Owner pause (spec cos-owner-pause-record): the read carries pausedBy and the unknown-event count; the ask route is
      // mounted and answers honestly — this boot has no Telegram callback machine, so 503 not-callback-machine, never 404.
      expect(d.body.pausedBy).toBeNull();
      expect(r.body.projects[0].pausedBy).toBeNull();
      expect(r.body.unknownLifecycleEvents).toEqual({});
      const ask = await request(server.getApp()).post(`/chief-of-staff/projects/${encodeURIComponent(CK)}/pause-ask`).set(auth()).send({ action: 'pause', marker: '[source: telegram 1/2 2026-11-13]' });
      expect(ask.status).toBe(503); expect(ask.body.error).toBe('not-callback-machine');

      const nf = await request(server.getApp()).get('/chief-of-staff/projects/telegram:1').set(auth());
      expect(nf.status).toBe(404);

      // Incident replay at the HTTP seam: the link lives beyond the first 100 open
      // PRs and only its body says instar.sh. The fresh agent has no topic history
      // or memory to consult and the server uses GitHub directly.
      const originalFetch = globalThis.fetch;
      vi.stubEnv('GITHUB_TOKEN', 'e2e-fixture');
      const github = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (url !== 'https://api.github.com/graphql') return originalFetch(url, init);
        const { variables } = JSON.parse(String(init?.body)) as { variables: { states: string[]; cursor: string | null } };
        const cursorStep = Number(variables.cursor ?? 0);
        const nextCursor = variables.states[0] === 'OPEN' && cursorStep < 2 ? String(cursorStep + 1) : null;
        const results = variables.states[0] === 'MERGED' ? [] : nextCursor
          ? Array.from({ length: 50 }, (_, index) => cursorStep * 50 + index + 1)
          : [3342];
        const nodes = results.map(number => ({
          number, title: `Existing feature ${number}`, body: number === 3342 ? 'Permanent agent addresses on instar.sh' : '',
          headRefName: `topic/fixture-${number}`, baseRefName: 'main', state: 'OPEN',
          updatedAt: '2026-11-23T00:00:00.000Z', mergedAt: null,
        }));
        return new Response(JSON.stringify({
          data: { repository: { isPrivate: false, pullRequests: { nodes, pageInfo: { hasNextPage: nextCursor !== null, endCursor: nextCursor } } } },
        }));
      });
      vi.stubGlobal('fetch', github);
      try {
        const report = vi.fn();
        const observer = new ChiefOfStaffPriorWorkObservation({
          enabled: () => true, chiefOfStaffTopic: () => 141014, owner: () => 9,
          lookup: chiefOfStaffPrSearch, report,
        });
        observer.observe({
          topicId: 141014, senderId: 9, text: 'Where are the permanent instar.sh addresses?',
          replay: false, agentAuthored: false,
        });
        await vi.waitFor(() => expect(report.mock.calls).toEqual([['matched']]));
        const networkCalls = github.mock.calls.filter(([url]) => url === 'https://api.github.com/graphql').length;
        expect(networkCalls).toBe(4);
        const priorWork = await request(server.getApp()).get('/chief-of-staff/pr-search?q=instar.sh').set(auth()).expect(200);
        expect(github.mock.calls.filter(([url]) => url === 'https://api.github.com/graphql')).toHaveLength(networkCalls);
        expect(priorWork.body).toMatchObject({
          coverage: { open: { status: 'fresh' }, merged: { status: 'fresh' } },
          matchCount: 1,
          items: [{ number: 3342, url: 'https://github.com/JKHeadley/instar/pull/3342' }],
        });
        expect(github).toHaveBeenCalledTimes(4);
      } finally {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      }

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
