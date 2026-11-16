// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * Unit — the Anchor and ledger backfill (context-budget-layered-summaries
 * §6.1, decision 9, §12 "Backfill daily cap", §14, §15; Phase 1 S7).
 *
 * The ledger side runs on real TopicMemory, LayerStore, U (UserCorpus) with
 * real MemoryPrivacy, TopicIntentStore and the extended
 * PendingConfirmationManager. The lane side runs the real BackfillLane over
 * its real state file with recorded fakes for U and the ledger. Both sides of
 * each boundary:
 *  - switch on / off (off ⇒ S6's behaviour, the lane does no work);
 *  - an operator-bound history entry is backfilled-unconfirmed / a history
 *    ref not bound to an operator row is left out;
 *  - confirmation rendered only after user activity since it went outstanding,
 *    surfaced only by a reply after that, never before;
 *  - an operator episode after history gives the normal status, and the
 *    confirmation settles when none is left; expiry keeps the entries;
 *  - the lane: owner / non-owner / unknown; cap reached; recency order;
 *    resume after a restart; a failing topic parked and reported once.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { LayerStore } from '../../src/monitoring/contextLayers/LayerStore.js';
import { UserCorpus } from '../../src/monitoring/contextLayers/userCorpus.js';
import { AnchorLedger, ledgerKeyFor, backfillRefId, backfillView, anchorLedgerView, measureAnchorLedger } from '../../src/monitoring/contextLayers/anchorLedger.js';
import { BackfillLane, BACKFILL_DAILY_TOPIC_CAP, BACKFILL_MAX_ATTEMPTS, BACKFILL_MAX_TICKS_PER_TOPIC, topicOwnerCheck } from '../../src/monitoring/contextLayers/backfillLane.js';
import { selectLiveSet } from '../../src/monitoring/contextLayers/anchorLedger.js';
import { TopicIntentStore, buildEvent, type EvidenceKind, type RefKind } from '../../src/core/TopicIntent.js';
import { PendingConfirmationManager } from '../../src/core/TopicIntentPendingConfirm.js';
import { renderTopicIntentBriefing } from '../../src/core/TopicIntentBriefing.js';
import { MemoryPrivacy } from '../../src/users/MemoryPrivacy.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/context-layer-backfill.test.ts';
const T = 7171;
const OWNER = 111;
const DAY = 24 * 3600_000;
const T0 = Date.UTC(2026, 10, 10, 10, 0, 0);
const BLOCK = 'REBUILT FROM EARLIER HISTORY';

const dirs: string[] = [];
const mems: TopicMemory[] = [];
afterEach(() => {
  for (const m of mems.splice(0)) { try { m.close(); } catch { /* best-effort */ } }
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
});
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

async function setup() {
  const root = tmp('cl-bf-');
  const sd = path.join(root, 'agent'); fs.mkdirSync(sd, { recursive: true });
  const tm = new TopicMemory(sd); await tm.open(); mems.push(tm);
  const store = new LayerStore({ stateDir: sd, liveSecrets: () => [] });
  const privacy = new MemoryPrivacy({ stateDir: sd, instarRoot: root, agentId: 'x', config: () => ({}), users: () => [], reachable: () => ({ telegramOwnerId: OWNER }) });
  privacy.establishBaseline();
  const isOperator = ({ senderKey, userId }: { senderKey: string | null; userId: string | null }) => privacy.isOperator(senderKey) || privacy.isOwnerSender(senderKey, userId);
  const uc = new UserCorpus({ store, rows: tm, isOperator, machine: 'm_unit' });
  const intent = new TopicIntentStore(sd);
  const pending = new PendingConfirmationManager(intent);
  const clock = { now: T0 };
  const sw = { on: true };
  const ledger = new AnchorLedger({ store, intent, pending, rows: tm, machine: 'm_unit', now: () => clock.now, backfilling: (t) => uc.backfilling(t), backfill: () => sw.on });
  const at = (mid: number) => new Date(T0 + mid * 1000).toISOString();
  const say = (messageId: number, text: string, o: { fromUser?: boolean; sender?: number; pass?: boolean } = {}) => {
    const fromUser = o.fromUser ?? true;
    tm.insertMessage({ messageId, topicId: T, text, fromUser, timestamp: at(messageId), sessionName: null, forwarded: false, ...(fromUser ? { telegramUserId: o.sender ?? OWNER } : {}) });
    uc.refresh(T, { messageId });
    if (fromUser) intent.bumpTurn(T);
    if (o.pass !== false) ledger.afterTurn(T, { messageId, fromUser });
  };
  const stub = (messageId: number, text: string, kind: string, refersTo: number) => uc.acceptStub(T, messageId, text, { stub: '[about: the agent message before]', kind, refersTo: String(refersTo) });
  const ref = (refId: string, kind: RefKind, messageId: number, fromUser: boolean, text = `prop ${refId}`) =>
    intent.appendEvidence(T, refId, buildEvent(refId, fromUser ? 'extract-user' : 'extract-agent', String(messageId), { at: at(messageId) }), { kind, text, arcId: `arc-${T}` });
  const ev = (refId: string, kind: EvidenceKind, messageId: number) => intent.appendEvidence(T, refId, buildEvent(refId, kind, String(messageId), { at: at(messageId) }));
  const entry = (type: 'evolution' | 'decision', refId: string) => store.read(String(T), 'ledger-entry', ledgerKeyFor(type, refId));
  const anchor = () => store.read(String(T), 'anchor', 'current');
  const briefing = () => renderTopicIntentBriefing(intent, T).text;
  return { sd, tm, store, uc, intent, pending, ledger, clock, sw, say, stub, ref, ev, entry, anchor, briefing };
}

const FRAME = 'We are designing the fold gate for the pilot; it must keep my decisions.';
const ANSWER = 'Block. Warnings get ignored every time.';

/** An existing topic: history written while no ledger ran (the topic predates the layers). */
async function history() {
  const s = await setup();
  s.say(1, FRAME, { pass: false });
  s.say(2, 'Should the gate block or warn?', { fromUser: false, pass: false });
  s.say(3, ANSWER, { pass: false });
  s.stub(3, ANSWER, 'answer', 2);
  s.ref('d1', 'decision', 3, true, 'the gate blocks');
  s.say(4, 'I propose we also log every block to the audit file.', { fromUser: false, pass: false });
  s.ref('d2', 'decision', 4, false, 'log every block');
  s.say(5, 'Also cover the dashboard card in this topic.', { pass: false });
  s.ref('g1', 'goal', 5, true, 'the topic also covers the dashboard card');
  return s;
}

describe('ledger backfill (switch on)', () => {
  it('rebuilds A and G from history: operator entries backfilled-unconfirmed with their derivation kept, other history refs left out, one backfill confirmation queued and no evolution confirmation', async () => {
    const s = await history();
    const r = s.ledger.backfillTopic(T, { historyThroughMessageId: 5 });
    expect(r).toMatchObject({ ran: true, anchor: 'anchored', entries: 2, backfilledUnconfirmed: 2, boundWritten: true });
    expect(s.anchor()).toMatchObject({ status: 'anchored', data: { messageIds: [1], historyThroughMessageId: 5, ledgerFromMessageId: null } });
    expect(typeof s.anchor()!.data.backfilledAt).toBe('number');
    expect(s.entry('decision', 'd1')).toMatchObject({ status: 'backfilled-unconfirmed', data: { backfillDerivedStatus: 'derived-settled', fromHistory: true, boundMessageId: 3, statusBasis: 'backfilled:derived-settled' } });
    expect(s.entry('evolution', 'g1')).toMatchObject({ status: 'backfilled-unconfirmed', data: { backfillDerivedStatus: 'tentative', cause: 'user-directed', predatesLedger: true } });
    // §15's validator: an agent-proposed history decision is not a backfilled entry.
    expect(s.entry('decision', 'd2')).toBeNull();
    expect(s.ledger.status().counters.backfill).toMatchObject({ skippedNotOperator: 1, entriesBackfilled: 2, confirmRequested: 1, topics: 1 });
    const p = s.intent.read(T).pending;
    expect(p.outstanding).toMatchObject({ kind: 'backfill', refId: backfillRefId(T), sentAtTurn: 3 });
    expect(p.queue).toHaveLength(0);
    expect(p.outstanding!.propositionText).toContain('the gate blocks');
    // The view and the metrics read it from the store (what the card and Home count).
    expect(backfillView(s.store, String(T))).toMatchObject({ state: 'backfilled', backfilledUnconfirmed: 2, confirmation: 'pending', historyThroughMessageId: 5 });
    expect(measureAnchorLedger(s.store, String(T)).backfill).toEqual({ state: 'backfilled', backfilledUnconfirmed: 2, confirmation: 'pending' });
    const view = anchorLedgerView(s.store, String(T), s.intent.read(T));
    expect(view.pending).toMatchObject({ outstanding: { kind: 'backfill', awaitingUserActivity: true }, queued: { backfill: 0 } });
    expect(view.entries.find((e) => e.key === 'dc-d1')).toMatchObject({ status: 'backfilled-unconfirmed', backfillDerivedStatus: 'derived-settled' });
    // A second run is a no-op (no second confirmation, no second count).
    s.ledger.backfillTopic(T, { historyThroughMessageId: 5 });
    expect(s.ledger.status().counters.backfill).toMatchObject({ confirmRequested: 1, topics: 1 });
  });

  it('the confirmation is asked only inside a reply after user activity since the backfill — never before, and an agent message alone never surfaces it', async () => {
    const s = await history();
    s.ledger.backfillTopic(T, { historyThroughMessageId: 5 });
    expect(s.briefing()).not.toContain(BLOCK);
    // No user activity since: an agent message (a job send, a proxy line, a reply) neither shows nor surfaces it.
    s.say(6, 'Status: the gate work is still queued.', { fromUser: false });
    expect(s.briefing()).not.toContain(BLOCK);
    expect(s.intent.read(T).pending.outstanding?.surfacedAtTime).toBeUndefined();
    expect(s.anchor()!.data.backfillConfirmSurfacedAt).toBeUndefined();
    // The user writes: the briefing for this turn carries it, folded into the reply.
    s.say(7, 'Carry on with the gate please.');
    expect(s.briefing()).toContain(BLOCK);
    expect(s.briefing()).toContain('never a separate message');
    // The reply after it asks it ONCE: it leaves the queue, so it is never asked again and holds no slot.
    s.say(8, 'On it. I rebuilt this topic from its history; correct me if anything is off.', { fromUser: false });
    expect(s.intent.read(T).pending.outstanding).toBeNull();
    expect(typeof s.anchor()!.data.backfillConfirmSurfacedAt).toBe('number');
    expect(s.ledger.status().counters.backfill.confirmSurfaced).toBe(1);
    s.say(9, 'And the next step?');
    expect(s.briefing()).not.toContain(BLOCK);
    expect(s.intent.read(T).pending.outstanding).toBeNull();
    // Still awaiting the operator's word (the card and Home count it), entries still labelled.
    expect(backfillView(s.store, String(T))).toMatchObject({ confirmation: 'asked', backfilledUnconfirmed: 2 });
    // A ref confirmation is not held behind it.
    expect(s.pending.create({ topicId: T, arcId: `arc-${T}`, refId: 'd2', propositionText: 'p', questionText: 'q', currentUserTurn: 5 }).status).toBe('outstanding');
  });

  it('an operator episode after history gives the entry its normal status; with none left the confirmation settles', async () => {
    const s = await history();
    s.ledger.backfillTopic(T, { historyThroughMessageId: 5 });
    // A HISTORY re-reference does not lift it.
    s.ev('d1', 'user-reref', 5);
    s.ledger.reconcile(T, { force: true });
    expect(s.entry('decision', 'd1')!.status).toBe('backfilled-unconfirmed');
    s.ev('d1', 'user-reref', 9);
    s.say(9, 'Yes, blocking is still what I want.');
    expect(s.entry('decision', 'd1')).toMatchObject({ status: 'settled', data: { statusBasis: 'operator-user-reref' } });
    expect(s.intent.read(T).pending.outstanding?.kind).toBe('backfill');
    s.ev('g1', 'user-affirm', 10);
    s.say(10, 'And yes, the dashboard card belongs here.');
    expect(s.entry('evolution', 'g1')!.status).toBe('confirmed');
    expect(s.intent.read(T).pending.outstanding).toBeNull();
    expect(backfillView(s.store, String(T))).toMatchObject({ backfilledUnconfirmed: 0, confirmation: 'settled' });
    expect(s.ledger.status().counters.backfill.confirmSettled).toBe(1);
  });

  it('a withdrawal still applies to a history entry', async () => {
    const s = await history();
    s.ev('d1', 'contradiction', 9);
    s.say(9, 'No, warn instead of block.', { pass: false });
    s.ledger.backfillTopic(T, { historyThroughMessageId: 5 });
    expect(s.entry('decision', 'd1')!.status).toBe('withdrawn');
  });

  it('asked once: after the 7-day window the question reads expired, the entries stay backfilled-unconfirmed, and it is never asked again', async () => {
    const s = await history();
    s.ledger.backfillTopic(T, { historyThroughMessageId: 5 });
    s.say(7, 'Carry on with the gate please.');
    s.say(8, 'On it.', { fromUser: false });
    expect(backfillView(s.store, String(T), undefined, { now: () => T0 + DAY }).confirmation).toBe('asked');
    s.clock.now = T0 + 8 * DAY;
    s.say(9, 'Any news on the gate?');
    s.say(10, 'Working on it.', { fromUser: false });
    s.say(11, 'Thanks.');
    expect(s.intent.read(T).pending.outstanding).toBeNull();
    expect(s.intent.read(T).pending.queue).toHaveLength(0);
    expect(s.entry('decision', 'd1')!.status).toBe('backfilled-unconfirmed');
    expect(backfillView(s.store, String(T), undefined, { now: () => T0 + 8 * DAY }).confirmation).toBe('expired');
    expect(s.ledger.status().counters.backfill).toMatchObject({ confirmRequested: 1, confirmReRequested: 0, confirmSurfaced: 1 });
  });

  it('only an asserting status is relabelled: a history decision that never settled stays pending; a settled one keeps its live-set floor', async () => {
    const s = await history();
    // An operator row whose stub is a question: evidence, not a decision (§6.2).
    s.say(6, 'Do we need an audit log at all?', { fromUser: false, pass: false });
    s.say(7, 'Maybe, should we?', { pass: false });
    s.stub(7, 'Maybe, should we?', 'question', 6);
    s.ref('d3', 'decision', 7, true, 'maybe an audit log');
    s.ev('d1', 'user-reref', 5);
    s.ledger.backfillTopic(T, { historyThroughMessageId: 7 });
    expect(s.entry('decision', 'd3')).toMatchObject({ status: 'pending', data: { fromHistory: true, backfillDerivedStatus: null } });
    expect(s.intent.read(T).pending.outstanding!.propositionText).not.toContain('maybe an audit log');
    // d1 was settled inside history (re-referenced at 5): labelled, but kept on the floor its derivation earned.
    expect(s.entry('decision', 'd1')).toMatchObject({ status: 'backfilled-unconfirmed', data: { backfillDerivedStatus: 'settled' } });
    const view = anchorLedgerView(s.store, String(T), s.intent.read(T));
    const e1 = view.entries.find((e) => e.key === 'dc-d1')!;
    const sel = selectLiveSet([e1], { phaseArcId: null, arcOf: () => null, reReferencedRecently: () => true });
    expect(sel.floor).toEqual(['dc-d1']);
  });

  it('switching off settles a waiting backfill question, so a rollback leaves no line behind', async () => {
    const s = await history();
    s.ledger.backfillTopic(T, { historyThroughMessageId: 5 });
    expect(s.intent.read(T).pending.outstanding?.kind).toBe('backfill');
    s.sw.on = false;
    s.say(7, 'Carry on with the gate please.');
    expect(s.intent.read(T).pending.outstanding).toBeNull();
    expect(s.briefing()).not.toContain(BLOCK);
  });

  it('a live first pass on an existing topic (no lane) closes S6\'s gap the same way: history entries backfilled-unconfirmed, one confirmation, asked only after a later user message', async () => {
    const s = await history();
    s.say(7, 'Carry on with the gate please.');
    expect(s.anchor()!.data.ledgerFromMessageId).toBe(7);
    expect(s.entry('decision', 'd1')!.status).toBe('backfilled-unconfirmed');
    expect(s.entry('evolution', 'g1')!.status).toBe('backfilled-unconfirmed');
    expect(s.intent.read(T).pending.outstanding).toMatchObject({ kind: 'backfill', sentAtTurn: 4 });
    // The message that triggered the rebuild is not "user activity since".
    expect(s.briefing()).not.toContain(BLOCK);
    s.say(8, 'Working on it.', { fromUser: false });
    expect(s.intent.read(T).pending.outstanding?.surfacedAtTime).toBeUndefined();
    s.say(9, 'Great.');
    expect(s.briefing()).toContain(BLOCK);
    // A live goal after history is a normal evolution with its own confirmation, ahead of the backfill one.
    s.ref('g2', 'goal', 9, true, 'also the export');
    s.ledger.reconcile(T, { force: true });
    expect(s.entry('evolution', 'g2')!.status).toBe('tentative');
    const p = s.intent.read(T).pending;
    expect(p.outstanding).toMatchObject({ kind: 'evolution', refId: 'g2' });
    expect(p.queue[0]).toMatchObject({ kind: 'backfill' });
  });
});

describe('switch off ⇒ S6 behaviour, no work', () => {
  it('backfillTopic does nothing; a live pass derives history entries as S6 did, with no backfill confirmation', async () => {
    const s = await history();
    s.sw.on = false;
    expect(s.ledger.backfillTopic(T, { historyThroughMessageId: 5 })).toEqual({ ran: false, reason: 'switch-off' });
    expect(s.anchor()).toBeNull();
    s.say(7, 'Carry on with the gate please.');
    expect(s.entry('decision', 'd1')).toMatchObject({ status: 'derived-settled' });
    expect(s.entry('decision', 'd1')!.data.fromHistory).toBeUndefined();
    expect(s.entry('decision', 'd2')).toMatchObject({ status: 'pending', data: { statusBasis: 'agent-proposed' } });
    expect(s.entry('evolution', 'g1')).toMatchObject({ status: 'tentative', data: { predatesLedger: true } });
    const p = s.intent.read(T).pending;
    expect(p.outstanding).toBeNull();
    expect(p.queue).toHaveLength(0);
    expect(s.ledger.status().counters.backfill.confirmRequested).toBe(0);
  });
});

describe('PendingConfirmationManager — kind backfill', () => {
  async function pm() {
    const sd = tmp('cl-bf-pm-');
    const intent = new TopicIntentStore(sd);
    intent.appendEvidence(1, 'r1', buildEvent('r1', 'extract-user', '1', {}), { kind: 'fact', text: 'a fact', arcId: 'a' });
    intent.appendEvidence(1, 'e1', buildEvent('e1', 'extract-user', '2', {}), { kind: 'goal', text: 'a goal', arcId: 'a' });
    return { intent, m: new PendingConfirmationManager(intent) };
  }
  const base = { topicId: 1, arcId: 'a', propositionText: 'p', questionText: 'q', currentUserTurn: 0 };

  it('ranks between evolution and ref: it does not displace a ref, an evolution displaces it (surfacing cleared), refs queue behind it', async () => {
    const { intent, m } = await pm();
    expect(m.create({ ...base, refId: 'r1' }).status).toBe('outstanding');
    expect(m.create({ ...base, refId: 'backfill-1', kind: 'backfill' }).status).toBe('queued');
    m.settle(1, 'r1', 'test');
    expect(intent.read(1).pending.outstanding).toMatchObject({ kind: 'backfill' });
    m.markSurfaced(1, { currentUserTurn: 1, afterMessageId: '9' });
    expect(intent.read(1).pending.outstanding?.surfacedAtTime).toBeDefined();
    const r = m.create({ ...base, refId: 'e1', kind: 'evolution' });
    expect(r).toMatchObject({ status: 'outstanding' });
    expect(r.requeuedPendingId).toBeDefined();
    const q = intent.read(1).pending.queue;
    expect(q[0]).toMatchObject({ kind: 'backfill', requeued: 1 });
    expect(q[0].surfacedAtTime).toBeUndefined();
    m.create({ ...base, refId: 'r1' });
    expect(intent.read(1).pending.queue.map((p) => p.kind ?? 'ref')).toEqual(['backfill', 'ref']);
  });

  it('is never dropped at dequeue for naming no ref, and expires only after surfacing plus 7 days and a user turn', async () => {
    const { intent, m } = await pm();
    m.create({ ...base, refId: 'r1' });
    m.create({ ...base, refId: 'backfill-1', kind: 'backfill' });
    m.settle(1, 'r1', 'test', { currentUserTurn: 2 });
    expect(intent.read(1).pending.outstanding).toMatchObject({ kind: 'backfill', sentAtTurn: 2 });
    const t0 = Date.parse('2026-11-10T10:00:00Z');
    expect(m.sweepTtl(1, 50, new Date(t0 + 30 * 86400_000).toISOString())).toBeNull();
    m.markSurfaced(1, { currentUserTurn: 3, afterMessageId: '9', now: new Date(t0).toISOString() });
    expect(m.sweepTtl(1, 3, new Date(t0 + 8 * 86400_000).toISOString())).toBeNull();
    expect(m.sweepTtl(1, 4, new Date(t0 + 6 * 86400_000).toISOString())).toBeNull();
    expect(m.sweepTtl(1, 4, new Date(t0 + 8 * 86400_000).toISOString())).toMatchObject({ kind: 'backfill', status: 'expired' });
  });
});

// ── The lane ────────────────────────────────────────────────────────────────

function laneRig(o: { topics?: number; owner?: (t: number) => boolean | 'unknown'; pagesUntilComplete?: Record<number, number>; fail?: Set<number>; on?: boolean; cap?: number; file?: string } = {}) {
  const file = o.file ?? path.join(tmp('cl-bf-lane-'), 'server-data', 'context-budget-backfill.json');
  const n = o.topics ?? 5;
  // Topic i has last activity at minute i: the highest id is the most recent.
  const topics = Array.from({ length: n }, (_, i) => ({ topicId: 100 + i, lastActivity: new Date(T0 + i * 60_000).toISOString() }));
  const calls = { refresh: [] as number[], backfill: [] as Array<{ topicId: number; h: number | null }> };
  const pages = new Map<number, number>(Object.entries(o.pagesUntilComplete ?? {}).map(([k, v]) => [Number(k), v]));
  const degraded: Array<{ kind: string; topicId?: number }> = [];
  const evidence: string[] = [];
  const sw = { on: o.on ?? true };
  const clock = { now: T0 };
  const make = () => new BackfillLane({
    enabled: () => sw.on,
    topics: () => topics,
    isOwner: o.owner ?? (() => true),
    latestMessageId: (t) => t * 10,
    userCorpus: {
      refresh: (t) => { calls.refresh.push(t); const left = (pages.get(t) ?? 1) - 1; pages.set(t, left); return { complete: left <= 0 }; },
      backfilling: (t) => (pages.get(t) ?? 0) > 0,
    },
    ledger: {
      backfillTopic: (t, x) => {
        calls.backfill.push({ topicId: t, h: x.historyThroughMessageId });
        if (o.fail?.has(t)) throw new Error('disk on fire');
        return { ran: true, anchor: 'anchored', entries: 2, backfilledUnconfirmed: 1 };
      },
    },
    onDegraded: (e) => degraded.push(e),
    onEvidence: (k) => evidence.push(k),
    file,
    now: () => clock.now,
    dailyCap: o.cap,
    yieldFn: async () => {},
  });
  return { make, file, calls, degraded, evidence, sw, clock, topics };
}

describe('BackfillLane', () => {
  it('switch off ⇒ no work: no U page, no ledger call, no state file', async () => {
    const r = laneRig({ on: false });
    const lane = r.make();
    expect(await lane.tick()).toMatchObject({ ran: false, reason: 'switch-off' });
    expect(r.calls.refresh).toEqual([]);
    expect(r.calls.backfill).toEqual([]);
    expect(fs.existsSync(r.file)).toBe(false);
    expect(lane.counters.skippedOff).toBe(1);
  });

  it('the owner rule: one machine owns every topic; a dark pool of several machines cannot tell; a live pool needs this machine on an active record', () => {
    const chk = (o: { live: boolean; many: boolean | 'unknown'; owner: string | null; self?: string | null }) => topicOwnerCheck({ poolPlacementLive: () => o.live, multiMachine: () => o.many, ownerOf: () => o.owner, selfId: () => o.self === undefined ? 'me' : o.self })(1);
    expect(chk({ live: false, many: false, owner: null })).toBe(true);
    expect(chk({ live: false, many: true, owner: 'me' })).toBe('unknown');
    expect(chk({ live: false, many: 'unknown', owner: 'me' })).toBe('unknown');
    expect(chk({ live: true, many: true, owner: 'me' })).toBe(true);
    expect(chk({ live: true, many: true, owner: 'other' })).toBe(false);
    expect(chk({ live: true, many: true, owner: null })).toBe('unknown');
    expect(chk({ live: true, many: true, owner: 'me', self: null })).toBe('unknown');
    expect(topicOwnerCheck({ poolPlacementLive: () => true, multiMachine: () => true, ownerOf: () => { throw new Error('x'); }, selfId: () => 'me' })(1)).toBe('unknown');
  });

  it('a topic whose U listing never finishes is parked as stalled and reported, so it cannot hold the lane; resume ticks are not failures', async () => {
    const r = laneRig({ topics: 3, pagesUntilComplete: { 102: 1_000_000 } });
    const lane = r.make();
    for (let i = 0; i < BACKFILL_MAX_TICKS_PER_TOPIC + 2; i++) await lane.tick();
    expect(lane.topicRecord(102)).toMatchObject({ status: 'failed', attempts: 0, ticks: BACKFILL_MAX_TICKS_PER_TOPIC });
    expect(r.degraded.filter((d) => d.kind === 'topic-stalled')).toHaveLength(1);
    expect(lane.topicRecord(101)).toMatchObject({ status: 'done' });
    expect(lane.topicRecord(100)).toMatchObject({ status: 'done' });
  });

  it('a topic with an Anchor only (no refs in its history) is an outcome, not a fired row; a missing Anchor record is retried, never recorded done', async () => {
    const r = laneRig({ topics: 1 });
    let mode: 'none' | 'anchor-only' | 'full' = 'none';
    const lane = new BackfillLane({
      enabled: () => true, topics: () => r.topics.slice(0, 1), isOwner: () => true, latestMessageId: () => 1,
      userCorpus: { refresh: () => ({ complete: true }), backfilling: () => false },
      ledger: { backfillTopic: () => (mode === 'none' ? { ran: true, anchor: 'not-yet-evaluated', entries: 0, backfilledUnconfirmed: 0 } : { ran: true, anchor: 'anchored', entries: 0, backfilledUnconfirmed: 0 }) },
      onEvidence: (k) => r.evidence.push(k), file: r.file, now: () => T0, yieldFn: async () => {},
    });
    await lane.tick();
    expect(lane.topicRecord(100)).toMatchObject({ status: 'in-progress', attempts: 1, lastError: 'anchor record not written' });
    mode = 'anchor-only';
    await lane.tick();
    expect(lane.topicRecord(100)).toMatchObject({ status: 'done' });
    expect(r.evidence).toEqual(['error', 'outcome']);
  });

  it('works topics in recency order (newest first), a few per tick, binding history at the latest message', async () => {
    const r = laneRig({ topics: 5 });
    const lane = r.make();
    await lane.tick();
    await lane.tick();
    await lane.tick();
    expect(r.calls.backfill.map((c) => c.topicId)).toEqual([104, 103, 102, 101, 100]);
    expect(r.calls.backfill[0].h).toBe(1040);
    expect(r.evidence.filter((k) => k === 'fired')).toHaveLength(5);
    expect(lane.status()).toMatchObject({ topics: { done: 5, inProgress: 0, failed: 0 }, startedToday: 5 });
    // Done topics are never redone.
    await lane.tick();
    expect(r.calls.backfill).toHaveLength(5);
  });

  it('owner only: a topic another machine owns, or whose owner is unknown, is skipped and counted apart', async () => {
    const r = laneRig({ topics: 3, owner: (t) => (t === 102 ? false : t === 101 ? 'unknown' : true) });
    const lane = r.make();
    await lane.tick();
    expect(r.calls.backfill.map((c) => c.topicId)).toEqual([100]);
    expect(r.calls.refresh).toEqual([100]);
    expect(lane.counters).toMatchObject({ skippedNotOwner: 1, skippedOwnerUnknown: 1 });
    expect(lane.topicRecord(102)).toBeNull();
  });

  it('at most the daily cap of topics a day; the next UTC day continues', async () => {
    const r = laneRig({ topics: BACKFILL_DAILY_TOPIC_CAP + 5 });
    const lane = r.make();
    for (let i = 0; i < 20; i++) await lane.tick();
    expect(r.calls.backfill).toHaveLength(BACKFILL_DAILY_TOPIC_CAP);
    expect(lane.status()).toMatchObject({ capReachedToday: true, startedToday: BACKFILL_DAILY_TOPIC_CAP });
    expect(lane.counters.capReached).toBeGreaterThan(0);
    r.clock.now = T0 + DAY;
    for (let i = 0; i < 5; i++) await lane.tick();
    expect(r.calls.backfill).toHaveLength(BACKFILL_DAILY_TOPIC_CAP + 5);
    expect(lane.status()).toMatchObject({ startedToday: 5, capReachedToday: false });
  });

  it('resumes after a restart: a topic cut off mid-U continues first, counted once against the cap, nothing done is redone', async () => {
    const r = laneRig({ topics: 3, pagesUntilComplete: { 102: 8 }, cap: 2 });
    const first = r.make();
    await first.tick();
    // 102 (newest) needed more U pages than one tick lists; 101 finished.
    expect(first.topicRecord(102)).toMatchObject({ status: 'in-progress', attempts: 0, ticks: 1, historyThroughMessageId: 1020 });
    expect(first.topicRecord(101)).toMatchObject({ status: 'done' });
    // A restart: a new lane over the same file.
    const second = r.make();
    expect(second.topicRecord(102)).toMatchObject({ status: 'in-progress' });
    await second.tick();
    expect(second.topicRecord(102)).toMatchObject({ status: 'done', attempts: 0, ticks: 2, historyThroughMessageId: 1020 });
    expect(r.calls.backfill.map((c) => c.topicId)).toEqual([101, 102]);
    // The cap (2) was spent by 102 and 101 together; 100 waits for tomorrow, even after the resume.
    await second.tick();
    expect(second.topicRecord(100)).toBeNull();
    expect(second.counters.capReached).toBeGreaterThan(0);
  });

  it('a topic that keeps failing is parked as failed after the attempt limit and reported once; others proceed', async () => {
    const r = laneRig({ topics: 2, fail: new Set([101]) });
    const lane = r.make();
    for (let i = 0; i < BACKFILL_MAX_ATTEMPTS + 2; i++) await lane.tick();
    expect(lane.topicRecord(101)).toMatchObject({ status: 'failed', attempts: BACKFILL_MAX_ATTEMPTS, lastError: 'disk on fire' });
    expect(lane.topicRecord(100)).toMatchObject({ status: 'done' });
    expect(r.degraded.filter((d) => d.kind === 'topic-failed')).toEqual([{ kind: 'topic-failed', topicId: 101, reason: 'disk on fire' }]);
    expect(r.evidence.filter((k) => k === 'error')).toHaveLength(BACKFILL_MAX_ATTEMPTS);
  });

  it('an unreadable state file restarts the bookkeeping loudly (every step is safe to redo)', async () => {
    const r = laneRig({ topics: 1 });
    fs.mkdirSync(path.dirname(r.file), { recursive: true });
    fs.writeFileSync(r.file, '{not json');
    const lane = r.make();
    await lane.tick();
    expect(lane.counters.stateUnreadable).toBe(1);
    expect(r.degraded[0]).toMatchObject({ kind: 'state-unreadable' });
    expect(lane.topicRecord(100)).toMatchObject({ status: 'done' });
  });
});
