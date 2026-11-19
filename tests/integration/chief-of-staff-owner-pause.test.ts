// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Owner pause / resume through the REAL routes (docs/specs/cos-owner-pause-record.md §3.2): the ask route refuses
 * a citation that is not the owner's own message and sends nothing; a valid ask sends one button message; the
 * owner's tap on that exact message pauses, and `GET /chief-of-staff` shows `pausedBy`; the PIN tap route stays
 * limited to unpark / confirm-done; unknown lifecycle events are counted in the status.
 */
import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ChiefOfStaffLoop, CHIEF_OF_STAFF_LOOP_DEFAULTS, type PauseAsk } from '../../src/core/ChiefOfStaffLoop.js';
import { chiefOfStaffRecordStoreSchema, buildBindingPut, buildLifecycleEvent, foldBindingState, type UnionEntry } from '../../src/core/ChiefOfStaffStore.js';
import { checkOwnerPauseSource } from '../../src/core/cosOwnerPauseSource.js';
import type { ResolveResult } from '../../src/core/attribution/SourceResolver.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/chief-of-staff-owner-pause.test.ts' }); });

const CK = 'telegram:102965';
const OWNER = 7812716706;
const OWNER_TEXT = 'lets pause the Instar 2.0 work again until we get our throughput issues solved';
const GOOD = '[source: telegram 102965/142745 2026-11-13]';
const AGENT = '[source: telegram 102965/142746 2026-11-13]';
const OTHER = '[source: telegram 102965/142747 2026-11-13]';
const ctxV = () => ({ countDroppedField: () => {}, countJailReject: () => {} });
const rows: Record<string, { row: Record<string, unknown>; authorship: ResolveResult['authorship'] }> = {
  '142745': { row: { text: OWNER_TEXT, fromUser: true, provenance: 'user', forwarded: false, telegramUserId: OWNER, timestamp: '2026-11-13T16:52:10.000Z' }, authorship: 'human' },
  '142746': { row: { text: OWNER_TEXT, fromUser: false, provenance: 'agent', telegramUserId: 1, timestamp: '2026-11-13T16:53:00.000Z' }, authorship: 'agent-outbound' },
  '142747': { row: { text: OWNER_TEXT, fromUser: true, provenance: 'user', forwarded: false, telegramUserId: 555, timestamp: '2026-11-13T16:54:00.000Z' }, authorship: 'human' },
};

function app(opts: { loop: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-pause-')); dirs.push(dir);
  const entries: UnionEntry[] = []; let clock = 1; let seq = 0;
  const emit = (recordKey: string, build: (hlc: HlcTimestamp, origin: string) => Record<string, unknown> | null) => { const hlc: HlcTimestamp = { physical: ++clock, logical: 0, node: 'm1' }; const data = build(hlc, 'm1'); if (!data) return { outcome: 'dropped' }; const v = chiefOfStaffRecordStoreSchema.validate(data, ctxV()); if (!v) return { outcome: 'dropped:schema' }; entries.push({ data: { ...v, recordKey, hlc, op: 'put', origin: 'm1' }, origin: 'm1' }); return { outcome: 'emitted', seq: ++seq }; };
  const sent: Array<{ text: string; id: string }> = [];
  let asks: Record<string, PauseAsk> = {};
  const loop = new ChiefOfStaffLoop({
    now: () => Date.now(), machineId: 'm1', enabled: () => true, holdsLease: () => true, config: () => CHIEF_OF_STAFF_LOOP_DEFAULTS,
    journal: { emit, loadUnion: () => entries.slice(), awaitDurable: async () => {} },
    verifyRenewal: () => false,
    gather: async () => { throw new Error('n/a'); }, judge: async () => null,
    protocol: { claim: async () => ({ outcome: 'rejected', reason: 'n/a' }), standDown: () => null, settleOpenIntent: async () => 'lost', operatorLeaseLive: () => false } as never,
    mirrorInitiativeStatus: () => {}, sendNote: async () => {}, sendImmediate: async () => {}, statusUrl: () => 'x', localHour: () => 8,
    rootConversationKey: () => 'telegram:900',
    pauseAsk: {
      receivesCallbacks: () => true, asksEnabled: () => true, ownerName: () => 'Justin', olderMachines: () => [], conversationName: () => 'Instar 2.0',
      store: { load: () => JSON.parse(JSON.stringify(asks)), save: (a) => { asks = JSON.parse(JSON.stringify(a)); } },
      send: async (text, button) => { sent.push({ text, id: button.id }); return { chatId: '-100', messageId: 900 + sent.length }; },
    },
  });
  loop.bindPauseSourceCheck((marker) => checkOwnerPauseSource({
    resolve: async (ref) => { const r = rows[ref.message]; return r ? { outcome: 'found', row: r.row, failed: [], authorship: r.authorship } : { outcome: 'not-found', failed: [] }; },
    ownerUid: () => OWNER,
    identity: (_c, id) => (id === String(OWNER) ? 'Justin Headley' : id === '555' ? 'Justin' : null),
  }, marker));
  emit(`binding:${CK}`, buildBindingPut({ conversationKey: CK, goal: 'Instar 2.0', checkCadenceHours: 24, doneDefinition: [{ id: 'pr', kind: 'deterministic', text: 'PR merged' }], linked: { repos: ['o/r'], branches: ['b'] }, confirmedBy: 'owner', confirmedAt: new Date().toISOString() } as never));
  const state = new Map<string, unknown>([['chief-of-staff-topic', 900]]);
  const ctx = {
    config: { projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', dashboardPin: '424242', sessions: {}, scheduler: {} },
    startTime: new Date(), scheduler: null,
    sessionManager: { listRunningSessions: () => [], killSession: () => true },
    state: { get: (k: string) => state.get(k) ?? null, getJobState: () => null, getSession: () => null, queryEvents: () => [], getCoherenceJournal: () => undefined, readOnly: false },
    liveConfig: { get: (_k: string, fb?: unknown) => fb },
    ...(opts.loop ? { chiefOfStaffLoop: loop } : {}),
  } as unknown as RouteContext;
  const a = express();
  a.use(express.json());
  a.use(authMiddleware(() => 'tok-1', 'echo'));
  a.use(createRoutes(ctx));
  return { a, entries, sent, loop, asks: () => asks, emit };
}
const auth = { Authorization: 'Bearer tok-1', 'X-Instar-AgentId': 'echo', 'X-Instar-Request': '1' };
const route = `/chief-of-staff/projects/${encodeURIComponent(CK)}/pause-ask`;

describe('POST /chief-of-staff/projects/:key/pause-ask', () => {
  it('feature off ⇒ 503; a malformed body ⇒ 400', async () => {
    expect((await request(app({ loop: false }).a).post(route).set(auth).send({ action: 'pause', marker: GOOD })).status).toBe(503);
    const { a } = app({ loop: true });
    expect((await request(a).post(route).set(auth).send({ action: 'stop', marker: GOOD })).status).toBe(400);
    expect((await request(a).post(route).set(auth).send({ action: 'pause' })).status).toBe(400);
  });
  it('an agent-authored, another sender, unknown or forged marker ⇒ 422 with the reason, nothing sent, nothing written', async () => {
    const { a, sent, entries } = app({ loop: true });
    for (const [marker, reason] of [[AGENT, 'not-human'], [OTHER, 'not-owner'], ['[source: telegram 102965/1 2026-11-13]', 'not-found'], ['pause it', 'marker-malformed']] as const) {
      const r = await request(a).post(route).set(auth).send({ action: 'pause', marker });
      expect(r.status).toBe(422); expect(r.body.error).toBe(reason);
    }
    expect(sent).toHaveLength(0);
    expect(entries.filter((e) => e.data.event === 'owner-pause')).toHaveLength(0);
  });
  it("a valid ask sends one button message; the owner's tap on it pauses; the status shows pausedBy; a resume ask then resumes", async () => {
    const { a, sent, loop, asks, entries } = app({ loop: true });
    const r = await request(a).post(route).set(auth).send({ action: 'pause', marker: GOOD });
    expect(r.status).toBe(200); expect(r.body.asked).toBe(true);
    expect(sent).toHaveLength(1); expect(sent[0].text).toContain(OWNER_TEXT); expect(sent[0].id).toMatch(/^cos:p:[a-f0-9]{16}$/);
    // Nothing is paused until the owner taps.
    expect((await request(a).get('/chief-of-staff').set(auth)).body.projects[0].pausedBy).toBeNull();
    const [askId, ask] = Object.entries(asks())[0];
    expect(await loop.ownerTap(`cos:p:${askId}`, 'owner-tap', { chatId: ask.chatId, messageId: ask.askMessageId })).toBe('paused');
    const st = await request(a).get('/chief-of-staff').set(auth);
    expect(st.body.projects[0].pausedBy).toMatchObject({ who: 'Justin', quote: OWNER_TEXT, messageRef: GOOD });
    expect((await request(a).get(`/chief-of-staff/projects/${encodeURIComponent(CK)}`).set(auth)).body.pausedBy).toMatchObject({ quote: OWNER_TEXT });
    const res = await request(a).post(route).set(auth).send({ action: 'resume', marker: GOOD });
    expect(res.status).toBe(200);
    const [rid, rask] = Object.entries(asks())[0];
    expect(await loop.ownerTap(`cos:r:${rid}`, 'owner-tap', { chatId: rask.chatId, messageId: rask.askMessageId })).toBe('resumed');
    expect(foldBindingState(entries).get(CK)!.pausedBy).toBeNull();
  });
  it('the PIN tap route still refuses a pause; unknown lifecycle events are counted in the status', async () => {
    const { a, emit, entries } = app({ loop: true });
    expect((await request(a).post(`/chief-of-staff/projects/${encodeURIComponent(CK)}/tap`).set(auth).send({ pin: '424242', action: 'pause' })).status).toBe(400);
    const h = foldBindingState(entries).get(CK)!.bindingHlc!;
    emit('lc:future', (hl, o) => ({ ...buildLifecycleEvent(CK, 'unpark', h, 'owner-tap', new Date().toISOString())(hl, o)!, event: 'some-future-event' }));
    expect((await request(a).get('/chief-of-staff').set(auth)).body.unknownLifecycleEvents).toEqual({ 'some-future-event': 1 });
  });
});
