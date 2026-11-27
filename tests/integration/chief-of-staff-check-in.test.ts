import { readRegistryApprovedProjectAnchor } from '../../src/core/ProjectAnchorRegistry.js';

// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * The dashboard check-in (docs/specs/chief-of-staff-topic.md §4) through the REAL routes: a PIN-gated
 * POST renews the operator lease with a machine-signed record (the loop's `checkIn`), a wrong PIN or a
 * missing PIN renews nothing, and the status route then shows the lease live with the conversation key.
 * Feature off (no loop) ⇒ 503 on both.
 */
import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { sign, verify } from '../../src/core/MachineIdentity.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { ChiefOfStaffLoop, CHIEF_OF_STAFF_LOOP_DEFAULTS } from '../../src/core/ChiefOfStaffLoop.js';
import { chiefOfStaffRecordStoreSchema, type UnionEntry } from '../../src/core/ChiefOfStaffStore.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/chief-of-staff-check-in.test.ts' }); });

function keypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return { priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, pub: publicKey.export({ type: 'spki', format: 'pem' }) as string };
}
const ctxV = () => ({ countDroppedField: () => {}, countJailReject: () => {} });

function app(opts: { loop: boolean; progress?: boolean; anchor?: boolean; preview?: boolean; incomplete?: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-checkin-')); dirs.push(dir);
  const keys = keypair();
  const tracker = new InitiativeTracker(dir);
  const entries: UnionEntry[] = []; let clock = 1; let seq = 0;
  const loop = new ChiefOfStaffLoop({
    now: () => Date.now(), machineId: 'm1', enabled: () => true, holdsLease: () => true, config: () => CHIEF_OF_STAFF_LOOP_DEFAULTS,
    journal: {
      emit: (recordKey, build) => { const hlc: HlcTimestamp = { physical: ++clock, logical: 0, node: 'm1' }; const data = build(hlc, 'm1'); if (!data) return { outcome: 'dropped' }; const v = chiefOfStaffRecordStoreSchema.validate(data, ctxV()); if (!v) return { outcome: 'dropped:schema' }; entries.push({ data: { ...v, recordKey, hlc, op: 'put', origin: 'm1' }, origin: 'm1' }); return { outcome: 'emitted', seq: ++seq }; },
      loadUnion: () => entries.slice(),
      loadUnionCompleteReadOnly: () => opts.incomplete ? null : entries.slice(),
    },
    verifyRenewal: (r) => verify(`cos-renewal:${r.renewedAt}:${r.renewedVia}:${r.principal}:${r.machine}`, String(r.machineSignature), keys.pub),
    gather: async () => { throw new Error('n/a'); }, judge: async () => null,
    readProjectProgress: opts.progress ? async (projects) => new Map(projects.map((project) => [
      project.conversationKey,
      { evidence: [{ kind: 'merge', at: new Date(Date.now() - 7 * 3_600_000).toISOString() }], waitingOn: ['Verification'], complete: true },
    ])) : undefined,
    protocol: { claim: async () => ({ outcome: 'rejected', reason: 'n/a' }), standDown: () => null, settleOpenIntent: async () => 'lost', operatorLeaseLive: () => false } as never,
    mirrorInitiativeStatus: () => {}, sendNote: async () => {}, sendImmediate: async () => {}, statusUrl: () => 'x', localHour: () => 8,
    sign: (c) => sign(c, keys.priv),
    rootConversationKey: () => 'telegram:900',
  });
  const state = new Map<string, unknown>([['chief-of-staff-topic', 900]]);
  const ctx = {
    config: { projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', dashboardPin: '424242', sessions: {}, scheduler: {} },
    startTime: new Date(), scheduler: null,
    sessionManager: { listRunningSessions: () => [], killSession: () => true },
    state: { get: (k: string) => state.get(k) ?? null, getJobState: () => null, getSession: () => null, queryEvents: () => [], getCoherenceJournal: () => undefined, readOnly: false },
    liveConfig: { get: (key: string, fallback?: unknown) => key === 'chiefOfStaff.bindingBatchPreview' ? opts.preview ?? fallback : fallback },
    verifyDashboardOperatorSession: (token?: string) => token === 'operator-session',
    ...(opts.loop ? { chiefOfStaffLoop: loop } : {}),
    ...(opts.progress || opts.anchor ? { initiativeTracker: tracker } : {}),
    ...(opts.anchor ? {
      verifyDashboardOperatorSession: (token?: string) => token === 'anchor-owner',
      telegram: {
        getVerifiedOwner: () => 101,
        findTopicMessage: (topic: number, id: number) => ({ entry: topic === 141133 && id === 11 ? {
          messageId: 11, fromUser: true, forwarded: false, telegramUserId: 101,
          timestamp: '2026-11-26T22:00:00Z', text: 'Use fewer tokens while keeping context intact.',
        } : null }),
      },
    } : {}),
  } as unknown as RouteContext;
  const a = express();
  a.use(express.json());
  a.use(authMiddleware(() => 'tok-1', 'echo'));
  a.use(createRoutes(ctx));
  return { a, entries, loop, tracker };
}
const auth = { Authorization: 'Bearer tok-1', 'X-Instar-AgentId': 'echo', 'X-Instar-Request': '1' };

describe('POST /chief-of-staff/check-in', () => {
  it('feature off ⇒ 503 on check-in and status', async () => {
    const { a } = app({ loop: false });
    expect((await request(a).post('/chief-of-staff/check-in').set(auth).send({ pin: '424242' })).status).toBe(503);
    expect((await request(a).get('/chief-of-staff').set(auth)).status).toBe(503);
  });
  it('a missing or wrong PIN renews nothing; the right PIN writes a signed renewal and the lease reads live with the conversation key', async () => {
    const { a, entries } = app({ loop: true });
    const before = await request(a).get('/chief-of-staff').set(auth);
    expect(before.status).toBe(200); expect(before.body.lease.live).toBe(false); expect(before.body.conversationKey).toBe('telegram:900');
    expect((await request(a).post('/chief-of-staff/check-in').set(auth).send({})).status).toBeGreaterThanOrEqual(400);
    expect((await request(a).post('/chief-of-staff/check-in').set(auth).send({ pin: '000000' })).status).toBeGreaterThanOrEqual(400);
    expect(entries.filter((e) => e.data.recordType === 'renewal')).toHaveLength(0);
    const ok = await request(a).post('/chief-of-staff/check-in').set(auth).send({ pin: '424242' });
    expect(ok.status).toBe(200); expect(ok.body.ok).toBe(true); expect(ok.body.lease.live).toBe(true);
    const renewals = entries.filter((e) => e.data.recordType === 'renewal');
    expect(renewals).toHaveLength(1); expect(renewals[0].data.renewedVia).toBe('console'); expect(renewals[0].data.principal).toBe('console:owner');
    const after = await request(a).get('/chief-of-staff').set(auth);
    expect(after.body.lease.live).toBe(true);
  });
});

describe('POST /chief-of-staff/projects + /projects/:key/tap (PIN-gated owner surface)', () => {
  it('binds a project with the PIN, lists it, refuses a bad body and a wrong PIN, and taps unpark/confirm-done through the loop', async () => {
    const { a, entries } = app({ loop: true });
    const body = { conversationKey: 'telegram:1', goal: 'Ship the thing', doneDefinition: [{ id: 'pr', kind: 'deterministic', text: 'PR merged' }], linked: { repos: ['o/r'] } };
    expect((await request(a).post('/chief-of-staff/projects').set(auth).send({ ...body, pin: '000000' })).status).toBeGreaterThanOrEqual(400);
    expect((await request(a).post('/chief-of-staff/projects').set(auth).send({ pin: '424242', goal: 'no key' })).status).toBe(400);
    const ok = await request(a).post('/chief-of-staff/projects').set(auth).send({ ...body, pin: '424242' });
    expect(ok.status).toBe(201);
    expect(entries.filter((e) => e.data.recordType === 'binding')).toHaveLength(1);
    expect(entries.find((e) => e.data.recordType === 'tree' && e.data.conversationKey === 'telegram:1')?.data.parentConversationKey).toBe('telegram:900');
    const list = await request(a).get('/chief-of-staff').set(auth);
    expect(list.body.projects.map((p: { conversationKey: string }) => p.conversationKey)).toEqual(['telegram:1']);
    const tap = await request(a).post('/chief-of-staff/projects/telegram:1/tap').set(auth).send({ pin: '424242', action: 'unpark' });
    expect(tap.status).toBe(200); expect(tap.body.result).toBe('ok');
    const bad = await request(a).post('/chief-of-staff/projects/telegram:1/tap').set(auth).send({ pin: '424242', action: 'explode' });
    expect(bad.status).toBe(400);
  });
});


describe('verified project progress on GET /chief-of-staff', () => {
  it('reports qualified movement and explicit waits after a read-only tick', async () => {
    const { a, loop, tracker } = app({ loop: true, progress: true });
    await tracker.create({
      id: 'registry-only', kind: 'project', title: 'Registry-only project', description: 'Fixture',
      phases: [{ id: 'run', name: 'Run' }], telegramTopicId: '2',
    });
    await request(a).post('/chief-of-staff/projects').set(auth).send({
      pin: '424242', conversationKey: 'telegram:1', goal: 'Track exact movement',
      doneDefinition: [{ id: 'current', kind: 'judgment', text: 'Observe the result' }],
    }).expect(201);
    await loop.tick();
    const r = await request(a).get('/chief-of-staff').set(auth).expect(200);
    expect(r.body.projects[0]).toMatchObject({
      lastProgressAt: expect.any(String), lastProgressKind: 'merge', waitingOn: ['Verification'],
      stalledSince: null, progressEvidenceComplete: true,
    });
    expect(r.body.projectCoverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationKey: 'telegram:1', disposition: 'tracked' }),
      expect.objectContaining({ conversationKey: 'telegram:2', disposition: 'awaiting-binding', progress: null }),
    ]));
  });
});


describe('source-backed project purpose', () => {
  it('copies an exact owner message across topics and refuses missing history or replacement', async () => {
    const { a, tracker } = app({ loop: false, anchor: true });
    const project = await tracker.create({
      id: 'context-budget', title: 'Context Budget', kind: 'project', description: 'Fixture',
      phases: [{ id: 'fold', name: 'Fold' }], telegramTopicId: '141134',
    });
    const route = '/projects/context-budget/alignment-anchor';
    const operator = { ...auth, 'X-Instar-Operator-Session': 'anchor-owner' };
    const sourceMessage = { conversationKey: 'telegram:141133', messageId: '11', at: '2026-11-26T22:00:00Z' };
    const body = { expectedVersion: project.version, conversationKey: 'telegram:141134', sourceMessage };

    await request(a).put(route).set(auth).send(body).expect(403);
    await request(a).put(route).set(operator).send({ ...body, expectedVersion: project.version! + 1 })
      .expect(409, { error: 'project-anchor-stale-or-not-stored' });
    await request(a).put(route).set(operator).send({ ...body, anchor: { done: [] }, ignored: true }).expect(400, {
      error: 'Unsupported field(s): anchor, ignored',
      unsupportedFields: ['anchor', 'ignored'],
      supportedFields: ['expectedVersion', 'conversationKey', 'sourceMessage'],
    });
    await request(a).put(route).set(operator).send({
      ...body, sourceMessage: { ...sourceMessage, messageId: '12' },
    }).expect(409, { error: 'project-anchor-owner-source-unverified' });
    expect(tracker.get(project.id)?.approvedProjectAnchor).toBeUndefined();

    await request(a).put(route).set(operator).send(body).expect(200);
    const saved = tracker.get(project.id)!;
    expect(readRegistryApprovedProjectAnchor(saved, body.conversationKey)).toEqual({
      revision: 1, purpose: 'Use fewer tokens while keeping context intact.',
      sourceMessages: [sourceMessage], done: [], outOfScope: [],
    });
    await request(a).put(route).set(operator).send({ ...body, expectedVersion: saved.version })
      .expect(409, { error: 'project-anchor-already-exists' });
  });
});

describe('read-only Chief of Staff binding batch preview', () => {
  const route = '/chief-of-staff/project-binding-preview';
  const operator = { ...auth, 'X-Instar-Operator-Session': 'operator-session' };
  const draft = {
    version: 1, id: 'a'.repeat(32), createdAt: '2026-11-26T20:00:00Z',
    sourceMessageRefs: ['telegram:1/2'],
    items: [{
      kind: 'project-bind', title: 'Fixture project',
      binding: {
        conversationKey: 'telegram:123', goal: 'Fixture goal',
        doneDefinition: [{ id: 'check', kind: 'deterministic', text: 'Fixture check' }],
        checkCadenceHours: 24, linked: {},
      },
    }],
  };

  it('defaults off, requires an owner session, validates the draft, and writes nothing', async () => {
    await request(app({ loop: true }).a).post(route).set(operator).send({ draft }).expect(503);
    await request(app({ loop: true, preview: true, incomplete: true }).a)
      .post(route).set(operator).send({ draft }).expect(503);
    const { a, entries } = app({ loop: true, preview: true });
    await request(a).post(route).set(auth).send({ draft }).expect(403);
    await request(a).post(route).set(operator).send({ draft: null }).expect(400);
    const response = await request(a).post(route).set(operator).send({ draft }).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      mode: 'preview', items: [{ item: draft.items[0], disposition: 'proposed-binding' }],
    });
    expect(entries).toEqual([]);
  });
});
