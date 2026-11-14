/**
 * Work Board store (docs/specs/work-board-asks.md §3–§6) — the pure half: schema, the fold,
 * the material hash, approval, finishing, lanes and pickup derivation. Both sides of every
 * decision boundary are covered, and the order tests prove arrival order cannot change a view.
 */
import { describe, it, expect } from 'vitest';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import {
  workCardRecordStoreSchema, buildRecord, toFoldRecords, foldCard, deriveStatus, laneFor, derivePickupCauses, foldPickups,
  partitionRecords, materialHashOf, cardConversationKey, tapActionLine, WORK_CARD_KIND_REGISTRATION, workBoardEnabled,
  type UnionEntry, type By, type FoldRecord,
} from '../../src/core/WorkCardStore.js';

const ID = 'wc_0123456789abcdef';
const T0 = Date.parse('2026-11-12T20:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const ctx = () => ({ countDroppedField: () => {}, countJailReject: () => {} }) as never;
const AGENT: By = { kind: 'agent' };
const OWNER: By = { kind: 'person', personKey: 'justin', proof: 'pin' };
const SYS: By = { kind: 'system' };

let tick = 0;
function rec(type: Parameters<typeof buildRecord>[0], fields: Record<string, unknown>, opts: { node?: string; at?: number; cardId?: string | null } = {}): UnionEntry {
  tick++;
  const at = opts.at ?? T0 + tick * 1000;
  const h: HlcTimestamp = { physical: at, logical: 0, node: opts.node ?? 'm_a' };
  const cardId = opts.cardId === undefined ? ID : opts.cardId;
  const data = buildRecord(type, cardId, { at: iso(at), ...fields })(h, h.node);
  if (!data) throw new Error('builder null');
  const v = workCardRecordStoreSchema.validate(data, ctx());
  if (!v) throw new Error(`schema rejected ${type}: ${JSON.stringify(data)}`);
  return { data: { ...v, recordKey: data.recordKey, hlc: data.hlc, op: 'put', origin: data.origin }, origin: h.node };
}

const baseCard = { title: 'Pick a venue', need: 'Choose one of three venues', doneWhen: [{ id: 'd1', text: 'Venue booked' }], carrier: 'agent', outward: false };

function fold(entries: UnionEntry[]) {
  const all = toFoldRecords(entries);
  const { byCard, policies } = partitionRecords(all);
  return foldCard(ID, byCard.get(ID) ?? [], policies);
}

describe('registration + gate', () => {
  it('registers the work-card-record kind on the workBoard store', () => {
    expect(WORK_CARD_KIND_REGISTRATION.kind).toBe('work-card-record');
    expect(WORK_CARD_KIND_REGISTRATION.store).toBe('workBoard');
  });
  it('is live on a development agent and dark on the fleet when unset; explicit wins', () => {
    expect(workBoardEnabled({ developmentAgent: true })).toBe(true);
    expect(workBoardEnabled({})).toBe(false);
    expect(workBoardEnabled({ developmentAgent: true, workBoard: { enabled: false } })).toBe(false);
    expect(workBoardEnabled({ workBoard: { enabled: true } })).toBe(true);
  });
  it('derives the same UUID-shaped conversation key from a card id every time', () => {
    const k = cardConversationKey(ID);
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(cardConversationKey(ID)).toBe(k);
    expect(cardConversationKey('wc_fedcba9876543210')).not.toBe(k);
  });
});

describe('schema', () => {
  it('refuses a tap that is not person-proven and dispatch records not written by the system', () => {
    const tap = buildRecord('tap', ID, { at: iso(T0), by: AGENT, action: 'approve', materialHash: 'a'.repeat(64) })({ physical: T0, logical: 0, node: 'm_a' }, 'm_a')!;
    expect(workCardRecordStoreSchema.validate(tap, ctx())).toBeNull();
    const d = buildRecord('dispatching', ID, { at: iso(T0), by: AGENT, for: `wc:${ID}:created`, attempt: 1, machineId: 'm_a' })({ physical: T0, logical: 0, node: 'm_a' }, 'm_a')!;
    expect(workCardRecordStoreSchema.validate(d, ctx())).toBeNull();
    const ok = buildRecord('dispatching', ID, { at: iso(T0), by: SYS, for: `wc:${ID}:created`, attempt: 1, machineId: 'm_a' })({ physical: T0, logical: 0, node: 'm_a' }, 'm_a')!;
    expect(workCardRecordStoreSchema.validate(ok, ctx())).not.toBeNull();
  });
  it('refuses a policy record from the agent and accepts one from a person', () => {
    const bad = buildRecord('policy', null, { at: iso(T0), by: AGENT, policy: 'outward-only' })({ physical: T0, logical: 0, node: 'm_a' }, 'm_a')!;
    expect(workCardRecordStoreSchema.validate(bad, ctx())).toBeNull();
    const good = buildRecord('policy', null, { at: iso(T0), by: OWNER, policy: 'outward-only' })({ physical: T0, logical: 0, node: 'm_a' }, 'm_a')!;
    expect(workCardRecordStoreSchema.validate(good, ctx())).not.toBeNull();
  });
  it('accepts only https web links and attachment links with a sha256', () => {
    const mk = (links: unknown) => buildRecord('created', ID, { at: iso(T0), by: AGENT, ...baseCard, links })({ physical: T0, logical: 0, node: 'm_a' }, 'm_a')!;
    expect(workCardRecordStoreSchema.validate(mk([{ label: 'x', url: 'http://example.com' }]), ctx())).toBeNull();
    expect(workCardRecordStoreSchema.validate(mk([{ label: 'x', url: 'https://example.com/a' }]), ctx())).not.toBeNull();
    expect(workCardRecordStoreSchema.validate(mk([{ label: 'f', attachmentId: 'att1' }]), ctx())).toBeNull();
    expect(workCardRecordStoreSchema.validate(mk([{ label: 'f', attachmentId: 'att1', sha256: 'b'.repeat(64) }]), ctx())).not.toBeNull();
  });
  it('requires at least one done item', () => {
    const r = buildRecord('created', ID, { at: iso(T0), by: AGENT, ...baseCard, doneWhen: [] })({ physical: T0, logical: 0, node: 'm_a' }, 'm_a')!;
    expect(workCardRecordStoreSchema.validate(r, ctx())).toBeNull();
  });
  it('defaults certify to owner-confirms', () => {
    const f = fold([rec('created', { by: AGENT, ...baseCard })]);
    expect(f.doneWhen[0].certify).toBe('owner-confirms');
  });
});

describe('approval (§4)', () => {
  it('an agent-written card needs approval; an approve tap on the current hash satisfies it', () => {
    const c = rec('created', { by: AGENT, ...baseCard });
    const f0 = fold([c]);
    expect(f0.approvalRequired).toBe(true);
    expect(f0.approvalValid).toBe(false);
    expect(f0.workable).toBe(false);
    const a = rec('tap', { by: OWNER, action: 'approve', materialHash: f0.materialHash });
    const f1 = fold([c, a]);
    expect(f1.approvalValid).toBe(true);
    expect(f1.workable).toBe(true);
  });
  it('an approve tap on a stale hash does not count', () => {
    const c = rec('created', { by: AGENT, ...baseCard });
    const f = fold([c, rec('tap', { by: OWNER, action: 'approve', materialHash: 'f'.repeat(64) })]);
    expect(f.approvalValid).toBe(false);
  });
  it('a card the owner wrote in full needs no approval; after an agent edit it does', () => {
    const c = rec('created', { by: OWNER, ...baseCard });
    expect(fold([c]).approvalRequired).toBe(false);
    expect(fold([c]).workable).toBe(true);
    const e = rec('edited', { by: AGENT, need: 'Changed by the agent' });
    expect(fold([c, e]).approvalRequired).toBe(true);
  });
  it('the owner fixing one field of an agent-written card still leaves approval required', () => {
    const c = rec('created', { by: AGENT, ...baseCard });
    const e = rec('edited', { by: OWNER, title: 'Pick a venue (fixed)' });
    const f = fold([c, e]);
    expect(f.lastWriter.title).toBe('person');
    expect(f.lastWriter.need).toBe('agent');
    expect(f.approvalRequired).toBe(true);
  });
  it('a whole-form edit that changes one value moves only that field\'s last writer', () => {
    const c = rec('created', { by: AGENT, ...baseCard });
    const e = rec('edited', { by: OWNER, ...baseCard, title: 'New title' });
    const f = fold([c, e]);
    expect(f.lastWriter.title).toBe('person');
    expect(f.lastWriter.need).toBe('agent');
    expect(f.lastMaterialChangeFields).toEqual(['title']);
  });
  it('an outward card always needs its own approve tap, even when the owner wrote it', () => {
    const c = rec('created', { by: OWNER, ...baseCard, outward: true });
    expect(fold([c]).approvalRequired).toBe(true);
  });
  it('a material edit after approval voids it, and editing back never revives it', () => {
    const c = rec('created', { by: AGENT, ...baseCard });
    const h = fold([c]).materialHash;
    const a = rec('tap', { by: OWNER, action: 'approve', materialHash: h });
    const e1 = rec('edited', { by: AGENT, need: 'Different' });
    const e2 = rec('edited', { by: AGENT, need: baseCard.need });
    const f = fold([c, a, e1, e2]);
    expect(f.materialHash).toBe(h);
    expect(f.approvalValid).toBe(false);
  });
  it('a non-material edit does not void approval', () => {
    const c = rec('created', { by: AGENT, ...baseCard });
    const a = rec('tap', { by: OWNER, action: 'approve', materialHash: fold([c]).materialHash });
    const e = rec('edited', { by: AGENT, recommendation: 'Venue B' });
    expect(fold([c, a, e]).approvalValid).toBe(true);
  });
  it('withdraw-approval requires approval even on a person-written card, until a later approve', () => {
    const c = rec('created', { by: OWNER, ...baseCard });
    const w = rec('tap', { by: OWNER, action: 'withdraw-approval' });
    const f = fold([c, w]);
    expect(f.approvalRequired).toBe(true);
    expect(f.approvalValid).toBe(false);
    const a = rec('tap', { by: OWNER, action: 'approve', materialHash: f.materialHash });
    expect(fold([c, w, a]).approvalValid).toBe(true);
  });
  it('outward-only lets a non-outward agent card start, but a withdrawal still holds under it', () => {
    const p = rec('policy', { by: OWNER, policy: 'outward-only' }, { cardId: null });
    const c = rec('created', { by: AGENT, ...baseCard });
    expect(fold([p, c]).workable).toBe(true);
    const w = rec('tap', { by: OWNER, action: 'withdraw-approval' });
    expect(fold([p, c, w]).workable).toBe(false);
    const cOut = rec('created', { by: AGENT, ...baseCard, outward: true }, { cardId: 'wc_00000000000000aa' });
    const all = toFoldRecords([p, cOut]);
    const { byCard, policies } = partitionRecords(all);
    expect(foldCard('wc_00000000000000aa', byCard.get('wc_00000000000000aa')!, policies).workable).toBe(false);
  });
  it('concurrent edits of different fields on two machines yield one hash in any order', () => {
    const c = rec('created', { by: AGENT, ...baseCard });
    const ea = rec('edited', { by: AGENT, title: 'A' }, { node: 'm_a', at: T0 + 500_000 });
    const eb = rec('edited', { by: AGENT, need: 'B' }, { node: 'm_b', at: T0 + 500_000 });
    expect(fold([c, ea, eb]).materialHash).toBe(fold([eb, c, ea]).materialHash);
  });
});

describe('restricting taps and releases', () => {
  it('a hold stops work; an unhold naming it releases; an unhold not naming a second hold leaves it held', () => {
    const c = rec('created', { by: OWNER, ...baseCard });
    const h1 = rec('tap', { by: OWNER, action: 'hold' });
    const h2 = rec('tap', { by: OWNER, action: 'hold' }, { node: 'm_b' });
    const u1 = rec('tap', { by: OWNER, action: 'unhold', names: (h1.data.recordKey as string) });
    expect(fold([c, h1]).workable).toBe(false);
    expect(fold([c, h1, u1]).workable).toBe(true);
    expect(fold([c, h1, h2, u1]).holds.length).toBe(1);
    expect(fold([c, u1, h2, h1]).holds.length).toBe(1);
  });
});

describe('finishing (§5)', () => {
  function approvedCard(certify: 'owner-confirms' | 'agent-may-certify') {
    const c = rec('created', { by: AGENT, ...baseCard, doneWhen: [{ id: 'd1', text: 'Venue booked', certify }] });
    const h = fold([c]).materialHash;
    const a = rec('tap', { by: OWNER, action: 'approve', materialHash: h });
    return { c, a, h };
  }
  it('an agent-may-certify card finishes on the agent\'s own evidence', () => {
    const { c, a, h } = approvedCard('agent-may-certify');
    const ev = rec('evidence', { by: AGENT, itemId: 'd1', text: 'Booked, confirmation 123', materialHash: h, reopens: [] });
    const cl = rec('claimed-done', { by: AGENT, materialHash: h, reopens: [], evidenceIds: [ev.data.recordKey] });
    const f = fold([c, a, ev, cl]);
    expect(f.done).toBe(true);
    expect(f.doneByAgentOwnEvidence).toBe(true);
    expect(deriveStatus(f, { pendingOrParked: false, parked: false }, T0, 24)).toBe('done');
  });
  it('an owner-confirms card waits for confirm-done, then finishes', () => {
    const { c, a, h } = approvedCard('owner-confirms');
    const ev = rec('evidence', { by: AGENT, itemId: 'd1', text: 'Booked', materialHash: h, reopens: [] });
    const cl = rec('claimed-done', { by: AGENT, materialHash: h, reopens: [], evidenceIds: [ev.data.recordKey] });
    const f = fold([c, a, ev, cl]);
    expect(f.done).toBe(false);
    expect(deriveStatus(f, { pendingOrParked: false, parked: false }, T0, 24)).toBe('claims-done');
    const conf = rec('tap', { by: OWNER, action: 'confirm-done', claimId: cl.data.recordKey, materialHash: h, reopens: [] });
    expect(fold([c, a, ev, cl, conf]).done).toBe(true);
  });
  it('a claim without evidence for every item does not count', () => {
    const c = rec('created', { by: OWNER, ...baseCard, doneWhen: [{ id: 'd1', text: 'a', certify: 'agent-may-certify' }, { id: 'd2', text: 'b', certify: 'agent-may-certify' }] });
    const h = fold([c]).materialHash;
    const ev = rec('evidence', { by: AGENT, itemId: 'd1', text: 'x', materialHash: h, reopens: [] });
    const cl = rec('claimed-done', { by: AGENT, materialHash: h, reopens: [], evidenceIds: [ev.data.recordKey] });
    expect(fold([c, ev, cl]).done).toBe(false);
  });
  it('a need edit discards evidence and unfinishes a finished card', () => {
    const { c, a, h } = approvedCard('agent-may-certify');
    const ev = rec('evidence', { by: AGENT, itemId: 'd1', text: 'Booked', materialHash: h, reopens: [] });
    const cl = rec('claimed-done', { by: AGENT, materialHash: h, reopens: [], evidenceIds: [ev.data.recordKey] });
    const e = rec('edited', { by: OWNER, need: 'Changed by the owner' });
    const f = fold([c, a, ev, cl, e]);
    expect(f.done).toBe(false);
    expect(f.evidence[0].counts).toBe(false);
  });
  it('a reopen unfinishes the card, and the next finish needs the person\'s sign-off', () => {
    const { c, a, h } = approvedCard('agent-may-certify');
    const ev = rec('evidence', { by: AGENT, itemId: 'd1', text: 'Booked', materialHash: h, reopens: [] });
    const cl = rec('claimed-done', { by: AGENT, materialHash: h, reopens: [], evidenceIds: [ev.data.recordKey] });
    const ro = rec('tap', { by: OWNER, action: 'reopen', claimId: cl.data.recordKey });
    const f1 = fold([c, a, ev, cl, ro]);
    expect(f1.done).toBe(false);
    const rk = ro.data.recordKey as string;
    const ev2 = rec('evidence', { by: AGENT, itemId: 'd1', text: 'Booked again', materialHash: h, reopens: [rk] });
    const cl2 = rec('claimed-done', { by: AGENT, materialHash: h, reopens: [rk], evidenceIds: [ev2.data.recordKey] });
    const f2 = fold([c, a, ev, cl, ro, ev2, cl2]);
    expect(f2.currentClaim).not.toBeNull();
    expect(f2.needsConfirm).toBe(true);
    expect(f2.done).toBe(false);
  });
  it('evidence and a claim written without seeing a remote reopen stop counting when it arrives', () => {
    const { c, a, h } = approvedCard('agent-may-certify');
    const ev = rec('evidence', { by: AGENT, itemId: 'd1', text: 'Booked', materialHash: h, reopens: [] });
    const cl0 = rec('claimed-done', { by: AGENT, materialHash: h, reopens: [], evidenceIds: [ev.data.recordKey] });
    const ro = rec('tap', { by: OWNER, action: 'reopen', claimId: cl0.data.recordKey }, { node: 'm_b' });
    const ev2 = rec('evidence', { by: AGENT, itemId: 'd1', text: 'x', materialHash: h, reopens: [] });
    const cl2 = rec('claimed-done', { by: AGENT, materialHash: h, reopens: [], evidenceIds: [ev2.data.recordKey] });
    expect(fold([c, a, ev, cl0, ro, ev2, cl2]).done).toBe(false);
  });
  it('evidence written after a claim does not join it', () => {
    const c = rec('created', { by: OWNER, ...baseCard, doneWhen: [{ id: 'd1', text: 'a', certify: 'agent-may-certify' }] });
    const h = fold([c]).materialHash;
    const cl = rec('claimed-done', { by: AGENT, materialHash: h, reopens: [], evidenceIds: [`wc:${ID}:v:9999`] });
    const ev = rec('evidence', { by: AGENT, itemId: 'd1', text: 'x', materialHash: h, reopens: [] });
    expect(fold([c, cl, ev]).done).toBe(false);
  });
  it('a held card cannot finish', () => {
    const c = rec('created', { by: OWNER, ...baseCard, doneWhen: [{ id: 'd1', text: 'a', certify: 'agent-may-certify' }] });
    const h = fold([c]).materialHash;
    const hold = rec('tap', { by: OWNER, action: 'hold' });
    const ev = rec('evidence', { by: AGENT, itemId: 'd1', text: 'x', materialHash: h, reopens: [] });
    const cl = rec('claimed-done', { by: AGENT, materialHash: h, reopens: [], evidenceIds: [ev.data.recordKey] });
    expect(fold([c, hold, ev, cl]).done).toBe(false);
  });
});

describe('questions', () => {
  it('a second question needs supersedes; the earlier is marked replaced with its reason', () => {
    const c = rec('created', { by: OWNER, ...baseCard });
    const q1 = rec('waiting-on', { by: AGENT, principal: { personKey: 'justin' }, question: { text: 'Which venue?' } });
    // Two machines asking at once (neither names the other): the later one replaces the earlier, visibly,
    // and the card stays readable and workable on both.
    const concurrent = rec('waiting-on', { by: AGENT, principal: { personKey: 'justin' }, question: { text: 'Budget?' } }, { node: 'm_b' });
    const both = fold([c, q1, concurrent]);
    expect(both.unknown).toEqual([]);
    expect(both.questions[0].state).toBe('replaced');
    expect(both.questions[0].reason).toMatch(/same time on another machine/);
    expect(both.openQuestion?.text).toBe('Budget?');
    expect(fold([concurrent, c, q1]).openQuestion?.text).toBe('Budget?');
    const q2 = rec('waiting-on', { by: AGENT, principal: { personKey: 'justin' }, question: { text: 'Budget?' }, supersedes: q1.data.recordKey, reason: 'need budget first' });
    const f = fold([c, q1, q2]);
    expect(f.questions[0].state).toBe('replaced');
    expect(f.questions[0].reason).toBe('need budget first');
    expect(f.openQuestion?.id).toBe(q2.data.recordKey);
  });
  it('an answer closes the open question and hands the card back to the agent', () => {
    const c = rec('created', { by: OWNER, ...baseCard });
    const q = rec('waiting-on', { by: AGENT, principal: { personKey: 'justin' }, question: { text: 'Which?', options: ['A', 'B'] } });
    const ans = rec('tap', { by: OWNER, action: 'answer', questionId: q.data.recordKey, answer: 'A' });
    const f = fold([c, q, ans]);
    expect(f.openQuestion).toBeNull();
    expect(f.waitingOn).toBe('agent');
  });
});

describe('status and lanes', () => {
  it('an agent card older than the quiet window with no pickup is quiet and waits on the owner', () => {
    const c = rec('created', { by: OWNER, ...baseCard }, { at: T0 });
    const f = fold([c]);
    const now = T0 + 25 * 3_600_000;
    const s = deriveStatus(f, { pendingOrParked: false, parked: false }, now, 24);
    expect(s).toBe('quiet');
    expect(laneFor(s, true, f, 'justin')).toBe('waiting-on-you');
    expect(deriveStatus(f, { pendingOrParked: true, parked: false }, now, 24)).toBe('with-agent');
  });
  it('a card carried by the owner sits in Waiting on you', () => {
    const f = fold([rec('created', { by: OWNER, ...baseCard, carrier: { personKey: 'justin' } })]);
    const s = deriveStatus(f, { pendingOrParked: false, parked: false }, T0, 24);
    expect(s).toBe('with-person');
    expect(laneFor(s, true, f, 'justin')).toBe('waiting-on-you');
  });
  it('a non-owner sees a needs-approval card under Waiting on others', () => {
    const f = fold([rec('created', { by: AGENT, ...baseCard })]);
    const s = deriveStatus(f, { pendingOrParked: false, parked: false }, T0, 24);
    expect(laneFor(s, false, f, 'adriana')).toBe('waiting-on-others');
  });
  it('an unreadable record makes the card unknown and not workable', () => {
    const c = rec('created', { by: OWNER, ...baseCard });
    const junk: UnionEntry = { data: { recordKey: `wc:${ID}:t:junk`, hlc: { physical: T0 + 99_000_000, logical: 0, node: 'm_a' }, op: 'put', origin: 'm_a', recordType: 'tap', cardId: ID, by: AGENT, at: iso(T0), action: 'approve' }, origin: 'm_a' };
    const f = fold([c, junk]);
    expect(f.workable).toBe(false);
    expect(deriveStatus(f, { pendingOrParked: false, parked: false }, T0, 24)).toBe('unknown');
  });
  it('a redacted card is removed and drops later agent records', () => {
    const c = rec('created', { by: OWNER, ...baseCard });
    const r = rec('tap', { by: OWNER, action: 'redact' });
    const e = rec('edited', { by: AGENT, title: 'sneaky' });
    const f = fold([c, r, e]);
    expect(deriveStatus(f, { pendingOrParked: false, parked: false }, T0, 24)).toBe('removed');
    expect(f.title).toBe(baseCard.title);
  });
});

describe('pickup causes (§6)', () => {
  function causes(entries: UnionEntry[]) {
    const all = toFoldRecords(entries);
    const { byCard, policies } = partitionRecords(all);
    return derivePickupCauses(ID, byCard.get(ID) ?? [], policies);
  }
  it('approval is a work cause; a hold is a stop; the release is a work cause again', () => {
    const c = rec('created', { by: AGENT, ...baseCard });
    const a = rec('tap', { by: OWNER, action: 'approve', materialHash: fold([c]).materialHash });
    const h = rec('tap', { by: OWNER, action: 'hold' });
    const u = rec('tap', { by: OWNER, action: 'unhold', names: h.data.recordKey });
    expect(causes([c, a, h, u]).map((x) => x.kind)).toEqual(['work', 'stop', 'work']);
  });
  it('a person-written card is a work cause at creation', () => {
    expect(causes([rec('created', { by: OWNER, ...baseCard })]).map((x) => x.kind)).toEqual(['work']);
  });
  it('a policy change that makes a waiting card workable is a work cause', () => {
    const c = rec('created', { by: AGENT, ...baseCard });
    const p = rec('policy', { by: OWNER, policy: 'outward-only' }, { cardId: null });
    expect(causes([c, p]).map((x) => x.kind)).toEqual(['work']);
  });
  it('restore from the archive is a work cause', () => {
    const c = rec('created', { by: OWNER, ...baseCard });
    const ar = rec('tap', { by: OWNER, action: 'archive' });
    const un = rec('tap', { by: OWNER, action: 'unarchive', names: ar.data.recordKey });
    expect(causes([c, ar, un]).map((x) => x.kind)).toEqual(['work', 'stop', 'work']);
  });
  it('finishing a card is not a stop cause', () => {
    const c = rec('created', { by: OWNER, ...baseCard, doneWhen: [{ id: 'd1', text: 'a', certify: 'agent-may-certify' }] });
    const h = fold([c]).materialHash;
    const ev = rec('evidence', { by: AGENT, itemId: 'd1', text: 'x', materialHash: h, reopens: [] });
    const cl = rec('claimed-done', { by: AGENT, materialHash: h, reopens: [], evidenceIds: [ev.data.recordKey] });
    expect(causes([c, ev, cl]).map((x) => x.kind)).toEqual(['work']);
  });
  it('an answer on an unapproved card is an answer-only cause', () => {
    const c = rec('created', { by: AGENT, ...baseCard });
    const q = rec('waiting-on', { by: AGENT, principal: { personKey: 'justin' }, question: { text: 'Which?' } });
    const ans = rec('tap', { by: OWNER, action: 'answer', questionId: q.data.recordKey, answer: 'A' });
    const cs = causes([c, q, ans]);
    expect(cs).toHaveLength(1);
    expect(cs[0].kind).toBe('answer');
    expect(cs[0].answerOnly).toBe(true);
  });
  it('an edit replicated after approval that voids it is a stop cause', () => {
    const c = rec('created', { by: AGENT, ...baseCard });
    const a = rec('tap', { by: OWNER, action: 'approve', materialHash: fold([c]).materialHash });
    const late = rec('edited', { by: AGENT, need: 'late change' }, { node: 'm_b' });
    expect(causes([c, a, late]).map((x) => x.kind)).toEqual(['work', 'stop']);
  });
});

describe('pickup state (§6)', () => {
  it('a dispatching with no closing record is uncertain; a park is parked until a retry', () => {
    const c = rec('created', { by: OWNER, ...baseCard });
    const all0 = toFoldRecords([c]);
    const cause = derivePickupCauses(ID, all0, [])[0];
    const d1 = rec('dispatching', { by: SYS, for: cause.id, attempt: 1, machineId: 'm_a' });
    let all = toFoldRecords([c, d1]);
    let st = foldPickups(ID, all, [cause])[0];
    expect(st.uncertain).toBe(true);
    expect(st.status).toBe('pending');
    const park = rec('dispatched', { by: SYS, for: cause.id, outcome: 'parked', reason: 'failure: spawn refused', attempt: 1, machineId: 'm_a' });
    all = toFoldRecords([c, d1, park]);
    st = foldPickups(ID, all, [cause])[0];
    expect(st.status).toBe('parked');
    expect(st.parkKind).toBe('failure');
    const retry = rec('tap', { by: OWNER, action: 'retry', retryOf: park.data.recordKey });
    all = toFoldRecords([c, d1, park, retry]);
    st = foldPickups(ID, all, [cause])[0];
    expect(st.status).toBe('pending');
    expect(st.retriesGranted).toBe(1);
  });
  it('a closing injected record settles the pickup', () => {
    const c = rec('created', { by: OWNER, ...baseCard });
    const cause = derivePickupCauses(ID, toFoldRecords([c]), [])[0];
    const d1 = rec('dispatching', { by: SYS, for: cause.id, attempt: 1, machineId: 'm_a' });
    const x1 = rec('dispatched', { by: SYS, for: cause.id, outcome: 'injected', attempt: 1, machineId: 'm_a' });
    const st = foldPickups(ID, toFoldRecords([c, d1, x1]), [cause])[0];
    expect(st.status).toBe('settled');
    expect(st.uncertain).toBe(false);
  });
});

describe('tap action line', () => {
  it('binds every field the tap covers and changes when any one changes', () => {
    const base = { action: 'approve', cardId: ID, materialHash: 'a'.repeat(64), titleHash: 'b'.repeat(64) };
    const l1 = tapActionLine(base);
    expect(l1).toMatch(/^Work card wc_0123456789abcdef: approve \[[0-9a-f]{64}\]$/);
    expect(tapActionLine({ ...base, materialHash: 'c'.repeat(64) })).not.toBe(l1);
    expect(tapActionLine({ ...base, titleHash: 'c'.repeat(64) })).not.toBe(l1);
  });
  it('material hash is order-independent over object keys', () => {
    const m = { title: 't', need: 'n', doneWhen: [{ id: 'd', text: 'x', certify: 'owner-confirms' as const }], carrier: 'agent' as const, outward: false, links: [] };
    const reordered = { links: [], outward: false, carrier: 'agent' as const, doneWhen: [{ certify: 'owner-confirms' as const, text: 'x', id: 'd' }], need: 'n', title: 't' };
    expect(materialHashOf(m)).toBe(materialHashOf(reordered));
  });
});

// Silence unused-type lint for FoldRecord in some configs.
export type _F = FoldRecord;
