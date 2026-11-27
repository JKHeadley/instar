/**
 * Feature-is-alive proof for project rows that say something (docs/specs/work-door-project-rows.md): an AgentServer
 * booted on its production path with a Chief of Staff loop answers the Projects read with the new row fields, runs
 * "Ask for an update" for the bearer (200 with the fresh row, then 202 queued), and mounts the owner phone's three
 * Face ID routes (a call without a device signature is refused by the phone gate, never 404). Without a loop the check
 * route answers 503 chief-of-staff-off, not 404.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { ChiefOfStaffLoop, CHIEF_OF_STAFF_LOOP_DEFAULTS, clampLoopConfig, type ChiefOfStaffLoopDeps } from '../../src/core/ChiefOfStaffLoop.js';
import { chiefOfStaffRecordStoreSchema, buildBindingPut, type UnionEntry } from '../../src/core/ChiefOfStaffStore.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';

const CK = 'telegram:144900';
const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/work-door-project-rows-alive.test.ts' });
});

function loopWithOneProject(): ChiefOfStaffLoop {
  const entries: UnionEntry[] = []; let clock = 1; let seq = 0;
  const emit = (recordKey: string, build: (hlc: HlcTimestamp, origin: string) => Record<string, unknown> | null) => {
    const hlc: HlcTimestamp = { physical: ++clock, logical: 0, node: 'm_e2e' };
    const data = build(hlc, 'm_e2e'); if (!data) return { outcome: 'dropped' };
    const v = chiefOfStaffRecordStoreSchema.validate(data, { countDroppedField: () => {}, countJailReject: () => {} } as never);
    if (!v) return { outcome: 'dropped:schema' };
    entries.push({ data: { ...v, recordKey, hlc, op: 'put', origin: 'm_e2e' }, origin: 'm_e2e' }); return { outcome: 'emitted', seq: ++seq };
  };
  const cfg = clampLoopConfig({ ...CHIEF_OF_STAFF_LOOP_DEFAULTS });
  const deps: ChiefOfStaffLoopDeps = {
    now: () => Date.now(), machineId: 'm_e2e', enabled: () => true, holdsLease: () => true, config: () => cfg,
    journal: { emit, loadUnion: () => entries.slice(), awaitDurable: async () => {} },
    verifyRenewal: () => true,
    gather: async () => ({ conversationKey: CK, items: [{ id: 'run', source: 'run', ageMs: 1000, value: 'x', unknown: false }], netDiffLines: 0, mergedPrsSinceLastCheck: 0, doneItems: { pr: 'fail' }, liveSession: false, conversationTail: [], lastOwnerMessageAt: null, lastAgentMessageAt: null, overdueCommitments: 0 }),
    judge: async () => ({ verdict: 'moving', citedIds: ['run'], reason: 'The PR is in review.' }),
    protocol: { claim: async () => ({ outcome: 'started', runId: 'r' }), standDown: () => null, settleOpenIntent: async () => 'lost', operatorLeaseLive: () => true } as unknown as ChiefOfStaffLoopDeps['protocol'],
    mirrorInitiativeStatus: () => {}, sendNote: async () => {}, sendImmediate: async () => {}, statusUrl: () => null, localHour: () => 3,
  };
  emit(`binding:${CK}`, buildBindingPut({ conversationKey: CK, goal: 'Rows that say something.', checkCadenceHours: 24, doneDefinition: [{ id: 'pr', kind: 'deterministic', text: 'PR merged' }, { id: 'feel', kind: 'judgment', text: 'Feels right' }], linked: { repos: ['o/r'], branches: ['b'] }, confirmedBy: 'owner', confirmedAt: new Date().toISOString() } as never));
  return new ChiefOfStaffLoop(deps);
}

async function boot(chiefOfStaffLoop: ChiefOfStaffLoop | null) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'wdpr-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const config = {
    projectName: 'wdpr-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), chiefOfStaffLoop } as never);
  servers.push(server);
  return server.getApp();
}

describe('project rows — production wiring', () => {
  it('is alive: the row fields, Ask for an update, and the phone routes are mounted', async () => {
    const app = await boot(loopWithOneProject());
    const bearer = (r: request.Test) => r.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'wdpr-e2e');
    const read = await bearer(request(app).get('/work/projects'));
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const p = read.body.projects.find((x: { key: string }) => x.key === CK);
    expect(p).toBeTruthy();
    expect(p).toHaveProperty('actions');
    expect(p.done.items.find((i: { id: string }) => i.id === 'feel')).toMatchObject({ kind: 'owner-judged', canMark: true });
    expect(p.checks.here).toBe(true);

    const first = await bearer(request(app).post('/work/projects/check')).send({ key: CK });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.project.latestReport.text).toBe('The PR is in review.');
    const second = await bearer(request(app).post('/work/projects/check')).send({ key: CK });
    expect(second.status).toBe(202);

    // The phone's Face ID routes are mounted behind the phone gate: a bearer call is refused there, never 404.
    for (const route of ['/mobile/work/projects/pause', '/mobile/work/projects/done-item', '/mobile/work/projects/finish']) {
      const r = await bearer(request(app).post(route)).send({ key: CK });
      expect(r.status, route).not.toBe(404);
      expect(r.status, route).not.toBe(200);
    }
  }, 60_000);

  it('without a Chief of Staff the check route answers chief-of-staff-off, not 404', async () => {
    const app = await boot(null);
    const r = await request(app).post('/work/projects/check').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'wdpr-e2e').send({ key: CK });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('chief-of-staff-off');
  }, 60_000);
});
