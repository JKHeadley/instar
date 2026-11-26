/**
 * agent-work-cards-default (docs/specs/agent-work-cards-default.md), slice 1 — the store and the service.
 *
 * Both sides of every decision boundary the slice adds: the ask-fields rule by discriminator, the `outward` default by
 * writer, gate-only fields by principal, request approval from the owner's own sender-verified message (and what ends it),
 * the locked `need`, the two divergence labels, `not-started` and its refusals, the quiet clock and the churn park, the
 * pickup hold, the holder's idempotent records, `refs` and the duplicate hint, and the settings.
 */
import { describe, it, expect } from 'vitest';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { WorkBoardService, resolveWorkBoardSettings, validateSettingsPatch, noteRefusalFor, isAgentWorkInput, JOURNAL_BUCKET_CAPACITY, type WorkPrincipal } from '../../src/core/WorkBoardService.js';
import {
  workCardRecordStoreSchema, foldCard, toFoldRecords, deriveStatus, laneFor, derivePickupCauses, requestCardId, commitmentRefId, requestTextHashOf, normalizeRequestText, cutAtWord,
  SCHEMA_MAX, NOTE_EVENT_PREFIX, QUIET_CLOCK_GRACE_MS, WAITING_STATUSES, WORK_RECORD_TYPES, GENERAL_PROJECT_KEY, isRecordId, type UnionEntry,
} from '../../src/core/WorkCardStore.js';
import { boardJson, cardJson, myBoardReason } from '../../src/core/workBoardViews.js';
import { MAX_STORED_TEXT } from '../../src/core/AppConversationStore.js';

const OWNER: WorkPrincipal = { kind: 'person', personKey: 'justin', proof: 'pin', isOwner: true };
const AGENT: WorkPrincipal = { kind: 'agent' };
const SERVER: WorkPrincipal = { kind: 'agent', server: true };
const SESSION = (ck: string): WorkPrincipal => ({ kind: 'session', conversationKey: ck });

function makeService(over: Record<string, unknown> = {}) {
  const journal: UnionEntry[] = [];
  let clock = Date.parse('2026-11-20T20:00:00Z');
  let logical = 0;
  const settings = resolveWorkBoardSettings(over);
  const svc = new WorkBoardService({
    machineId: 'm_a',
    emit: (_key, build) => {
      const hlc: HlcTimestamp = { physical: clock, logical: logical++, node: 'm_a' };
      const data = build(hlc, 'm_a');
      if (!data) return { outcome: 'skipped' };
      if (!workCardRecordStoreSchema.validate(data, { countDroppedField: () => {} } as never)) return { outcome: 'dropped:invalid' };
      journal.push({ data, origin: 'm_a' });
      return { outcome: 'emitted', seq: journal.length, hlc };
    },
    loadUnion: () => journal, now: () => clock, settings: () => settings, ownerPersonKey: () => 'justin',
    detectCredential: (t) => (/sk-ant-[A-Za-z0-9]{10,}/.test(t) ? 'anthropic-api-key' : null),
    dayOf: (ms) => ({ day: new Date(ms).toISOString().slice(0, 10), resetsAt: new Date(Math.ceil(ms / 86_400_000) * 86_400_000).toISOString() }),
    displayName: (k) => (k === 'justin' ? 'Justin' : k),
  });
  svc.rebuild();
  return { svc, journal, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

const work = { title: 'Fix the venue list', need: 'Tidy it', doneWhen: [{ id: 'd1', text: 'Tidy', certify: 'agent-may-certify' }], outward: false };
const OWNER_TEXT = 'Please fix the venue list before Friday.';
const ownerRequest = (extra: Record<string, unknown> = {}) => ({
  ...work, need: OWNER_TEXT, source: { conversationKey: 'telegram:42', messageId: '1001' },
  requester: { personKey: 'justin', isOwner: true }, requestTextHash: requestTextHashOf(OWNER_TEXT), recordedAsHash: requestTextHashOf(OWNER_TEXT),
  pickupHold: { kind: 'recording-session', conversationKey: 'telegram:42' }, refs: [{ kind: 'commitment', id: 'm_a:CMT-001' }], ...extra,
});

describe('schema: the new kinds and fields', () => {
  const ctx = { countDroppedField: () => {} } as never;
  const base = { cardId: 'wc_0123456789abcdef', at: '2026-11-20T20:00:00.000Z' };
  it('names the four new kinds and keeps every old one', () => {
    for (const k of ['note', 'hold-lifted', 'quiet-repickup', 'enabled-at']) expect(WORK_RECORD_TYPES).toContain(k);
    for (const k of ['created', 'edited', 'waiting-on', 'tap', 'evidence', 'claimed-done', 'dispatching', 'dispatched', 'policy', 'graduation']) expect(WORK_RECORD_TYPES).toContain(k);
  });
  it('a note pointer carries one event id or a list, system only; a person or agent note record is dropped', () => {
    const sys = { kind: 'system' };
    expect(workCardRecordStoreSchema.validate({ ...base, recordType: 'note', by: sys, eventId: 'wbn-1' }, ctx)).toMatchObject({ eventId: 'wbn-1' });
    expect(workCardRecordStoreSchema.validate({ ...base, recordType: 'note', by: sys, eventIds: ['a', 'b', 'a'] }, ctx)).toMatchObject({ eventIds: ['a', 'b'] });
    expect(workCardRecordStoreSchema.validate({ ...base, recordType: 'note', by: sys, eventId: 'x', eventIds: ['y'] }, ctx)).toBeNull();
    expect(workCardRecordStoreSchema.validate({ ...base, recordType: 'note', by: sys }, ctx)).toBeNull();
    expect(workCardRecordStoreSchema.validate({ ...base, recordType: 'note', by: { kind: 'agent' }, eventId: 'x' }, ctx)).toBeNull();
  });
  it('hold-lifted needs a known reason; quiet-repickup needs the record id it keys on; enabled-at is board-level', () => {
    const sys = { kind: 'system' };
    expect(workCardRecordStoreSchema.validate({ ...base, recordType: 'hold-lifted', by: sys, reason: 'quiet' }, ctx)).toMatchObject({ reason: 'quiet' });
    expect(workCardRecordStoreSchema.validate({ ...base, recordType: 'hold-lifted', by: sys, reason: 'because' }, ctx)).toBeNull();
    expect(workCardRecordStoreSchema.validate({ ...base, recordType: 'quiet-repickup', by: sys, newestAgentRecordId: 'wc:wc_0123456789abcdef:created' }, ctx)).toMatchObject({ newestAgentRecordId: 'wc:wc_0123456789abcdef:created' });
    expect(workCardRecordStoreSchema.validate({ ...base, recordType: 'quiet-repickup', by: sys, newestAgentRecordId: 'nope' }, ctx)).toBeNull();
    expect(workCardRecordStoreSchema.validate({ recordType: 'enabled-at', by: sys, at: base.at, teamKey: 'justin' }, ctx)).toMatchObject({ teamKey: 'justin' });
    expect(workCardRecordStoreSchema.validate({ recordType: 'enabled-at', by: { kind: 'person', personKey: 'j', proof: 'pin' }, at: base.at, teamKey: 'justin' }, ctx)).toBeNull();
    expect(isRecordId('wb-request-cards:enabled-at:justin')).toBe(true);
  });
  it('created accepts the gate-only fields in shape, refs bounded and typed, and `general` as a project key; by.isOwner is kept', () => {
    const created = { ...base, recordType: 'created', by: { kind: 'agent' }, carrier: 'agent', ...ownerRequest({ projectKey: GENERAL_PROJECT_KEY }) };
    const v = workCardRecordStoreSchema.validate(created, ctx)!;
    expect(v).toMatchObject({ requester: { personKey: 'justin', isOwner: true }, pickupHold: { kind: 'recording-session', conversationKey: 'telegram:42' }, projectKey: 'general', refs: [{ kind: 'commitment', id: 'm_a:CMT-001' }] });
    expect(workCardRecordStoreSchema.validate({ ...created, refs: [{ kind: 'url', id: 'x' }] }, ctx)).toBeNull();
    expect(workCardRecordStoreSchema.validate({ ...created, refs: Array.from({ length: 21 }, (_, i) => ({ kind: 'commitment', id: `m:${i}` })) }, ctx)).toBeNull();
    expect(workCardRecordStoreSchema.validate({ ...created, requester: { personKey: 'justin' } }, ctx)).toBeNull();
    expect(workCardRecordStoreSchema.validate({ ...created, pickupHold: { kind: 'recording-session' } }, ctx)).toBeNull();
    expect(workCardRecordStoreSchema.validate({ ...created, pickupHold: { kind: 'backfill' } }, ctx)).toMatchObject({ pickupHold: { kind: 'backfill' } });
    const tap = workCardRecordStoreSchema.validate({ ...base, recordType: 'tap', action: 'hold', by: { kind: 'person', personKey: 'justin', proof: 'pin', isOwner: true } }, ctx)!;
    expect((tap.by as { isOwner?: boolean }).isOwner).toBe(true);
  });
  it('the note text ceiling is the conversation store\'s text ceiling minus the fixed prefix, so a maximal note is valid on every replica', () => {
    expect(SCHEMA_MAX.noteText).toBe(MAX_STORED_TEXT - NOTE_EVENT_PREFIX.length);
    expect(SCHEMA_MAX.need).toBe(64_000);
  });
  it('the card id is a pure function of the commitment\'s replicated identity; the text helpers are deterministic', () => {
    expect(requestCardId('m_a', 'CMT-001')).toMatch(/^wc_[0-9a-f]{16}$/);
    expect(requestCardId('m_a', 'CMT-001')).toBe(requestCardId('m_a', 'CMT-001'));
    expect(requestCardId('m_a', 'CMT-001')).not.toBe(requestCardId('m_b', 'CMT-001'));
    expect(commitmentRefId('m_a', 'CMT-001')).toBe('m_a:CMT-001');
    expect(normalizeRequestText('  Fix  the\nLIST ')).toBe('fix the list');
    expect(requestTextHashOf('Fix the list')).toBe(requestTextHashOf('fix  the list'));
    expect(cutAtWord('one two three four', 10)).toBe('one two…');
    expect(cutAtWord('short', 10)).toBe('short');
    expect(cutAtWord('abcdefghijklmnop', 8).length).toBeLessThanOrEqual(8);
  });
});

describe('the ask-fields rule and the outward default', () => {
  it('an inward agent-work card asks nothing; an ask at creation (outward, person carrier, owner-confirms item) needs both fields', () => {
    const t = makeService();
    expect(t.svc.askFieldsRefusal(AGENT, work, null)).toBeNull();
    expect(isAgentWorkInput(work)).toBe(true);
    expect(t.svc.askFieldsRefusal(AGENT, { ...work, outward: true }, null)).toMatchObject({ error: 'recommendation-required' });
    expect(t.svc.askFieldsRefusal(AGENT, { ...work, carrier: { personKey: 'justin' } }, null)).toMatchObject({ error: 'recommendation-required' });
    expect(t.svc.askFieldsRefusal(AGENT, { ...work, doneWhen: [{ id: 'd1', text: 'Justin confirms' }] }, null)).toMatchObject({ error: 'recommendation-required' });
    expect(t.svc.askFieldsRefusal(AGENT, { ...work, outward: true, recommendation: 'r' }, null)).toMatchObject({ error: 'why-you-required' });
    expect(t.svc.askFieldsRefusal(AGENT, { ...work, outward: true, recommendation: 'r', whyYou: 'w' }, null)).toBeNull();
    expect(t.svc.askFieldsRefusal(OWNER, { ...work, outward: true }, null)).toBeNull();
    // an empty recommendation on an agent-work card is still not accepted as a value
    expect(t.svc.askFieldsRefusal(AGENT, { ...work, recommendation: '' }, null)).toMatchObject({ error: 'recommendation-required' });
  });
  it('an edit that makes an agent-work card an ask re-runs the check on that record; a waiting-on a person does too', () => {
    const t = makeService();
    const r = t.svc.createCard(AGENT, work); if (!r.ok) throw new Error(r.error);
    expect(t.svc.askFieldsRefusal(AGENT, { outward: true }, r.cardId)).toMatchObject({ error: 'recommendation-required' });
    expect(t.svc.askFieldsRefusal(AGENT, { outward: true, recommendation: 'r', whyYou: 'w' }, r.cardId)).toBeNull();
    expect(t.svc.askFieldsRefusal(AGENT, { title: 'Renamed' }, r.cardId)).toBeNull();
    expect(t.svc.waitingOnAskRefusal(AGENT, r.cardId, { principal: 'owner' })).toMatchObject({ error: 'recommendation-required' });
    expect(t.svc.waitingOnAskRefusal(AGENT, r.cardId, { principal: 'owner', recommendation: 'r', whyYou: 'w' })).toBeNull();
    expect(t.svc.waitingOnAskRefusal(AGENT, r.cardId, { principal: 'agent' })).toBeNull();
    expect(t.svc.waitingOnAskRefusal(OWNER, r.cardId, { principal: 'owner' })).toBeNull();
  });
  it('outward defaults to false for the agent and a scoped session, true for a person', () => {
    const t = makeService();
    const a = t.svc.createCard(AGENT, { title: 'x', need: 'y', doneWhen: [{ id: 'd', text: 'z', certify: 'agent-may-certify' }] }); if (!a.ok) throw new Error(a.error);
    expect(t.svc.view(a.cardId)!.card.outward).toBe(false);
    const o = t.svc.createCard(OWNER, { title: 'x', need: 'y', doneWhen: [{ id: 'd', text: 'z' }] }); if (!o.ok) throw new Error(o.error);
    expect(t.svc.view(o.cardId)!.card.outward).toBe(true);
  });
});

describe('gate-only fields', () => {
  it('are refused from the agent and a scoped session, accepted from the in-process gate; by.isOwner is stamped from the principal', () => {
    const t = makeService();
    for (const f of ['requester', 'requestTextHash', 'recordedAsHash', 'pickupHold'] as const) {
      const r = t.svc.createCard(AGENT, { ...work, [f]: ownerRequest()[f] });
      expect(r, f).toMatchObject({ ok: false, error: 'gate-only-field', detail: { field: f } });
    }
    const g = t.svc.createCard(SERVER, ownerRequest(), { cardId: requestCardId('m_a', 'CMT-001'), counted: true });
    expect(g.ok).toBe(true); if (!g.ok) return;
    expect(t.svc.edit(AGENT, g.cardId, { pickupHold: { kind: 'backfill' } })).toMatchObject({ ok: false, error: 'gate-only-field' });
    expect(t.svc.edit(SESSION(g.conversationKey), g.cardId, { requester: { personKey: 'x', isOwner: true } })).toMatchObject({ ok: false, error: 'gate-only-field' });
    t.svc.tap(OWNER, g.cardId, { action: 'hold' });
    const tap = t.svc.recordsOf(g.cardId).find((r) => r.d.recordType === 'tap')!;
    expect((tap.d.by as { isOwner?: boolean }).isOwner).toBe(true);
  });
});

describe('request approval: the owner\'s own request is the yes', () => {
  it('an owner-verified gate card is approved from the request, workable once the hold lifts, and never a per-card ask', () => {
    const t = makeService();
    const g = t.svc.createCard(SERVER, ownerRequest(), { cardId: requestCardId('m_a', 'CMT-001'), counted: true }); if (!g.ok) throw new Error(g.error);
    const v = t.svc.view(g.cardId)!;
    expect(v.card.requestApproved).toBe(true);
    expect(v.card.approvalValid).toBe(true);
    expect(v.card.approvedBy).toMatchObject({ source: 'requester-message', conversationKey: 'telegram:42', messageId: '1001', by: { proof: 'message', personKey: 'justin' } });
    expect(v.card.needLockedToRequest).toBe(true);
    expect(v.card.pickupHeld).toBe(true);
    expect(v.card.workable).toBe(false); // held for the recording conversation
    expect(v.status).toBe('with-agent');
    expect(laneFor(v.status, true, v.card, 'justin')).toBe('with-agent');
    expect(WAITING_STATUSES.has(v.status)).toBe(false);
    const lifted = t.svc.liftHold(g.cardId, 'quiet'); expect(lifted.ok).toBe(true);
    const after = t.svc.view(g.cardId)!;
    expect(after.card.pickupHeld).toBe(false);
    expect(after.card.workable).toBe(true);
    expect(after.card.holdLifted).toMatchObject({ reason: 'quiet' });
    expect(t.svc.liftHold(g.cardId, 'quiet')).toMatchObject({ ok: false, error: 'not-held' });
    // the lift's key is deterministic per card: a second holder writing it (a split lease) is a duplicate, never a second record
    expect(lifted.ok && lifted.recordId).toBe(`wc:${g.cardId}:hl:once`);
    expect(t.svc.writeHolder('hold-lifted', g.cardId, { reason: 'person-cause' })).toMatchObject({ ok: true, duplicate: true });
    // the lift is the pickup's cause
    const causes = derivePickupCauses(g.cardId, t.svc.recordsOf(g.cardId), t.svc.policyRecords());
    expect(causes.map((c) => [c.kind, c.holdLift ?? false])).toEqual([['work', true]]);
  });
  it('two commitments on one owner message are two approved cards; a member\'s or unverified request is not-started', () => {
    const t = makeService();
    const a = t.svc.createCard(SERVER, ownerRequest({ refs: [{ kind: 'commitment', id: 'm_a:CMT-001' }] }), { cardId: requestCardId('m_a', 'CMT-001') });
    const b = t.svc.createCard(SERVER, ownerRequest({ refs: [{ kind: 'commitment', id: 'm_a:CMT-002' }], title: 'Second half' }), { cardId: requestCardId('m_a', 'CMT-002') });
    if (!a.ok || !b.ok) throw new Error('create');
    expect(t.svc.view(a.cardId)!.card.requestApproved).toBe(true);
    expect(t.svc.view(b.cardId)!.card.requestApproved).toBe(true);
    const m = t.svc.createCard(SERVER, ownerRequest({ requester: { personKey: 'adriana', isOwner: false } }), { cardId: requestCardId('m_a', 'CMT-003') }); if (!m.ok) throw new Error(m.error);
    expect(t.svc.view(m.cardId)!.card.requestApproved).toBe(false);
    expect(t.svc.view(m.cardId)!.status).toBe('not-started');
    const u = t.svc.createCard(SERVER, { ...work, pickupHold: { kind: 'recording-session', conversationKey: 'telegram:42' } }, { cardId: requestCardId('m_a', 'CMT-004') }); if (!u.ok) throw new Error(u.error);
    expect(t.svc.view(u.cardId)!.status).toBe('not-started');
    expect(t.svc.notStartedCardIds()).toEqual([m.cardId, u.cardId].sort((x, y) => (x < y ? -1 : 1)).sort(() => 0).length === 2 ? t.svc.notStartedCardIds() : []);
    expect(new Set(t.svc.notStartedCardIds())).toEqual(new Set([m.cardId, u.cardId]));
  });
  it('the agent\'s edits to title, items and links keep the approval and set "changed since asked"; need is locked; a flip to outward or a person carrier ends it; a withdrawal revokes it', () => {
    const t = makeService();
    const g = t.svc.createCard(SERVER, ownerRequest({ recordedAsHash: requestTextHashOf('fix the venue list') }), { cardId: requestCardId('m_a', 'CMT-001') }); if (!g.ok) throw new Error(g.error);
    t.svc.liftHold(g.cardId, 'quiet');
    expect(t.svc.view(g.cardId)!.card.recordedInAgentWords).toBe(true);
    expect(t.svc.view(g.cardId)!.card.changedSinceAsked).toBe(false);
    expect(t.svc.edit(AGENT, g.cardId, { title: 'Venue list, tidied' }).ok).toBe(true);
    expect(t.svc.edit(AGENT, g.cardId, { doneWhen: [{ id: 'd1', text: 'Tidy', certify: 'agent-may-certify' }, { id: 'd2', text: 'Checked twice', certify: 'agent-may-certify' }] }).ok).toBe(true);
    expect(t.svc.edit(AGENT, g.cardId, { links: [{ label: 'PR', url: 'https://example.com/pr/1' }] }).ok).toBe(true);
    let v = t.svc.view(g.cardId)!;
    expect(v.card.approvalValid).toBe(true);
    expect(v.card.changedSinceAsked).toBe(true);
    expect(v.card.workable).toBe(true);
    expect(t.svc.edit(AGENT, g.cardId, { need: 'Something else' })).toMatchObject({ ok: false, error: 'need-locked-to-request' });
    expect(t.svc.view(g.cardId)!.card.need).toBe(OWNER_TEXT);
    // A flip to outward returns the ordinary rule: an approve tap is needed again.
    expect(t.svc.edit(AGENT, g.cardId, { outward: true, recommendation: 'r', whyYou: 'w' }).ok).toBe(true);
    v = t.svc.view(g.cardId)!;
    expect(v.card.requestApproved).toBe(false); expect(v.card.approvalValid).toBe(false); expect(v.status).toBe('needs-approval');
    expect(t.svc.edit(AGENT, g.cardId, { outward: false }).ok).toBe(true);
    expect(t.svc.view(g.cardId)!.card.requestApproved).toBe(true);
    // A withdrawal tap revokes it as it revokes any approval; the card then reads needs-approval (not not-started).
    t.svc.tap(OWNER, g.cardId, { action: 'withdraw-approval' });
    v = t.svc.view(g.cardId)!;
    expect(v.card.approvalValid).toBe(false); expect(v.card.withdrawn).toBe(true); expect(v.status).toBe('needs-approval');
  });
  it('a need-locked edit record from another machine is ignored by the fold (the fold is the authority)', () => {
    const t = makeService();
    const g = t.svc.createCard(SERVER, ownerRequest(), { cardId: requestCardId('m_a', 'CMT-001') }); if (!g.ok) throw new Error(g.error);
    const recs = t.svc.recordsOf(g.cardId).map((r) => ({ data: r.d, origin: r.origin }));
    recs.push({ data: { recordType: 'edited', cardId: g.cardId, recordKey: `wc:${g.cardId}:e:zz`, hlc: { physical: t.now() + 5, logical: 0, node: 'm_b' }, op: 'put', origin: 'm_b', by: { kind: 'agent' }, at: new Date(t.now() + 5).toISOString(), need: 'Changed elsewhere' }, origin: 'm_b' });
    const f = foldCard(g.cardId, toFoldRecords(recs), []);
    expect(f.need).toBe(OWNER_TEXT);
    expect(f.requestApproved).toBe(true);
  });
});

describe('not-started refuses the agent\'s work records, counted; evidence then claim closes an approved card with no tap', () => {
  it('refusals', () => {
    const t = makeService();
    const m = t.svc.createCard(SERVER, ownerRequest({ requester: { personKey: 'adriana', isOwner: false } }), { cardId: requestCardId('m_a', 'CMT-003') }); if (!m.ok) throw new Error(m.error);
    expect(t.svc.view(m.cardId)!.status).toBe('not-started');
    expect(t.svc.addEvidence(AGENT, m.cardId, { itemId: 'd1', text: 'done' })).toMatchObject({ ok: false, error: 'not-started' });
    expect(t.svc.claimDone(AGENT, m.cardId)).toMatchObject({ ok: false, error: 'not-started' });
    expect(noteRefusalFor(t.svc, AGENT, m.cardId)).toMatchObject({ error: 'not-started' });
    expect(noteRefusalFor(t.svc, SESSION(t.svc.view(m.cardId)!.card.conversationKey), m.cardId)).toMatchObject({ error: 'not-started' });
    expect(t.svc.stats.notStartedRefusals).toBe(4);
    // the owner's approve starts it under the strict policy
    const hash = t.svc.view(m.cardId)!.card.materialHash;
    expect(t.svc.tap(OWNER, m.cardId, { action: 'approve', materialHash: hash }).ok).toBe(true);
    expect(t.svc.view(m.cardId)!.status).toBe('with-agent');
    expect(noteRefusalFor(t.svc, AGENT, m.cardId)).toBeNull();
  });
  it('close-out', () => {
    const t = makeService();
    const g = t.svc.createCard(SERVER, ownerRequest(), { cardId: requestCardId('m_a', 'CMT-001') }); if (!g.ok) throw new Error(g.error);
    t.svc.liftHold(g.cardId, 'quiet');
    expect(t.svc.addEvidence(AGENT, g.cardId, { itemId: 'd1', text: 'Tidied; see https://example.com/diff' }).ok).toBe(true);
    const c = t.svc.claimDone(AGENT, g.cardId); expect(c.ok).toBe(true);
    const v = t.svc.view(g.cardId)!;
    expect(v.card.done).toBe(true); expect(v.card.doneByAgentOwnEvidence).toBe(true); expect(v.status).toBe('done');
  });
});

describe('the quiet clock and the churn park', () => {
  it('a new card is never quiet at birth; the clock reads agent records, note pointers and delivered hand-overs, not person taps', () => {
    const t = makeService({ quietAfterHours: 1 });
    const o = t.svc.createCard(OWNER, work); if (!o.ok) throw new Error(o.error);
    expect(t.svc.view(o.cardId)!.status).toBe('with-agent');
    expect(t.svc.view(o.cardId)!.card.newestAgentRecordId).toBe(`wc:${o.cardId}:created`);
    // the hand-over settles the pickup (a pending pickup is never quiet) and counts as agent activity
    t.svc.writeSystem('dispatched', o.cardId, { for: `wc:${o.cardId}:created`, outcome: 'spawned', attempt: 1 });
    expect(t.svc.view(o.cardId)!.card.newestAgentRecordId).not.toBe(`wc:${o.cardId}:created`);
    t.advance(3_600_000 + QUIET_CLOCK_GRACE_MS + 1);
    expect(t.svc.view(o.cardId)!.status).toBe('quiet');
    t.svc.tap(OWNER, o.cardId, { action: 'hold' }); t.svc.tap(OWNER, o.cardId, { action: 'unhold', names: t.svc.view(o.cardId)!.card.holds[0] ?? t.svc.recordsOf(o.cardId).find((r) => r.d.action === 'hold')!.id });
    const n = t.svc.notePointer(o.cardId, ['wbn-1']); expect(n.ok).toBe(true);
    expect(t.svc.view(o.cardId)!.status).toBe('with-agent');
    expect(t.svc.view(o.cardId)!.card.newestAgentRecordId).toBe(n.ok ? n.recordId : '');
  });
  it('the holder\'s quiet re-pickup is idempotent per newest agent record and is a work cause flagged repickup; the churn park on it derives quiet', () => {
    const t = makeService({ quietAfterHours: 1 });
    const o = t.svc.createCard(OWNER, work); if (!o.ok) throw new Error(o.error);
    t.advance(2 * 3_600_000);
    const r1 = t.svc.quietRepickup(o.cardId); expect(r1.ok && !r1.duplicate).toBe(true);
    const r2 = t.svc.quietRepickup(o.cardId); expect(r2.ok && r2.duplicate).toBe(true);
    const causes = derivePickupCauses(o.cardId, t.svc.recordsOf(o.cardId), t.svc.policyRecords());
    expect(causes.filter((c) => c.repickup)).toHaveLength(1);
    expect(causes.filter((c) => c.repickup)[0].agentCaused).toBe(true);
    // a pending re-pickup is not quiet; the brake's park on it is
    expect(t.svc.view(o.cardId)!.status).toBe('with-agent');
    const cause = causes.find((c) => c.repickup)!;
    t.svc.writeSystem('dispatched', o.cardId, { for: cause.id, outcome: 'parked', reason: 'decision:agent-churn' });
    expect(t.svc.view(o.cardId)!.status).toBe('quiet');
    expect(deriveStatus(t.svc.view(o.cardId)!.card, { pendingOrParked: true, parked: true, quietParked: false }, t.now(), 1)).toBe('parked');
  });
  it('a held card does not derive quiet whatever the clock says', () => {
    const t = makeService({ quietAfterHours: 1 });
    const g = t.svc.createCard(SERVER, ownerRequest(), { cardId: requestCardId('m_a', 'CMT-001') }); if (!g.ok) throw new Error(g.error);
    t.advance(48 * 3_600_000);
    expect(t.svc.view(g.cardId)!.status).toBe('with-agent');
  });
});

describe('refs, the duplicate hint and the holder\'s records', () => {
  it('the refs index answers "has a card" by commitment identity; a 21st ref is refused; the duplicate hint names same-message and same-title cards only', () => {
    const t = makeService();
    const g = t.svc.createCard(SERVER, ownerRequest(), { cardId: requestCardId('m_a', 'CMT-001') }); if (!g.ok) throw new Error(g.error);
    expect(t.svc.cardForRef('commitment', 'm_a:CMT-001')).toBe(g.cardId);
    expect(t.svc.cardForRef('commitment', 'm_a:CMT-999')).toBeNull();
    const many = Array.from({ length: 21 }, (_, i) => ({ kind: 'commitment', id: `m_a:CMT-${100 + i}` }));
    expect(t.svc.edit(SERVER, g.cardId, { refs: many })).toMatchObject({ ok: false, error: 'too-many-refs' });
    const same = t.svc.createCard(SERVER, ownerRequest({ refs: [{ kind: 'commitment', id: 'm_a:CMT-002' }], title: 'Different title' }), { cardId: requestCardId('m_a', 'CMT-002') }); if (!same.ok) throw new Error(same.error);
    expect(t.svc.possibleDuplicateOf(g.cardId)).toEqual([same.cardId]);
    const other = t.svc.createCard(SERVER, ownerRequest({ refs: [{ kind: 'commitment', id: 'm_a:CMT-003' }], source: { conversationKey: 'telegram:42', messageId: '2002' } }), { cardId: requestCardId('m_a', 'CMT-003') }); if (!other.ok) throw new Error(other.error);
    expect(t.svc.possibleDuplicateOf(other.cardId)).toContain(g.cardId); // same normalised title, inside the window
    const far = t.svc.createCard(SERVER, ownerRequest({ refs: [{ kind: 'commitment', id: 'm_a:CMT-004' }], source: { conversationKey: 'telegram:43', messageId: '1001' } }), { cardId: requestCardId('m_a', 'CMT-004') }); if (!far.ok) throw new Error(far.error);
    expect(t.svc.possibleDuplicateOf(far.cardId)).toEqual([]); // another conversation
  });
  it('note pointers are keyed by event (one event, one pointer; a coalesced pointer by its first event); the enabled-at record is written once', () => {
    const t = makeService();
    const g = t.svc.createCard(SERVER, ownerRequest(), { cardId: requestCardId('m_a', 'CMT-001') }); if (!g.ok) throw new Error(g.error);
    const a = t.svc.notePointer(g.cardId, ['e1']); const b = t.svc.notePointer(g.cardId, ['e1']);
    expect(a.ok && !a.duplicate).toBe(true); expect(b.ok && b.duplicate).toBe(true);
    const c = t.svc.notePointer(g.cardId, ['e2', 'e3']); expect(c.ok && !c.duplicate).toBe(true);
    expect([...t.svc.notedEventIds(g.cardId)].sort()).toEqual(['e1', 'e2', 'e3']);
    expect(t.svc.notePointersOn(g.cardId, new Date(t.now()).toISOString().slice(0, 10))).toBe(2);
    expect(t.svc.enabledAt('justin')).toBeNull();
    const e1 = t.svc.markEnabledAt('justin'); const e2 = t.svc.markEnabledAt('justin');
    expect(e1.ok && !e1.duplicate).toBe(true); expect(e2.ok && e2.duplicate).toBe(true);
    expect(t.svc.enabledAt('justin')).toMatchObject({ id: 'wb-request-cards:enabled-at:justin' });
  });
  it('a note text is credential-checked and bounded by the owner-set limit, which cannot exceed the hard ceiling', () => {
    const t = makeService({ limits: { noteText: 20 } });
    expect(t.svc.checkNoteText('x'.repeat(21))).toMatchObject({ ok: false, error: 'over-limit', detail: { limit: 20 } });
    expect(t.svc.checkNoteText('key sk-ant-abcdefghijklmnop')).toMatchObject({ ok: false, error: 'credential-refused' });
    expect(t.svc.checkNoteText('')).toMatchObject({ ok: false, error: 'text-required' });
    expect(t.svc.checkNoteText('did a thing')).toEqual({ ok: true, text: `${NOTE_EVENT_PREFIX}did a thing` });
    expect(resolveWorkBoardSettings({ limits: { noteText: 999_999 } }).limits.noteText).toBe(SCHEMA_MAX.noteText);
  });
});

describe('settings', () => {
  it('the new names resolve with their defaults; the sweep and the drain are clamped to the journal bucket; the boolean is a boolean', () => {
    const s = resolveWorkBoardSettings({});
    expect(s.requestCards).toEqual({ enabled: true, duplicateHintHours: 24, backfillMaxAgeDays: 14, sweepPerTick: 25, unrecordedWorkMinutes: 10, floorRecentHours: 72 });
    expect([s.maxNotesPerCardPerDay, s.noteCoalesceMinutes, s.noteDrainPerTick, s.softOpenBlockers, s.maxOpenAsksPerCard, s.limits.noteText]).toEqual([50, 60, 25, 10, 5, 4000]);
    expect(resolveWorkBoardSettings({ requestCards: { enabled: false } }).requestCards.enabled).toBe(false);
    const clamped = resolveWorkBoardSettings({ requestCards: { sweepPerTick: 90 }, noteDrainPerTick: 90 });
    expect(clamped.requestCards.sweepPerTick + clamped.noteDrainPerTick).toBeLessThanOrEqual(JOURNAL_BUCKET_CAPACITY);
    expect(clamped.noteDrainPerTick).toBeGreaterThanOrEqual(1);
    expect(resolveWorkBoardSettings({ noteCoalesceMinutes: 0 }).noteCoalesceMinutes).toBe(60);
    expect(validateSettingsPatch({ requestCards: { enabled: false } })).toEqual({ ok: true });
    expect(validateSettingsPatch({ requestCards: { enabled: 'no' } })).toMatchObject({ ok: false, field: 'requestCards.enabled' });
    expect(validateSettingsPatch({ requestCards: { sweepPerTick: 10 }, noteDrainPerTick: 5, maxNotesPerCardPerDay: 10 })).toEqual({ ok: true });
    expect(validateSettingsPatch({ limits: { noteText: SCHEMA_MAX.noteText + 1 } })).toMatchObject({ ok: false, field: 'limits.noteText' });
    expect(validateSettingsPatch({ requestCards: { backfillMaxAgeDay: 1 } })).toMatchObject({ ok: false, field: 'requestCards.backfillMaxAgeDay' });
  });
});

describe('checked owner start decision projection', () => {
  it('keeps approval state while separating a bound owner decision from a policy-only wait', () => {
    const { svc, journal } = makeService();
    const created = svc.createCard(AGENT, {
      ...work, outward: true, whyYou: 'An approval is required.',
      recommendation: 'Review the proposal.',
      doneWhen: [{ id: 'd1', text: 'Owner verifies the result', certify: 'owner-confirms' }],
    });
    if (!created.ok) throw new Error(created.error);
    const view = svc.view(created.cardId)!;
    const viewer = { isOwner: true, isAgent: false, personKey: 'justin' };
    const render = (ownerStartDecision?: 'current' | 'absent') =>
      cardJson(svc, view, viewer, key => key, { ownerStartDecision });
    const initialRecords = journal.length;
    const legacy = render();
    expect(legacy).toMatchObject({ status: 'needs-approval', lane: 'waiting-on-you', turn: 'you' });
    expect(render('current')).toEqual(legacy);
    const agent = render('absent');
    expect(agent).toMatchObject({
      status: legacy.status, lane: 'with-agent', turn: 'agent', approvalRequired: true,
      approved: false, workable: false, materialHash: legacy.materialHash, pickups: legacy.pickups,
    });
    expect(myBoardReason(view, viewer, 'with-agent', true)).toBeNull();
    expect(myBoardReason(view, viewer, 'with-agent')).toBe('approval');
    expect(journal).toHaveLength(initialRecords);
  });

  it('keeps checked cards out of the legacy aggregate without changing their stored eligibility', () => {
    const { svc } = makeService();
    const cards = [10, 11, 12].map(commitment => {
      const card = svc.createCard(SERVER, ownerRequest({
        requester: { personKey: 'member', isOwner: false },
      }), { cardId: requestCardId('m_a', `CMT-${commitment}`), counted: true });
      if (!card.ok) throw new Error(card.error);
      return card.cardId;
    });
    const [bound, agent, legacy] = cards;
    const viewer = { isOwner: true, isAgent: false, personKey: 'justin' };
    const render = (extraFor?: Parameters<typeof boardJson>[4]['extraFor']) =>
      boardJson(svc, viewer, () => true, key => key, { softOpenCards: 30, extraFor });
    expect(render().notStartedCards).toMatchObject({
      count: 3, cardIds: expect.arrayContaining(cards),
    });
    expect(render(v => v.card.cardId === legacy ? undefined : {
      ownerStartDecision: v.card.cardId === bound ? 'current' : 'absent',
    }).notStartedCards).toMatchObject({ count: 1, cardIds: [legacy] });
    expect(svc.view(agent)?.status).toBe('not-started');
    expect(svc.notStartedCardIds()).toEqual(expect.arrayContaining(cards));
  });

  it('moves the agent-waiting mirror but preserves a live owner question', () => {
    const card = foldCard('wc_0123456789abcdef', [], []);
    card.carrier = { personKey: 'justin' };
    card.mirror = { ref: 'project:feedback', hlc: { physical: 1, logical: 0, node: 'm_a' } };
    expect(laneFor('with-person', true, card, 'justin')).toBe('waiting-on-you');
    expect(laneFor('with-person', true, card, 'justin', false, 'absent')).toBe('with-agent');
    card.waitingOn = { personKey: 'justin' };
    expect(laneFor('with-person', true, card, 'justin', false, 'absent')).toBe('waiting-on-you');
  });
});
