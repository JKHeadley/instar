// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * Unit — A and G, the Anchor and the decisions/evolutions ledger
 * (context-budget-layered-summaries §6.1, §6.2, decisions 3 and 15, §12).
 *
 * Real TopicMemory, real LayerStore, real U (UserCorpus) with real MemoryPrivacy
 * for the operator binding, real TopicIntentStore and the real (extended)
 * PendingConfirmationManager. Both sides of every decision boundary:
 *  - Anchor: greeting skipped / first substantive operator row / framing burst
 *    ends at the agent's reply / forwarded and third-party rows ignored /
 *    no-anchor, then anchored when the operator frames it; row refs only.
 *  - Decision transition: answer and directive settle (derived-settled); every
 *    other stub kind, no stub, an agent proposal and a third-party row stay
 *    pending; a later operator episode promotes to settled, a third party's
 *    does not; supersedes only when the superseder is settled and post-dates.
 *  - Evolutions: none before an Anchor or from the framing itself; cause and
 *    effect; confirmation rules per cause and effect; surfacing; the 7-day
 *    clock from surfacing that needs a user message since; expiry ⇒
 *    unconfirmed (user-directed) or expired (insight-derived); never deleted.
 *  - Live-set selection order.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { LayerStore, rowRefMatches } from '../../src/monitoring/contextLayers/LayerStore.js';
import { UserCorpus } from '../../src/monitoring/contextLayers/userCorpus.js';
import {
  AnchorLedger, isGreeting, isFramingCandidate, selectLiveSet, anchorLedgerView, ledgerKeyFor, MAX_FRAMING_ROWS,
  type LedgerEntryView,
} from '../../src/monitoring/contextLayers/anchorLedger.js';
import { TopicIntentStore, buildEvent, type EvidenceKind, type RefKind } from '../../src/core/TopicIntent.js';
import { PendingConfirmationManager } from '../../src/core/TopicIntentPendingConfirm.js';
import { MemoryPrivacy } from '../../src/users/MemoryPrivacy.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/context-layer-anchor-ledger.test.ts';
const T = 5151;
const OWNER = 111;
const DAY = 24 * 3600_000;
const T0 = Date.UTC(2026, 10, 10, 10, 0, 0);

describe('A and G — the Anchor and the ledger', () => {
  const dirs: string[] = [];
  const mems: TopicMemory[] = [];
  afterEach(() => {
    for (const m of mems.splice(0)) { try { m.close(); } catch { /* best-effort */ } }
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
  });

  async function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-al-')); dirs.push(root);
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
    const bf = { forced: null as boolean | null };
    const ledger = new AnchorLedger({ store, intent, pending, rows: tm, machine: 'm_unit', now: () => clock.now, backfilling: (t) => bf.forced ?? uc.backfilling(t) });
    const at = (mid: number) => new Date(T0 + mid * 1000).toISOString();
    /** A message row, listed into U, then the ledger's per-turn pass (as captureTurn calls it). */
    const say = (messageId: number, text: string, o: { fromUser?: boolean; sender?: number; forwarded?: boolean; pass?: boolean } = {}) => {
      const fromUser = o.fromUser ?? true;
      tm.insertMessage({ messageId, topicId: T, text, fromUser, timestamp: at(messageId), sessionName: null, forwarded: o.forwarded ?? false, ...(fromUser ? { telegramUserId: o.sender ?? OWNER } : {}) });
      uc.refresh(T, { messageId });
      // captureTurn counts every user turn before any gate (the clock's "user message since").
      if (fromUser) intent.bumpTurn(T);
      if (o.pass !== false) ledger.afterTurn(T, { messageId, fromUser });
    };
    /** The referent stub the extractor's call would have returned for an operator row. */
    const stub = (messageId: number, text: string, kind: string, refersTo: number) => uc.acceptStub(T, messageId, text, { stub: '[about: the agent message before]', kind, refersTo: String(refersTo) });
    /** A ref the extractor created from a message (the evidence model's origin event). */
    const ref = (refId: string, kind: RefKind, messageId: number, fromUser: boolean, text = `prop ${refId}`) =>
      intent.appendEvidence(T, refId, buildEvent(refId, fromUser ? 'extract-user' : 'extract-agent', String(messageId), { at: at(messageId) }), { kind, text, arcId: `arc-${T}` });
    const ev = (refId: string, kind: EvidenceKind, messageId: number) => intent.appendEvidence(T, refId, buildEvent(refId, kind, String(messageId), { at: at(messageId) }));
    const entry = (type: 'evolution' | 'decision', refId: string) => store.read(String(T), 'ledger-entry', ledgerKeyFor(type, refId));
    const pass = (messageId: number, fromUser: boolean) => ledger.afterTurn(T, { messageId, fromUser });
    return { sd, tm, store, uc, intent, pending, ledger, clock, say, stub, ref, ev, entry, pass, privacy, bf };
  }

  describe('Anchor selection', () => {
    it('greetings are not framing; substance is', () => {
      for (const g of ['hey', 'Hi!', 'good morning Echo', 'hey there', 'hello echo!', '👋', 'thanks']) expect(isFramingCandidate(g)).toBe(false);
      for (const s of ['hey, build the deploy gate for the pilot', 'We need the fold gate to block, not warn.', 'Fix the flaky CI job on main']) expect(isFramingCandidate(s)).toBe(true);
      expect(isGreeting('hey echo')).toBe(true);
      expect(isGreeting('hey can you look at the build')).toBe(false);
    });

    it('skips an opening greeting, anchors the first substantive operator row, and stores row references only', async () => {
      const s = await setup();
      s.say(1, 'hey');
      expect(s.store.read(String(T), 'anchor', 'current')?.status).toBe('no-anchor');
      const words = 'Build the fold gate so a context fold never loses my decisions.';
      s.say(2, words);
      const a = s.store.read(String(T), 'anchor', 'current')!;
      expect(a.status).toBe('anchored');
      expect(a.rows!.map((r) => r.messageId)).toEqual([2]);
      expect(rowRefMatches(a.rows![0], words)).toBe(true);
      expect(a.data).toMatchObject({ messageIds: [2], skippedGreetings: 1 });
      expect(JSON.stringify(a)).not.toContain('fold gate');
    });

    it('a framing burst before the agent replies joins the Anchor; a row after the reply does not', async () => {
      const s = await setup();
      s.say(1, 'We are building the fold gate for the pilot topic.');
      s.say(2, 'It must keep every decision I make verbatim.');
      s.say(3, 'Understood, starting with the ledger.', { fromUser: false });
      s.say(4, 'Also make the dashboard card show it.');
      expect(s.store.read(String(T), 'anchor', 'current')!.rows!.map((r) => r.messageId)).toEqual([1, 2]);
    });

    it('the burst is bounded', async () => {
      const s = await setup();
      for (let i = 1; i <= MAX_FRAMING_ROWS + 2; i++) s.say(i, `Framing point number ${i} for this topic.`);
      expect(s.store.read(String(T), 'anchor', 'current')!.rows).toHaveLength(MAX_FRAMING_ROWS);
    });

    it('forwarded and third-party rows never anchor; a topic without an operator frame is no-anchor until one arrives', async () => {
      const s = await setup();
      s.say(1, 'Forwarded: here is what the team wants built.', { forwarded: true });
      s.say(2, 'Someone else: please build the export feature.', { sender: 999 });
      s.say(3, 'I will look into the export.', { fromUser: false });
      const na = s.store.read(String(T), 'anchor', 'current')!;
      expect(na.status).toBe('no-anchor');
      expect(na.rows).toEqual([]);
      s.say(4, 'The topic is the export feature, scoped to CSV only.');
      expect(s.store.read(String(T), 'anchor', 'current')!.rows!.map((r) => r.messageId)).toEqual([4]);
    });
  });

  describe('Decision transition (§6.2)', () => {
    async function decisionRig(kind: string | null, opts: { sender?: number } = {}) {
      const s = await setup();
      s.say(1, 'Design the gate for the context fold pilot.');
      s.say(2, 'Should the gate block or warn?', { fromUser: false });
      const text = 'Make it block. Warnings get ignored every time.';
      s.say(3, text, { pass: false, ...(opts.sender ? { sender: opts.sender } : {}) });
      if (kind) s.stub(3, text, kind, 2);
      s.ref('ref-d1', 'decision', 3, true);
      s.pass(3, true);
      return s;
    }

    it('answer and directive settle as derived-settled, bound to the operator row', async () => {
      for (const k of ['answer', 'directive']) {
        const s = await decisionRig(k);
        const e = s.entry('decision', 'ref-d1')!;
        expect(e.status).toBe('derived-settled');
        expect(e.data).toMatchObject({ type: 'decision', boundMessageId: 3, stubKind: k, statusBasis: `stub-kind:${k}` });
        expect(e.rows!.map((r) => r.messageId)).toEqual([3]);
        expect(JSON.stringify(e)).not.toContain('Warnings');
      }
    });

    it('question, hypothetical, rejection and other stay pending; so does a row with no stub', async () => {
      for (const k of ['question', 'hypothetical', 'rejection', 'other']) {
        const s = await decisionRig(k);
        expect(s.entry('decision', 'ref-d1')).toMatchObject({ status: 'pending', data: { statusBasis: `stub-kind:${k}` } });
      }
      const s = await decisionRig(null);
      expect(s.entry('decision', 'ref-d1')).toMatchObject({ status: 'pending', data: { statusBasis: 'no-stub' } });
    });

    it('an agent proposal and a third party\'s row are pending, never bound', async () => {
      const s = await decisionRig('answer', { sender: 999 });
      expect(s.entry('decision', 'ref-d1')).toMatchObject({ status: 'pending', rows: [], data: { statusBasis: 'not-an-operator-row', boundMessageId: null } });
      s.say(4, 'I propose we warn for the first week.', { fromUser: false, pass: false });
      s.ref('ref-d2', 'decision', 4, false);
      s.pass(4, false);
      expect(s.entry('decision', 'ref-d2')).toMatchObject({ status: 'pending', data: { statusBasis: 'agent-proposed', agentProposed: true, evidenceMessageIds: [4] } });
    });

    it('a later operator episode promotes derived-settled to settled; a third party\'s does not', async () => {
      const s = await decisionRig('answer');
      s.say(4, 'Anyone else agree with blocking?', { sender: 999, pass: false });
      s.ev('ref-d1', 'user-affirm', 4);
      s.pass(4, true);
      expect(s.entry('decision', 'ref-d1')!.status).toBe('derived-settled');
      s.say(5, 'Yes, blocking stays, as I said.', { pass: false });
      s.ev('ref-d1', 'user-reref', 5);
      s.pass(5, true);
      expect(s.entry('decision', 'ref-d1')).toMatchObject({ status: 'settled', data: { statusBasis: 'operator-user-reref' } });
    });

    it('supersedes: a later settled decision supersedes the one it contradicts; a pending one does not', async () => {
      const s = await decisionRig('answer');
      s.say(4, 'Shall I keep blocking?', { fromUser: false });
      const t5 = 'Change of plan: warn for a week, then block.';
      s.say(5, t5, { pass: false });
      s.stub(5, t5, 'directive', 4);
      s.ref('ref-d2', 'decision', 5, true);
      s.ev('ref-d1', 'contradiction', 5);
      s.pass(5, true);
      expect(s.entry('decision', 'ref-d2')).toMatchObject({ status: 'derived-settled', data: { supersedes: ledgerKeyFor('decision', 'ref-d1'), postDatesSuperseded: true } });
      expect(s.entry('decision', 'ref-d1')).toMatchObject({ status: 'superseded', data: { supersededBy: ledgerKeyFor('decision', 'ref-d2') } });

      const p = await decisionRig('answer');
      p.say(4, 'Any thoughts?', { fromUser: false });
      const t = 'What if we warned instead?';
      p.say(5, t, { pass: false });
      p.stub(5, t, 'hypothetical', 4);
      p.ref('ref-d2', 'decision', 5, true);
      p.ev('ref-d1', 'contradiction', 5);
      p.pass(5, true);
      expect(p.entry('decision', 'ref-d2')!.status).toBe('pending');
      // Not superseded by a pending proposal; the operator's contradiction withdraws it instead.
      expect(p.entry('decision', 'ref-d1')).toMatchObject({ status: 'withdrawn', data: { supersededBy: null } });
    });
  });

  describe('Decision supersession ordering (§6.2: the row must post-date what it supersedes)', () => {
    it('both written in one pass: the later settled decision supersedes the earlier at once', async () => {
      const s = await setup();
      s.say(1, 'Design the gate for the context fold pilot.');
      s.say(2, 'Block or warn?', { fromUser: false });
      const a = 'Block it.';
      s.say(3, a, { pass: false }); s.stub(3, a, 'answer', 2); s.ref('ref-a', 'decision', 3, true);
      s.say(4, 'Sure?', { fromUser: false, pass: false });
      const b = 'No: warn first, block next week.';
      s.say(5, b, { pass: false }); s.stub(5, b, 'directive', 4); s.ref('ref-b', 'decision', 5, true); s.ev('ref-a', 'contradiction', 5);
      s.pass(5, true);
      expect(s.entry('decision', 'ref-b')!.status).toBe('derived-settled');
      expect(s.entry('decision', 'ref-a')!.status).toBe('superseded');
    });

    it('a row that does not post-date the entry it names cannot settle and supersedes nothing', async () => {
      const s = await setup();
      s.say(1, 'Design the gate for the context fold pilot.');
      s.say(2, 'Block or warn?', { fromUser: false });
      const early = 'Warn, for now.';
      s.say(3, early, { pass: false }); s.stub(3, early, 'answer', 2);
      s.say(4, 'Noted.', { fromUser: false, pass: false });
      const late = 'Block, definitely.';
      s.say(5, late, { pass: false }); s.stub(5, late, 'answer', 4);
      // The extractor (out of order) attributes to the EARLIER row a contradiction of the LATER row's decision.
      s.ref('ref-late', 'decision', 5, true);
      s.ref('ref-early', 'decision', 3, true);
      s.ev('ref-late', 'contradiction', 3);
      s.pass(5, true);
      expect(s.entry('decision', 'ref-early')).toMatchObject({ status: 'pending', data: { statusBasis: 'does-not-post-date-superseded', postDatesSuperseded: false } });
      expect(s.entry('decision', 'ref-late')!.data.supersededBy).toBeNull();
    });
  });

  describe('Evolutions (§6.1)', () => {
    async function anchored() {
      const s = await setup();
      s.say(1, 'Build the fold gate for the pilot topic.', { pass: false });
      s.ref('ref-g0', 'goal', 1, true, 'build the fold gate');
      s.pass(1, true);
      // The agent's first reply closes the framing burst: later operator rows are evolutions, not framing.
      s.say(2, 'On it.', { fromUser: false });
      return s;
    }

    it('none before an Anchor, and the framing\'s own goal is not an evolution', async () => {
      const s = await setup();
      s.say(2, 'I will draft a plan.', { fromUser: false, pass: false });
      s.ref('ref-ga', 'goal', 2, false);
      s.pass(2, false);
      expect(s.entry('evolution', 'ref-ga')).toBeNull();
      expect(s.ledger.counters.evolutionsSkipped['no-anchor']).toBeGreaterThan(0);
      const a = await anchored();
      expect(a.entry('evolution', 'ref-g0')).toBeNull();
      expect(a.ledger.counters.evolutionsSkipped.framing).toBeGreaterThan(0);
    });

    it('a user-directed additive change is tentative, bound to its row, and requests a confirmation of kind evolution', async () => {
      const s = await anchored();
      s.say(3, 'Also cover the dashboard card in this topic.', { pass: false });
      s.ref('ref-g1', 'goal', 3, true);
      s.pass(3, true);
      const e = s.entry('evolution', 'ref-g1')!;
      expect(e.status).toBe('tentative');
      expect(e.data).toMatchObject({ cause: 'user-directed', effect: 'additive', effectBasis: 'extractor-no-contradiction', boundMessageId: 3, pendingRequested: true });
      expect(e.rows!.map((r) => r.messageId)).toEqual([3]);
      expect(s.intent.read(T).pending.outstanding).toMatchObject({ kind: 'evolution', refId: 'ref-g1' });
    });

    it('narrowing is the extractor\'s contradiction read, logged with its evidence; additive when none', async () => {
      const s = await anchored();
      s.say(3, 'Forget the gate; just measure the token cost for now.', { pass: false });
      s.ref('ref-g1', 'goal', 3, true);
      s.ev('ref-g0', 'contradiction', 3);
      s.pass(3, true);
      const e = s.entry('evolution', 'ref-g1')!;
      expect(e.data).toMatchObject({ effect: 'narrowing', effectBasis: 'extractor-contradiction' });
      expect((e.data.effectEvidence as string[]).length).toBe(1);
      expect(s.ledger.counters.effectSignals.narrowing).toBe(1);
    });

    it('user-directed: a re-reference confirms (and settles the confirmation); silence does not', async () => {
      const s = await anchored();
      s.say(3, 'Also cover the dashboard card in this topic.', { pass: false });
      s.ref('ref-g1', 'goal', 3, true);
      s.pass(3, true);
      s.clock.now += 30 * DAY;
      s.say(4, 'Working on it.', { fromUser: false });
      s.say(5, 'Unrelated: what time is it?');
      expect(s.entry('evolution', 'ref-g1')!.status).not.toBe('confirmed');
      s.say(6, 'And remember the dashboard card is part of this.', { pass: false });
      s.ev('ref-g1', 'user-reref', 6);
      s.pass(6, true);
      expect(s.entry('evolution', 'ref-g1')).toMatchObject({ status: 'confirmed', data: { statusBasis: 'operator-user-reref' } });
      expect(s.intent.read(T).pending.outstanding).toBeNull();
    });

    it('insight-derived: held as narrowing; an affirmation counts only after it was surfaced', async () => {
      const s = await anchored();
      s.say(3, 'I think the topic is really about the ledger.', { fromUser: false, pass: false });
      s.ref('ref-g2', 'goal', 3, false);
      s.pass(3, false);
      const e = s.entry('evolution', 'ref-g2')!;
      expect(e.data).toMatchObject({ cause: 'insight-derived', effect: 'narrowing', effectBasis: 'unread-held-as-narrowing', evidenceMessageIds: [3], boundMessageId: null });
      expect(e.rows).toEqual([]);
      // The message that created it never counts as surfacing it.
      expect(s.intent.read(T).pending.outstanding?.surfacedAtTime).toBeUndefined();
      // An affirmation before surfacing: not confirmation of a narrowing insight.
      s.say(4, 'Sure, the ledger.', { pass: false });
      s.ev('ref-g2', 'user-affirm', 4);
      s.pass(4, true);
      expect(s.entry('evolution', 'ref-g2')!.status).toBe('tentative');
      // The next natural agent reply surfaces it.
      s.clock.now = T0 + 10_000;
      s.say(5, 'Noted: should the topic now be about the ledger?', { fromUser: false });
      expect(s.entry('evolution', 'ref-g2')!.data.surfacedAfterMessageId).toBe(5);
      s.clock.now = T0 + 11_000;
      s.say(12, 'Yes, the ledger.', { pass: false });
      s.ev('ref-g2', 'user-affirm', 12);
      s.pass(12, true);
      expect(s.entry('evolution', 'ref-g2')!.status).toBe('confirmed');
    });

    it('an automated agent message never surfaces an evolution', async () => {
      const s = await anchored();
      s.say(3, 'Also cover the dashboard card.', { pass: false });
      s.ref('ref-g1', 'goal', 3, true);
      s.pass(3, true);
      s.tm.insertMessage({ messageId: 4, topicId: T, text: 'Job report: 3 builds passed.', fromUser: false, timestamp: new Date(T0 + 4000).toISOString(), sessionName: null });
      s.ledger.afterTurn(T, { messageId: 4, fromUser: false, automated: true });
      expect(s.intent.read(T).pending.outstanding?.surfacedAtTime).toBeUndefined();
    });

    it('expiry: never before surfacing; from surfacing it needs 7 days AND a user message; user-directed ⇒ unconfirmed, never deleted', async () => {
      const s = await anchored();
      s.say(3, 'Also cover the dashboard card.', { pass: false });
      s.ref('ref-g1', 'goal', 3, true);
      s.pass(3, true);
      // 30 days with only operator chatter and no agent reply: never surfaced, never expires.
      s.clock.now = T0 + 30 * DAY;
      s.say(4, 'Still thinking about the plan.');
      expect(s.entry('evolution', 'ref-g1')!.status).toBe('tentative');
      // Surfaced now.
      s.say(5, 'Shall the card be part of this topic?', { fromUser: false });
      const surfacedAt = s.entry('evolution', 'ref-g1')!.data.surfacedAt as number;
      expect(surfacedAt).toBe(T0 + 30 * DAY);
      // 8 days later but no user message since surfacing: still tentative (an agent turn sweeps).
      s.clock.now = surfacedAt + 8 * DAY;
      s.say(6, 'Still here.', { fromUser: false });
      expect(s.entry('evolution', 'ref-g1')!.status).toBe('tentative');
      // A user message since, 7 days past: the confirmation expires; the user's own words stay in force as unconfirmed.
      s.say(7, 'Something else entirely.');
      const e = s.entry('evolution', 'ref-g1')!;
      expect(e.status).toBe('unconfirmed');
      expect(e.data.pendingExpiredAt).toBe(surfacedAt + 8 * DAY);
      expect(s.intent.read(T).pending.outstanding).toBeNull();
      expect(s.store.list(String(T), 'ledger-entry')).toHaveLength(1);
    });

    it('expiry: a user message within 7 days does not expire it; an insight-derived entry lapses to expired', async () => {
      const s = await anchored();
      s.say(3, 'The topic may really be about cost.', { fromUser: false, pass: false });
      s.ref('ref-g2', 'goal', 3, false);
      s.pass(3, false);
      s.say(4, 'Hm.');
      s.say(5, 'Should the topic be about cost now?', { fromUser: false });
      expect(s.entry('evolution', 'ref-g2')!.data.surfacedAfterMessageId).toBe(5);
      s.clock.now = T0 + 6 * DAY;
      s.say(6, 'Let me think.');
      expect(s.entry('evolution', 'ref-g2')!.status).toBe('tentative');
      s.clock.now = T0 + 7 * DAY + 5_000;
      s.say(7, 'Still thinking.');
      expect(s.entry('evolution', 'ref-g2')).toMatchObject({ status: 'expired', data: { statusBasis: 'confirmation-expired' } });
    });

    it('an operator contradiction withdraws an evolution; a later one that names it supersedes it', async () => {
      const s = await anchored();
      s.say(3, 'Also cover the dashboard card.', { pass: false });
      s.ref('ref-g1', 'goal', 3, true);
      s.pass(3, true);
      s.say(4, 'Drop the card; do the Home count instead.', { pass: false });
      s.ref('ref-g3', 'goal', 4, true);
      s.ev('ref-g1', 'contradiction', 4);
      s.pass(4, true);
      expect(s.entry('evolution', 'ref-g1')).toMatchObject({ status: 'superseded', data: { supersededBy: ledgerKeyFor('evolution', 'ref-g3') } });
      expect(s.entry('evolution', 'ref-g3')).toMatchObject({ status: 'tentative', data: { effect: 'narrowing', supersedes: ledgerKeyFor('evolution', 'ref-g1') } });
      s.say(5, 'Actually no, forget the Home count.', { pass: false });
      s.ev('ref-g3', 'contradiction', 5);
      s.pass(5, true);
      expect(s.entry('evolution', 'ref-g3')!.status).toBe('withdrawn');
    });
  });


  describe('Review fixes: operator standing, lost confirmations, surfacing, the affirmation cap, Anchor re-selection', () => {
    async function anchored() {
      const s = await setup();
      s.say(1, 'Build the fold gate for the pilot topic.', { pass: false });
      s.ref('ref-g0', 'goal', 1, true, 'build the fold gate');
      s.pass(1, true);
      s.say(2, 'On it.', { fromUser: false });
      return s;
    }

    it('a third party\'s or a forwarded row\'s new goal never supersedes the operator\'s confirmed evolution; the operator\'s own does', async () => {
      for (const who of [{ sender: 999 }, { forwarded: true }]) {
        const s = await anchored();
        s.say(3, 'Also cover the dashboard card.', { pass: false });
        s.ref('ref-g1', 'goal', 3, true);
        s.pass(3, true);
        s.say(4, 'Yes, the card is in.', { pass: false });
        s.ev('ref-g1', 'user-affirm', 4);
        s.pass(4, true);
        expect(s.entry('evolution', 'ref-g1')!.status).toBe('confirmed');
        s.say(5, 'Drop the card, do something else.', { pass: false, ...who });
        s.ref('ref-gx', 'goal', 5, true);
        s.ev('ref-g1', 'contradiction', 5);
        s.pass(5, true);
        expect(s.entry('evolution', 'ref-g1')).toMatchObject({ status: 'confirmed', data: { supersededBy: null } });
        // Recorded as a signal only, held to the strict rule.
        expect(s.entry('evolution', 'ref-gx')).toMatchObject({ status: 'tentative', data: { cause: 'insight-derived', effect: 'narrowing', supersedes: ledgerKeyFor('evolution', 'ref-g1') } });
      }
    });

    it('an insight-derived entry from a non-operator user row is held as narrowing even with no contradiction', async () => {
      const s = await anchored();
      s.say(3, 'Someone else: the topic should include exports too.', { sender: 999, pass: false });
      s.ref('ref-g1', 'goal', 3, true);
      s.pass(3, true);
      expect(s.entry('evolution', 'ref-g1')!.data).toMatchObject({ cause: 'insight-derived', effect: 'narrowing', effectBasis: 'unread-held-as-narrowing' });
    });

    it('a lost confirmation is requested again while the entry is tentative', async () => {
      const s = await anchored();
      s.say(3, 'Also cover the dashboard card.', { pass: false });
      s.ref('ref-g1', 'goal', 3, true);
      s.pass(3, true);
      s.pending.cancelOutstanding(T);
      expect(s.intent.read(T).pending.outstanding).toBeNull();
      s.say(4, 'Carry on.', { fromUser: false });
      expect(s.intent.read(T).pending.outstanding).toMatchObject({ kind: 'evolution', refId: 'ref-g1' });
      expect(s.ledger.counters.pendingReRequested).toBe(1);
      // Nothing it reads moved: the next pass is skipped (a full pass still runs every 20 turns).
      const skipped = s.ledger.counters.reconcileSkipped;
      s.ledger.reconcile(T);
      expect(s.ledger.counters.reconcileSkipped).toBe(skipped + 1);
      expect(s.ledger.reconcile(T, { force: true }).skipped).toBeUndefined();
    });

    it('the reply to the message that created an evolution does not surface it; the next reply after a user turn does', async () => {
      const s = await anchored();
      s.say(3, 'Also cover the dashboard card.', { pass: false });
      s.ref('ref-g1', 'goal', 3, true);
      s.pass(3, true);
      s.say(4, 'Okay, adding the card.', { fromUser: false });
      expect(s.entry('evolution', 'ref-g1')!.data.surfacedAt).toBeNull();
      s.say(5, 'Thanks.');
      s.say(6, 'By the way: the card is now part of this topic. Confirm?', { fromUser: false });
      expect(s.entry('evolution', 'ref-g1')!.data.surfacedAfterMessageId).toBe(6);
    });

    it('one operator "yes" confirms at most three entries (v14\'s per-message affirmation cap)', async () => {
      const s = await anchored();
      for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) {
        s.say(3 + i * 2, `Also cover part ${id} of the work.`, { pass: false });
        s.ref(`ref-${id}`, 'goal', 3 + i * 2, true);
        s.pass(3 + i * 2, true);
        s.say(4 + i * 2, 'Noted.', { fromUser: false });
      }
      s.say(20, 'Yes to all of those.', { pass: false });
      for (const id of ['a', 'b', 'c', 'd']) s.ev(`ref-${id}`, 'user-affirm', 20);
      s.pass(20, true);
      const statuses = ['a', 'b', 'c', 'd'].map((id) => s.entry('evolution', `ref-${id}`)!.status);
      expect(statuses.filter((x) => x === 'confirmed')).toHaveLength(3);
      expect(statuses.filter((x) => x === 'tentative')).toHaveLength(1);
    });

    it('an existing topic: goals from before the ledger started are listed as history, with no confirmation requested; a new one asks', async () => {
      const s = await setup();
      s.say(1, 'Build the fold gate for the pilot topic.', { pass: false });
      s.say(2, 'On it.', { fromUser: false, pass: false });
      s.say(3, 'Also cover the dashboard card.', { pass: false });
      s.ref('ref-old', 'goal', 3, true);
      // The layers are switched on: the first pass runs on message 4.
      s.say(4, 'How is it going?');
      expect(s.store.read(String(T), 'anchor', 'current')!.data).toMatchObject({ messageIds: [1], ledgerFromMessageId: 4 });
      expect(s.entry('evolution', 'ref-old')).toMatchObject({ status: 'tentative', data: { predatesLedger: true, pendingRequested: false } });
      expect(s.intent.read(T).pending.outstanding).toBeNull();
      s.say(5, 'Good progress.', { fromUser: false });
      s.say(6, 'Also add the Home count.', { pass: false });
      s.ref('ref-new', 'goal', 6, true);
      s.pass(6, true);
      expect(s.entry('evolution', 'ref-new')!.data.predatesLedger).toBe(false);
      expect(s.intent.read(T).pending.outstanding?.refId).toBe('ref-new');
    });

    it('the surfacing clock starts at the reply\'s own time, not when capture ran', async () => {
      const s = await anchored();
      s.say(3, 'Also cover the dashboard card.', { pass: false });
      s.ref('ref-g1', 'goal', 3, true);
      s.pass(3, true);
      s.say(4, 'Thanks.');
      s.clock.now = T0 + 60_000;
      s.tm.insertMessage({ messageId: 5, topicId: T, text: 'The card is now part of this topic. Confirm?', fromUser: false, timestamp: new Date(T0 + 5000).toISOString(), sessionName: null });
      s.ledger.afterTurn(T, { messageId: 5, fromUser: false, timestamp: T0 + 5000 });
      expect(s.entry('evolution', 'ref-g1')!.data.surfacedAt).toBe(T0 + 5000);
    });

    it('while U is backfilling the Anchor is re-selected when an earlier operator row is listed', async () => {
      const s = await setup();
      const early = 'The topic: migrate the build to the new runner.';
      s.tm.insertMessage({ messageId: 1, topicId: T, text: early, fromUser: true, timestamp: new Date(T0 + 1000).toISOString(), sessionName: null, forwarded: false, telegramUserId: OWNER });
      s.uc.refresh(T, { messageId: 1 });
      s.say(2, 'Also check the cache keys while you are at it.', { pass: false });
      // U has not listed the earlier row yet (an existing topic at rollout).
      s.store.remove(String(T), 'u', 'm-1');
      s.bf.forced = true;
      s.pass(2, true);
      expect(s.store.read(String(T), 'anchor', 'current')!.data.messageIds).toEqual([2]);
      s.uc.refresh(T, { messageId: 1 });
      s.pass(2, true);
      expect(s.store.read(String(T), 'anchor', 'current')!.data).toMatchObject({ messageIds: [1, 2], reanchored: true });
      // Backfill done: one last re-select, then the Anchor is left alone.
      s.bf.forced = false;
      s.pass(2, true);
      expect(s.store.read(String(T), 'anchor', 'current')!.data.messageIds).toEqual([1, 2]);
    });
  });

  describe('Live-set selection (§6.2)', () => {
    const e = (key: string, status: string, at: number, tokens = 100, extra: Partial<LedgerEntryView> = {}): LedgerEntryView => ({
      key, type: 'decision', status, statusBasis: null, cause: null, effect: null, effectBasis: null, effectEvidence: 0,
      refId: key, boundMessageId: null, evidenceMessageIds: [], stubKind: null, supersedes: null, supersededBy: null,
      surfacedAt: null, pendingExpiredAt: null, at, tokens, ...extra,
    });

    it('archives superseded/withdrawn/expired and unconfirmed-and-superseded first; keeps the floor even over budget; age is last', () => {
      const entries = [
        e('sup', 'superseded', 100), e('wd', 'withdrawn', 99), e('exp', 'expired', 98),
        e('unc-sup', 'unconfirmed', 97, 100, { supersededBy: 'x' }), e('unc', 'unconfirmed', 96),
        e('old-settled-phase', 'settled', 1, 2_000), e('old-confirmed-reref', 'confirmed', 2, 2_000),
        e('derived-in-phase', 'derived-settled', 3, 100),
        e('new-pending', 'pending', 90, 100), e('mid-pending', 'pending', 50, 100),
      ];
      const r = selectLiveSet(entries, {
        phaseArcId: 'arc-2',
        arcOf: (id) => (id === 'old-settled-phase' || id === 'derived-in-phase' ? 'arc-2' : 'arc-1'),
        reReferencedRecently: (id) => id === 'old-confirmed-reref',
        budgetTokens: 4_150,
      });
      expect(r.archived.filter((a) => a.reason === 'status').map((a) => a.key).sort()).toEqual(['exp', 'sup', 'unc-sup', 'wd']);
      expect(r.floor.sort()).toEqual(['old-confirmed-reref', 'old-settled-phase']);
      // derived-settled is NOT in the floor even in the current phase.
      expect(r.floor).not.toContain('derived-in-phase');
      // After the 4,000-token floor, 150 tokens remain: only the newest of the rest fits.
      expect(r.live).toEqual(['old-settled-phase', 'old-confirmed-reref', 'unc']);
      expect(r.archived.filter((a) => a.reason === 'age').map((a) => a.key)).toEqual(['new-pending', 'mid-pending', 'derived-in-phase']);
      const tight = selectLiveSet(entries, { phaseArcId: 'arc-2', arcOf: () => 'arc-2', reReferencedRecently: () => true, budgetTokens: 1_000 });
      expect(tight.floor).toEqual(expect.arrayContaining(['old-settled-phase', 'old-confirmed-reref']));
      expect(tight.overBudget).toBe(true);
    });

    it('the route view carries statuses and row references, never the words', async () => {
      const s = await setup();
      const words = 'Ship the ledger first, the card second, nothing else.';
      s.say(1, words);
      s.say(2, 'Order of work?', { fromUser: false });
      const t = 'Ledger first.';
      s.say(3, t, { pass: false });
      s.stub(3, t, 'answer', 2);
      s.ref('ref-d1', 'decision', 3, true);
      s.pass(3, true);
      const v = anchorLedgerView(s.store, String(T), s.intent.read(T));
      expect(v.anchor).toMatchObject({ status: 'anchored', rows: [{ messageId: 1, length: words.length }] });
      expect(v.counts.byStatus['derived-settled']).toBe(1);
      expect(v.entries[0]).toMatchObject({ type: 'decision', status: 'derived-settled', boundMessageId: 3, live: true });
      const json = JSON.stringify(v);
      expect(json).not.toContain('Ship the ledger');
      expect(json).not.toContain('Ledger first');
    });
  });
});
