// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * Unit — U, the protected user corpus, and its referent stubs
 * (context-budget-layered-summaries §6 row U, §6.2 `kind`, §6.4, §8, §15).
 *
 * Real TopicMemory, real LayerStore, real MemoryPrivacy for the operator
 * binding. Covers: the deterministic stub validator (multi-line, length,
 * brackets, unknown kind, wrong reference, copied quote); a stub stored beside,
 * never inside, its quote; a hook-injected "user" transcript entry never in U
 * (U comes from rows); forwarded / relay / A2A / third-party rows labelled with
 * no authority; the operator binding; and the switch off ⇒ the extractor
 * prompt, parse and result are byte-identical to the stub-less extractor.
 */
import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { LayerStore, rowRefMatches } from '../../src/monitoring/contextLayers/LayerStore.js';
import {
  UserCorpus, classifyRow, validateReferentStub, stubContainsQuote, measureUserCorpus, userCorpusView, stubFor,
  senderKeyOf, MAX_STUB_CHARS, PASTED_ARTIFACT_CHARS, REFRESH_ROWS,
} from '../../src/monitoring/contextLayers/userCorpus.js';
import {
  buildExtractorPrompt, parseExtractorAnalysis, TopicIntentExtractor, wantsReferentStub, REFERENT_STUB_KINDS,
  type ExtractorInput,
} from '../../src/core/TopicIntentExtractor.js';
import { TopicIntentStore } from '../../src/core/TopicIntent.js';
import { captureTurn } from '../../src/core/TopicIntentCapture.js';
import { MemoryPrivacy } from '../../src/users/MemoryPrivacy.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/context-layer-user-corpus.test.ts';
const T = 4242;
const OWNER = 111;
const ts = (i: number) => new Date(Date.UTC(2026, 10, 10, 10, 0, i)).toISOString();

describe('U — the protected user corpus', () => {
  const dirs: string[] = [];
  const mems: TopicMemory[] = [];
  afterEach(() => {
    for (const m of mems.splice(0)) { try { m.close(); } catch { /* best-effort */ } }
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
  });

  async function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-u-')); dirs.push(root);
    const sd = path.join(root, 'agent'); fs.mkdirSync(sd, { recursive: true });
    const tm = new TopicMemory(sd); await tm.open(); mems.push(tm);
    const store = new LayerStore({ stateDir: sd, liveSecrets: () => [] });
    const privacy = new MemoryPrivacy({ stateDir: sd, instarRoot: root, agentId: 'x', config: () => ({}), users: () => [], reachable: () => ({ telegramOwnerId: OWNER }) });
    privacy.establishBaseline();
    const isOperator = ({ senderKey, userId }: { senderKey: string | null; userId: string | null }) => privacy.isOperator(senderKey) || privacy.isOwnerSender(senderKey, userId);
    const uc = new UserCorpus({ store, rows: tm, isOperator, machine: 'm_unit' });
    let i = 0;
    const row = (messageId: number, text: string, extra: Partial<Parameters<TopicMemory['insertMessage']>[0]> = {}) =>
      tm.insertMessage({ messageId, topicId: T, text, fromUser: true, timestamp: ts(i++), sessionName: null, telegramUserId: OWNER, forwarded: false, ...extra });
    return { sd, tm, store, uc, row, privacy };
  }

  describe('the stub validator', () => {
    const ctx = (precedes: boolean | null = true) => ({ userText: 'Block it. Warnings get ignored in practice.', userMessageId: 20, precedes: () => precedes });
    const good = { stub: '[answering: should the gate block or warn?]', kind: 'answer', refersTo: '10' };

    it('accepts a one-line bracketed stub with a known kind naming a preceding message', () => {
      const v = validateReferentStub(good, ctx());
      expect(v).toEqual({ ok: true, stub: { text: good.stub, kind: 'answer', refersTo: 10 } });
    });
    it('rejects a multi-line stub', () => {
      expect(validateReferentStub({ ...good, stub: '[answering: one\ntwo]' }, ctx())).toEqual({ ok: false, reason: 'multi-line' });
      expect(validateReferentStub({ ...good, stub: '[answering: one two]' }, ctx())).toEqual({ ok: false, reason: 'multi-line' });
    });
    it('rejects a stub over the length bound and one without brackets', () => {
      expect(validateReferentStub({ ...good, stub: `[${'x'.repeat(MAX_STUB_CHARS)}]` }, ctx())).toEqual({ ok: false, reason: 'too-long' });
      expect(validateReferentStub({ ...good, stub: 'answering: should the gate block?' }, ctx())).toEqual({ ok: false, reason: 'not-bracketed' });
    });
    it('rejects a kind outside the enum (including case and prefix mutations)', () => {
      for (const kind of ['decision', 'Answer', 'ANSWER', 'ans', '']) {
        expect(validateReferentStub({ ...good, kind }, ctx())).toEqual({ ok: false, reason: 'unknown-kind' });
      }
      for (const kind of REFERENT_STUB_KINDS) expect(validateReferentStub({ ...good, kind }, ctx()).ok).toBe(true);
    });
    it('rejects a reference that is not an id, is the message itself, or does not precede it', () => {
      expect(validateReferentStub({ ...good, refersTo: 'the last one' }, ctx())).toEqual({ ok: false, reason: 'bad-reference' });
      expect(validateReferentStub({ ...good, refersTo: '20' }, ctx())).toEqual({ ok: false, reason: 'bad-reference' });
      expect(validateReferentStub(good, ctx(false))).toEqual({ ok: false, reason: 'reference-not-preceding' });
      expect(validateReferentStub(good, ctx(null))).toEqual({ ok: false, reason: 'reference-not-preceding' });
    });
    it('rejects a stub that carries the user\'s own sentence', () => {
      expect(validateReferentStub({ ...good, stub: '[answering: block or warn? — warnings get ignored in practice]' }, ctx())).toEqual({ ok: false, reason: 'contains-quote' });
      expect(stubContainsQuote('[answering: which? yes, the second one]', 'Yes, the second one.')).toBe(true);
      // A short reply is not a quote merely because a word recurs.
      expect(stubContainsQuote('[answering: should we block?]', 'block')).toBe(false);
      // Part of a long sentence, with no terminator of its own, is still a copy.
      expect(stubContainsQuote('[answering: gate? — we should make the gate block every request]', 'Honestly I think that we should make the gate block every request that arrives without a token')).toBe(true);
      expect(stubContainsQuote('[answering: should the gate block or warn?]', 'Honestly I think that we should make the gate block every request that arrives without a token')).toBe(false);
    });
    it('rejects no stub at all', () => {
      expect(validateReferentStub(null, ctx())).toEqual({ ok: false, reason: 'none-given' });
    });
  });

  describe('sender rows and labels', () => {
    it('protects the operator\'s own typed rows and labels forwarded, relay, A2A and third-party rows with no authority', async () => {
      const s = await setup();
      s.row(1, 'Please make the gate block, not warn.');
      s.row(2, 'Forwarded from a colleague: try warn first', { forwarded: true });
      s.row(3, 'A relayed message from a peer agent', { origin: 'relay' });
      s.row(4, 'An agent-to-agent mirror', { origin: 'a2a', fromUser: false });
      s.row(5, 'Hi, I am someone else in the group', { telegramUserId: 999 });
      s.row(6, 'The agent replying', { fromUser: false, telegramUserId: undefined });
      s.uc.refresh(T);
      const view = new Map(userCorpusView(s.store, String(T), 100).entries.map((e) => [e.messageId, e]));
      expect(view.get(1)).toMatchObject({ label: 'operator', authority: 'operator' });
      expect(view.get(2)).toMatchObject({ label: 'forwarded', authority: 'none' });
      expect(view.get(3)).toMatchObject({ label: 'relay', authority: 'none' });
      expect(view.get(4)).toMatchObject({ label: 'relay', authority: 'none' });
      expect(view.get(5)).toMatchObject({ label: 'third-party', authority: 'none' });
      expect(view.has(6)).toBe(false); // an agent row is not U
      const m = measureUserCorpus(s.store, String(T));
      expect(m.protected.messages).toBe(1);
      expect(m.agentAuthored).toBe(1); // the agent's own A2A mirror is labelled relay and counted apart
      expect(m.byLabel.forwarded.messages + m.byLabel.relay.messages + m.byLabel['third-party'].messages).toBe(4);
    });

    it('stores row references only: never the words, and each ref matches its row byte for byte', async () => {
      const s = await setup();
      const text = 'Keep the original wording — "naïve" café ✓';
      s.row(1, text);
      s.uc.refresh(T);
      const rec = s.store.read(String(T), 'u', 'm-1')!;
      expect(rowRefMatches(rec.rows![0], text)).toBe(true);
      expect(fs.readFileSync(path.join(s.store.root(), String(T), 'u', 'm-1.json'), 'utf-8')).not.toContain('original wording');
    });

    it('flags a large paste as a whole pasted artifact', async () => {
      const s = await setup();
      s.row(1, 'x'.repeat(PASTED_ARTIFACT_CHARS + 1));
      s.uc.refresh(T);
      expect(s.store.read(String(T), 'u', 'm-1')!.data).toMatchObject({ pastedArtifact: true, pasteHandling: 'whole-until-superseded' });
      expect(measureUserCorpus(s.store, String(T)).pastedArtifacts).toBe(1);
    });

    it('a hook-injected "user" transcript entry is not in U: U comes from rows', async () => {
      const s = await setup();
      s.row(1, 'The real operator message.');
      // A session transcript where the hook output arrived with role "user".
      const transcript = path.join(s.sd, 'session.jsonl');
      fs.writeFileSync(transcript, [
        JSON.stringify({ type: 'user', message: { role: 'user', content: '<system-reminder>SessionStart hook: identity orientation…</system-reminder>' } }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'The real operator message.' } }),
      ].join('\n'));
      s.uc.refresh(T);
      const recs = s.store.list(String(T), 'u');
      expect(recs).toHaveLength(1);
      expect(rowRefMatches(recs[0].rows![0], 'The real operator message.')).toBe(true);
    });

    it('is incremental from a persisted watermark: a restart re-reads nothing', async () => {
      const s = await setup();
      s.row(1, 'first');
      expect(s.uc.refresh(T)).toMatchObject({ written: 1, complete: true });
      expect(s.uc.refresh(T)).toMatchObject({ listed: 0, written: 0 });
      const fresh = new UserCorpus({ store: s.store, rows: s.tm, isOperator: () => true, machine: 'm_unit' });
      expect(fresh.refresh(T)).toMatchObject({ listed: 0, written: 0 });
      s.row(2, 'second');
      expect(fresh.refresh(T)).toMatchObject({ listed: 1, written: 1 });
      // The watermark is its own record type: the `u` listing holds rows only.
      expect(s.store.list(String(T), 'u').map((r) => r.entryKey).sort()).toEqual(['m-1', 'm-2']);
    });

    it('a cold backfill is bounded per refresh; the current message\'s own row is listed first', async () => {
      const s = await setup();
      for (let k = 1; k <= REFRESH_ROWS + 50; k++) s.row(k, `operator line ${k}`);
      const first = s.uc.refresh(T, { messageId: REFRESH_ROWS + 50 });
      expect(first.complete).toBe(false);
      expect(s.uc.backfilling(T)).toBe(true);
      expect(s.store.read(String(T), 'u', `m-${REFRESH_ROWS + 50}`)).not.toBeNull();
      expect(s.store.read(String(T), 'u', `m-${REFRESH_ROWS + 10}`)).toBeNull();
      expect(s.uc.refresh(T).complete).toBe(true);
      expect(s.uc.backfilling(T)).toBe(false);
      expect(measureUserCorpus(s.store, String(T)).protected.messages).toBe(REFRESH_ROWS + 50);
    });

    it('a rebuilt TopicMemory (watermark above every row) is listed again from the start', async () => {
      const s = await setup();
      s.row(1, 'first');
      s.uc.refresh(T);
      s.store.writeProtected(String(T), 'u-mark', 'watermark', [], { author: { sessionId: null, machine: 'm', model: null, kind: 'user' }, asOf: { at: 1, lastMessageId: null } }, { kind: 'watermark', rowId: 999_999 });
      s.row(2, 'second');
      const fresh = new UserCorpus({ store: s.store, rows: s.tm, isOperator: () => true, machine: 'm_unit' });
      expect(fresh.refresh(T)).toMatchObject({ listed: 2, written: 1 });
    });

    it('a failed row write stops the page: the watermark never moves past it, and the next refresh lists it', async () => {
      const s = await setup();
      s.row(1, 'first'); s.row(2, 'second'); s.row(3, 'third');
      let failOn: number | null = 2;
      const real = s.store.writeProtected.bind(s.store);
      const flaky = Object.create(s.store) as LayerStore;
      flaky.writeProtected = (topicKey, type, key, rows, meta, data) => (type === 'u' && failOn !== null && key === `m-${failOn}` ? { written: false, reason: 'write-failed' } : real(topicKey, type, key, rows, meta, data));
      const uc = new UserCorpus({ store: flaky, rows: s.tm, isOperator: () => true, machine: 'm_unit' });
      expect(uc.refresh(T)).toMatchObject({ written: 1, complete: false });
      expect(uc.counters.rowWriteFailed).toBe(1);
      failOn = null;
      // A restart (fresh instance, persisted watermark) still reaches rows 2 and 3.
      const again = new UserCorpus({ store: s.store, rows: s.tm, isOperator: () => true, machine: 'm_unit' });
      expect(again.refresh(T)).toMatchObject({ written: 2, complete: true });
      expect(s.store.list(String(T), 'u').map((r) => r.entryKey).sort()).toEqual(['m-1', 'm-2', 'm-3']);
    });

    it('a changed operator binding re-lists every row, so labels and authority follow it', async () => {
      const s = await setup();
      s.row(1, 'from the operator');
      s.row(2, 'from a colleague', { telegramUserId: 222 });
      let operators = new Set([`telegram:${OWNER}`]);
      const make = () => new UserCorpus({ store: s.store, rows: s.tm, isOperator: ({ senderKey }) => operators.has(senderKey ?? ''), bindingFingerprint: () => [...operators].sort().join(','), machine: 'm_unit' });
      make().refresh(T);
      expect(s.store.read(String(T), 'u', 'm-2')!.data).toMatchObject({ label: 'third-party', authority: 'none' });
      // Same binding: a restart re-reads nothing.
      expect(make().refresh(T)).toMatchObject({ listed: 0 });
      // The binding changes (the colleague turns out to be the operator's second account).
      operators = new Set([`telegram:${OWNER}`, 'telegram:222']);
      const uc = make();
      expect(uc.refresh(T)).toMatchObject({ listed: 2, written: 1 });
      expect(s.store.read(String(T), 'u', 'm-2')!.data).toMatchObject({ label: 'operator', authority: 'operator' });
      expect(uc.refresh(T)).toMatchObject({ listed: 0 });
    });

    it('counts legacy rows with no sender identity as unattributed (third-party, no authority)', async () => {
      const s = await setup();
      s.row(1, 'an old row with nobody on it', { telegramUserId: undefined });
      s.uc.refresh(T);
      expect(s.store.read(String(T), 'u', 'm-1')!.data).toMatchObject({ label: 'third-party', authority: 'none', unattributed: true });
      expect(measureUserCorpus(s.store, String(T)).unattributed).toBe(1);
    });
  });

  describe('the operator binding', () => {
    it('resolves the operator through memory privacy, by Telegram id and by owner profile', async () => {
      const s = await setup();
      expect(classifyRow({ fromUser: true, telegramUserId: OWNER }, ({ senderKey }) => s.privacy.isOperator(senderKey)).label).toBe('operator');
      expect(classifyRow({ fromUser: true, telegramUserId: 999 }, ({ senderKey }) => s.privacy.isOperator(senderKey)).label).toBe('third-party');
      expect(senderKeyOf({ userId: 'justin' })).toBe('user:justin');
      expect(classifyRow({ fromUser: true, userId: 'justin' }, ({ userId }) => userId === 'justin').label).toBe('operator');
    });
    it('memory privacy fingerprints the binding: stable while it holds, different for another operator', async () => {
      const s = await setup();
      const fp = s.privacy.operatorBindingFingerprint();
      expect(fp).toMatch(/^[0-9a-f]{64}$/);
      expect(s.privacy.operatorBindingFingerprint()).toBe(fp);
      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-u-fp-')); dirs.push(other);
      const p2 = new MemoryPrivacy({ stateDir: other, instarRoot: other, agentId: 'y', config: () => ({}), users: () => [], reachable: () => ({ telegramOwnerId: 333 }) });
      p2.establishBaseline();
      expect(p2.operatorBindingFingerprint()).not.toBe(fp);
      // On ONE instance, changing only the configured Telegram owner moves it (isOwnerSender reads that id).
      let owner = 444;
      const p3 = new MemoryPrivacy({ stateDir: other, instarRoot: other, agentId: 'z', config: () => ({}), users: () => [], reachable: () => ({ telegramOwnerId: owner }) });
      const before = p3.operatorBindingFingerprint();
      owner = 555;
      expect(p3.operatorBindingFingerprint()).not.toBe(before);
    });
    it('without a binding no row is protected (every row labelled, none with authority)', () => {
      expect(classifyRow({ fromUser: true, telegramUserId: OWNER })).toEqual({ label: 'third-party', authority: 'none' });
      expect(classifyRow({ fromUser: true, telegramUserId: OWNER }, () => { throw new Error('binding down'); })).toEqual({ label: 'third-party', authority: 'none' });
    });
  });

  describe('referent stubs', () => {
    it('a valid stub is stored beside, never inside, its quote; author derived', async () => {
      const s = await setup();
      s.row(10, 'Should the gate block or warn?', { fromUser: false, telegramUserId: undefined });
      const text = 'Block. Warnings get ignored.';
      s.row(11, text);
      s.uc.refresh(T);
      expect(s.uc.stubCandidates(T, 11)).toEqual([{ messageId: 10, text: 'Should the gate block or warn?' }]);
      const before = fs.readFileSync(path.join(s.store.root(), String(T), 'u', 'm-11.json'), 'utf-8');
      expect(s.uc.acceptStub(T, 11, text, { stub: '[answering: should the gate block or warn?]', kind: 'answer', refersTo: '10' })).toEqual({ written: true });
      // The quote's record is untouched and still matches its row; the stub sits beside it.
      expect(fs.readFileSync(path.join(s.store.root(), String(T), 'u', 'm-11.json'), 'utf-8')).toBe(before);
      expect(rowRefMatches(s.store.read(String(T), 'u', 'm-11')!.rows![0], text)).toBe(true);
      const stub = s.store.read(String(T), 'u-stub', 'm-11')!;
      expect(stub.author.kind).toBe('derived');
      expect(stub.data).toMatchObject({ stub: '[answering: should the gate block or warn?]', kind: 'answer', refersTo: 10, quoteMessageId: 11 });
      expect(JSON.stringify(stub.data)).not.toContain('Warnings get ignored');
      const m = measureUserCorpus(s.store, String(T));
      expect(m.stubs).toMatchObject({ written: 1, operatorRowsWithStub: 1, coverage: 1 });
    });

    it('candidates skip status, heartbeat and proxy lines, so the real question is offered', async () => {
      const s = await setup();
      const agent = { fromUser: false, telegramUserId: undefined };
      s.row(10, 'Should the gate block or warn?', agent);
      s.row(11, '🔭 Echo is actively working on something.', agent);
      s.row(12, '⏳ resumed 2 watchers on this topic.', agent);
      s.row(13, 'Standby: still on it.', agent);
      s.row(14, 'Block.');
      s.uc.refresh(T);
      expect(s.uc.stubCandidates(T, 14)).toEqual([{ messageId: 10, text: 'Should the gate block or warn?' }]);
    });

    it('a stub naming a preceding row that was not offered (the operator\'s own earlier message) is dropped', async () => {
      const s = await setup();
      s.row(9, 'My own earlier note.');
      s.row(10, 'Should the gate block or warn?', { fromUser: false, telegramUserId: undefined });
      s.row(11, 'Block, please.');
      s.uc.refresh(T);
      expect(s.uc.acceptStub(T, 11, 'Block, please.', { stub: '[answering: my earlier note]', kind: 'answer', refersTo: '9' })).toMatchObject({ written: false, reason: 'not-a-candidate' });
    });

    it('stubFor returns a stub only while it belongs to its operator quote; a relabel withdraws it', async () => {
      const s = await setup();
      s.row(10, 'Should the gate block or warn?', { fromUser: false, telegramUserId: undefined });
      s.row(11, 'Block, please.');
      s.uc.refresh(T);
      s.uc.acceptStub(T, 11, 'Block, please.', { stub: '[answering: should the gate block or warn?]', kind: 'answer', refersTo: '10' });
      expect(stubFor(s.store, String(T), 11)).toEqual({ text: '[answering: should the gate block or warn?]', kind: 'answer', refersTo: 10 });
      expect(s.store.read(String(T), 'u-stub', 'm-11')!.data.quoteSha256).toBe(s.store.read(String(T), 'u', 'm-11')!.rows![0].sha256);
      // The binding changes: the row is no longer the operator's. Re-listing it withdraws the stub.
      const rebound = new UserCorpus({ store: s.store, rows: s.tm, isOperator: () => false, machine: 'm_unit' });
      rebound.refresh(T, { messageId: 11 });
      expect(s.store.read(String(T), 'u', 'm-11')!.data.label).toBe('third-party');
      expect(s.store.read(String(T), 'u-stub', 'm-11')).toMatchObject({ status: 'withdrawn', data: { withdrawn: true } });
      expect(stubFor(s.store, String(T), 11)).toBeNull();
      expect(rebound.counters.stubsWithdrawn).toBe(1);
      expect(measureUserCorpus(s.store, String(T)).stubs).toMatchObject({ written: 0, withdrawn: 1, operatorRowsWithStub: 0 });
    });

    it('a rejected stub is counted and dropped; a non-operator row is never offered a stub', async () => {
      const s = await setup();
      s.row(10, 'Which option?', { fromUser: false, telegramUserId: undefined });
      s.row(11, 'The second one, please.');
      s.row(12, 'From someone else', { telegramUserId: 999 });
      s.uc.refresh(T);
      expect(s.uc.acceptStub(T, 11, 'The second one, please.', { stub: '[answering: which option? the second one, please]', kind: 'answer', refersTo: '10' })).toMatchObject({ written: false, reason: 'contains-quote' });
      expect(s.uc.acceptStub(T, 11, 'The second one, please.', { stub: '[answering: which option?]', kind: 'answer', refersTo: '12' })).toMatchObject({ written: false, reason: 'reference-not-preceding' });
      expect(s.store.read(String(T), 'u-stub', 'm-11')).toBeNull();
      expect(s.uc.counters.stubsRejected['contains-quote']).toBe(1);
      expect(s.uc.counters.stubsRejected['reference-not-preceding']).toBe(1);
      expect(s.uc.stubCandidates(T, 12)).toBeNull();
      expect(s.uc.acceptStub(T, 12, 'From someone else', { stub: '[answering: which option?]', kind: 'answer', refersTo: '10' })).toMatchObject({ written: false, reason: 'not-operator' });
    });
  });

  describe('in the capture loop', () => {
    const awarenessOnly = (store: TopicIntentStore) => async (input: ExtractorInput) => {
      const l = (g: string) => ({ goal: g, trend: 'moving', themes: ['gate'] });
      store.updateAwareness(input.topicId, { topic: l('t'), recentArc: l('a'), currentWork: l('c') }, { messageId: input.message.id, messageText: input.message.text, fromUser: input.message.fromUser, at: input.message.at, turn: input.message.turn });
      return { signals: [], ...(input.referentCandidates ? { referentStub: { stub: '[answering: should the gate block or warn?]', kind: 'answer', refersTo: String(input.referentCandidates[0].messageId) } } : {}) };
    };

    it('an operator\'s bare "yes" after an agent question still reaches the same call and gets its stub', async () => {
      const s = await setup();
      const store = new TopicIntentStore(s.sd);
      const seen: ExtractorInput[] = [];
      const fn = awarenessOnly(store);
      const extractor = new TopicIntentExtractor(store, async (i) => { seen.push(i); return fn(i); });
      s.row(10, 'Should the gate block or warn?', { fromUser: false, telegramUserId: undefined });
      s.row(11, 'yes');
      const out = await captureTurn({ extractor, store, userCorpus: s.uc }, { messageId: 11, topicId: T, text: 'yes', fromUser: true });
      expect(out.status).toBe('captured');
      expect(seen).toHaveLength(1);
      expect(stubFor(s.store, String(T), 11)).toMatchObject({ kind: 'answer', refersTo: 10 });
      // A bare ack with no agent message to answer (a fresh topic) is still skipped, counted as no-candidates.
      s.tm.insertMessage({ messageId: 1, topicId: T + 1, text: 'ok', fromUser: true, timestamp: ts(50), sessionName: null, telegramUserId: OWNER, forwarded: false });
      expect((await captureTurn({ extractor, store, userCorpus: s.uc }, { messageId: 1, topicId: T + 1, text: 'ok', fromUser: true })).status).toBe('skipped-prefilter');
      expect(seen).toHaveLength(1);
      expect(s.uc.counters.noStub['no-candidates']).toBe(1);
    });

    it('an operator row skipped by a brake is counted by reason', async () => {
      const s = await setup();
      const store = new TopicIntentStore(s.sd);
      const extractor = new TopicIntentExtractor(store, awarenessOnly(store));
      s.row(10, 'Should the gate block or warn?', { fromUser: false, telegramUserId: undefined });
      s.row(11, 'Block it, the warnings get ignored.');
      expect((await captureTurn({ extractor, store, userCorpus: s.uc, shouldShed: () => true }, { messageId: 11, topicId: T, text: 'Block it, the warnings get ignored.', fromUser: true })).status).toBe('skipped-shed');
      expect(s.uc.counters.noStub['skipped-shed']).toBe(1);
      // The row is in U all the same: U lists every sender row before any gate.
      expect(s.store.read(String(T), 'u', 'm-11')?.data.label).toBe('operator');
    });
  });

  describe('switch off: the extractor is byte-identical to the stub-less one', () => {
    // Pinned from the extractor BEFORE this slice (computed on the base commit).
    const GOLDEN_SYSTEM = 'cb723501c9bd864467ce3c7be26d9be88572be128ee3d850326eeb0ccc82bc24';
    const GOLDEN_USER = 'c381c112a7bf863930f00183c564da4d19fa758831a8cadb4c29e82ae96cb254';
    const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
    const base = { topicId: 42, arcId: 'arc-1', message: { id: '901', text: 'Should the gate block or warn? I think block.', fromUser: true, turn: 3, at: '2026-11-10T10:00:00.000Z' }, existingRefs: [{ refId: 'ref-a', kind: 'decision', text: 'use path B', confidence: 0.8 }], rollingSummary: 'We are designing the gate.' } as unknown as ExtractorInput;

    it('the prompt without candidates matches the pinned pre-slice prompt', () => {
      const p = buildExtractorPrompt(base);
      expect(sha(p.systemPrompt)).toBe(GOLDEN_SYSTEM);
      expect(sha(p.userPrompt)).toBe(GOLDEN_USER);
      // An empty candidate list asks for nothing either.
      const e = buildExtractorPrompt({ ...base, referentCandidates: [] });
      expect(sha(e.systemPrompt)).toBe(GOLDEN_SYSTEM);
      expect(sha(e.userPrompt)).toBe(GOLDEN_USER);
    });

    it('with candidates the same call asks for the stub, rendering the kind enum from its single source', () => {
      const p = buildExtractorPrompt({ ...base, referentCandidates: [{ messageId: 900, text: 'Should the gate block or warn?' }] });
      expect(p.systemPrompt.startsWith(buildExtractorPrompt(base).systemPrompt)).toBe(true);
      for (const k of REFERENT_STUB_KINDS) expect(p.systemPrompt).toContain(`"${k}"`);
      expect(p.userPrompt).toContain('messageId=900');
      // Never for an agent message or a tick.
      expect(wantsReferentStub({ ...base, message: { ...base.message, fromUser: false }, referentCandidates: [{ messageId: 1, text: 'x' }] })).toBe(false);
      expect(wantsReferentStub({ ...base, awarenessOnly: true, referentCandidates: [{ messageId: 1, text: 'x' }] })).toBe(false);
    });

    it('the parse ignores a stub nobody asked for', () => {
      const raw = JSON.stringify({ signals: [], awareness: null, referentStub: { stub: '[x]', kind: 'answer', refersTo: '1' } });
      expect(parseExtractorAnalysis(raw)).toEqual({ signals: [] });
      expect(parseExtractorAnalysis(raw, { referentStub: true })).toEqual({ signals: [], referentStub: { stub: '[x]', kind: 'answer', refersTo: '1' } });
    });

    it('captureTurn without U passes no candidate field and the result carries no stub key', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-u-off-')); dirs.push(root);
      const store = new TopicIntentStore(root);
      const seen: ExtractorInput[] = [];
      const extractor = new TopicIntentExtractor(store, async (input) => { seen.push(input); return { signals: [], referentStub: { stub: '[x]', kind: 'answer', refersTo: '1' } }; });
      const res = await extractor.ingest({ ...base, topicId: T });
      expect('referentStub' in res).toBe(false);
      const out = await captureTurn({ extractor, store }, { messageId: 5, topicId: T, text: 'An ordinary substantive request for the agent', fromUser: true });
      expect(out.status).toBe('captured');
      expect('referentCandidates' in seen[1]).toBe(false);
    });
  });
});
