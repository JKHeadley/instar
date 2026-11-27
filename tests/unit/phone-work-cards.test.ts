/**
 * Work cards from the owner's phone (docs/specs/phone-work-cards.md): the draft's shape check and
 * projection (what is stored is exactly what is signed), the draft hash with fixed vectors the phone apps
 * reproduce, the derived card id, the `work-card-create` action line, the idempotent create (replay,
 * reused request id, removed card), the named card id for an owner person, and the pre-Face ID checks
 * (owner, replay before the source check, the write's own checks as a dry run that writes nothing).
 */
import { describe, it, expect } from 'vitest';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { WorkBoardService, resolveWorkBoardSettings, type WorkPrincipal } from '../../src/core/WorkBoardService.js';
import { workCardRecordStoreSchema, type UnionEntry } from '../../src/core/WorkCardStore.js';
import { parsePhoneCardDraft, phoneCardDraftHash, phoneCardId, phoneCardCreateLine, createPhoneCard, phoneCardPrecheck, PHONE_CARD_SHAPE_WORDS, type PhoneCardDraft } from '../../src/server/phoneWorkCards.js';
import { buildAction, actionLine } from '../../src/server/mobilePermissionsRoutes.js';

const APP_KEY = '0f8fad5b-d9cb-469f-a165-70867728950e';

function makeService(machineId = 'm_a', journal: UnionEntry[] = [], startAt = Date.parse('2026-11-17T20:00:00Z')) {
  let clock = startAt; let logical = 0;
  const settings = resolveWorkBoardSettings({});
  const svc = new WorkBoardService({
    machineId,
    emit: (_key, build) => {
      const hlc: HlcTimestamp = { physical: (clock += 1000), logical: logical++, node: machineId };
      const data = build(hlc, machineId);
      if (!data) return { outcome: 'skipped' };
      if (!workCardRecordStoreSchema.validate(data, { countDroppedField: () => {}, countJailReject: () => {} } as never)) return { outcome: 'dropped:invalid' };
      journal.push({ data, origin: machineId });
      return { outcome: 'emitted', seq: journal.length, hlc };
    },
    loadUnion: () => journal, now: () => clock, settings: () => settings, ownerPersonKey: () => 'justin',
    detectCredential: (t) => (/sk-ant-[A-Za-z0-9]{10,}/.test(t) ? 'anthropic-api-key' : null),
    dayOf: (ms) => ({ day: new Date(ms).toISOString().slice(0, 10), resetsAt: '' }), displayName: (k) => (k === 'justin' ? 'Justin' : k),
  });
  return { svc, journal };
}

const BODY = {
  requestId: '6f1c2a40-0b1e-4c8e-9a51-3d2b7e9f0c11',
  title: 'Book the venue',
  need: 'Adriana asked us to book the venue for Friday.',
  doneWhen: [{ id: 'd1', text: 'The venue is booked' }],
  source: { conversationKey: 'telegram:4242', messageId: '991' },
};
const draftOf = (b: Record<string, unknown>): PhoneCardDraft => { const p = parsePhoneCardDraft(b); if (!p.ok) throw new Error(p.error); return p.draft; };

describe('the draft: shape and projection', () => {
  it('accepts the console\'s two source kinds and keeps exactly the signed fields', () => {
    const p = parsePhoneCardDraft({ ...BODY, outward: true, carrier: { personKey: 'x' }, doneWhen: [{ id: 'd1', text: 'Booked', certify: 'agent-may-certify', done: true }], source: { conversationKey: `app:${APP_KEY}`, messageId: 'k1', extra: 1 } });
    expect(p.ok).toBe(true); if (!p.ok) return;
    expect(p.draft).toEqual({ title: BODY.title, need: BODY.need, doneWhen: [{ id: 'd1', text: 'Booked' }], source: { conversationKey: `app:${APP_KEY}`, messageId: 'k1' } });
  });

  it('refuses each malformed part with a named error and plain words', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...BODY, requestId: 'ABC-UPPER-CASE' }, 'bad-request-id'], [{ ...BODY, requestId: 'short' }, 'bad-request-id'],
      [{ ...BODY, title: '  ' }, 'title-required'], [{ ...BODY, need: undefined }, 'need-required'],
      [{ ...BODY, doneWhen: [] }, 'done-item-required'], [{ ...BODY, doneWhen: [{ id: 'd1', text: 'a' }, { id: 'd1', text: 'b' }] }, 'bad-done-item'],
      [{ ...BODY, doneWhen: [{ id: 'd1', text: '' }] }, 'bad-done-item'],
      [{ ...BODY, source: { conversationKey: 'slack:C1', messageId: '1' } }, 'bad-source'], [{ ...BODY, source: { conversationKey: 'app:not-a-key', messageId: '1' } }, 'bad-source'],
      [{ ...BODY, source: { conversationKey: 'telegram:0', messageId: '1' } }, 'bad-source'],
      [{ ...BODY, source: { conversationKey: 'telegram:5', messageId: 'x'.repeat(201) } }, 'bad-message-id'], [{ ...BODY, source: { conversationKey: 'telegram:5', messageId: 'a\nb' } }, 'bad-message-id'],
    ];
    for (const [body, error] of cases) {
      expect(parsePhoneCardDraft(body), error).toEqual({ ok: false, error });
      expect(PHONE_CARD_SHAPE_WORDS[error]).toBeTruthy();
    }
  });
});

describe('the draft hash (fixed vectors the phone apps reproduce)', () => {
  it('is sha256 of sorted-key compact JSON with v:1, and ignores everything the card does not store', () => {
    expect(phoneCardDraftHash(draftOf(BODY))).toBe('28c1b4036c96133df406492b58bcac68b12602415581d9f3d5df43f8915a6aa0');
    expect(phoneCardDraftHash(draftOf({ ...BODY, outward: true, doneWhen: [{ id: 'd1', text: 'The venue is booked', certify: 'agent-may-certify' }] }))).toBe(phoneCardDraftHash(draftOf(BODY)));
  });
  it('escapes like JSON.stringify: a slash is not escaped, non-ASCII stays literal, U+2028 stays literal, a quote is escaped', () => {
    const tricky = draftOf({ ...BODY, title: 'Fix a/b "now" 🚀', need: 'line sep' });
    expect(phoneCardDraftHash(tricky)).toBe('6f54e57e3477e2f2684fc3725d444d82b043d0a43cb884fa2bd4bed85e0d63af');
  });
  it('control characters: newline, tab, backslash and U+0001 are escaped as JSON.stringify escapes them', () => {
    const d = draftOf({ ...BODY, title: 'Tab\there', need: 'Line one\nC:\\path \u0001 end' });
    expect(phoneCardDraftHash(d)).toBe('91798f2a93e361027840c2802d47679a7633604e72dff37c9862429bc2df64bb');
  });
  it('a stored card replays with padded and non-NFC text kept byte for byte', () => {
    const { svc } = makeService();
    const d = draftOf({ ...BODY, title: '  Cafe\u0301 booking  ', need: 'e\u0301 ' });
    const h = phoneCardDraftHash(d);
    expect(createPhoneCard(svc, 'justin', BODY.requestId, d, h).kind).toBe('created');
    expect(createPhoneCard(svc, 'justin', BODY.requestId, d, h).kind).toBe('replayed');
  });
  it('changes when any signed field changes', () => {
    const base = phoneCardDraftHash(draftOf(BODY));
    for (const over of [{ title: 'Other' }, { need: 'Other' }, { doneWhen: [{ id: 'd2', text: 'The venue is booked' }] }, { source: { conversationKey: 'telegram:4242', messageId: '992' } }]) {
      expect(phoneCardDraftHash(draftOf({ ...BODY, ...over }))).not.toBe(base);
    }
  });
});

describe('the id and the signed line', () => {
  it('derives a card id from the owner and the request, the same everywhere', () => {
    const id = phoneCardId('justin', BODY.requestId);
    expect(id).toMatch(/^wc_[0-9a-f]{16}$/);
    expect(phoneCardId('justin', BODY.requestId)).toBe(id);
    expect(phoneCardId('adriana', BODY.requestId)).not.toBe(id);
  });
  it('builds work-card-create with the request id and the hash, refusing malformed parts', () => {
    const h = 'a'.repeat(64);
    const built = buildAction('work-card-create', BODY.requestId, { proposalHash: h });
    expect(built.ok).toBe(true); if (!built.ok) return;
    expect(actionLine(built.action)).toBe(`work-card-create ${BODY.requestId} ${h}`);
    expect(actionLine(built.action)).toBe(phoneCardCreateLine(BODY.requestId, h));
    expect(buildAction('work-card-create', 'NOT LOWER', { proposalHash: h })).toEqual({ ok: false, error: 'bad-target' });
    expect(buildAction('work-card-create', BODY.requestId, { proposalHash: 'short' })).toEqual({ ok: false, error: 'bad-proposal-hash' });
  });
});

describe('the idempotent create', () => {
  it('writes an owner card with the source, owner-confirmed done items and outward false; a replay writes nothing', () => {
    const { svc, journal } = makeService();
    const d = draftOf({ ...BODY, doneWhen: [{ id: 'd1', text: 'The venue is booked', certify: 'agent-may-certify' }] });
    const h = phoneCardDraftHash(d);
    const r = createPhoneCard(svc, 'justin', BODY.requestId, d, h);
    expect(r.kind).toBe('created'); if (r.kind !== 'created') return;
    expect(r.cardId).toBe(phoneCardId('justin', BODY.requestId));
    const created = journal.find((e) => e.data.recordType === 'created')!.data;
    expect(created.by).toEqual({ kind: 'person', personKey: 'justin', proof: 'presence', isOwner: true });
    expect(created.source).toEqual(BODY.source);
    expect(created.outward).toBe(false);
    expect((created.doneWhen as Array<Record<string, unknown>>)[0]).toEqual({ id: 'd1', text: 'The venue is booked' });
    expect(svc.view(r.cardId)!.card.doneWhen[0]!.certify).toBe('owner-confirms');
    const count = journal.length;
    const again = createPhoneCard(svc, 'justin', BODY.requestId, d, h);
    expect(again).toEqual({ kind: 'replayed', cardId: r.cardId, conversationKey: r.conversationKey });
    expect(journal.length).toBe(count);
  });

  it('a reused request id with a different draft is refused; a removed card is refused', () => {
    const { svc } = makeService();
    const d = draftOf(BODY); const h = phoneCardDraftHash(d);
    const r = createPhoneCard(svc, 'justin', BODY.requestId, d, h);
    if (r.kind !== 'created') throw new Error('create');
    const other = draftOf({ ...BODY, title: 'Something else' });
    expect(createPhoneCard(svc, 'justin', BODY.requestId, other, phoneCardDraftHash(other))).toMatchObject({ kind: 'refused', status: 409, body: { error: 'request-id-reused' } });
    const owner: WorkPrincipal = { kind: 'person', personKey: 'justin', proof: 'presence', isOwner: true };
    const card = svc.view(r.cardId)!.card;
    expect(svc.tap(owner, r.cardId, { action: 'redact', titleHash: undefined, materialHash: card.materialHash }).ok).toBe(true);
    expect(createPhoneCard(svc, 'justin', BODY.requestId, d, h)).toMatchObject({ kind: 'refused', status: 409, body: { error: 'card-removed' } });
  });

  it('a named card id is for the agent or the owner only', () => {
    const { svc } = makeService();
    const member: WorkPrincipal = { kind: 'person', personKey: 'adriana', proof: 'presence', isOwner: false };
    expect(svc.createCard(member, { title: 't', need: 'n', doneWhen: [{ id: 'd1', text: 'x' }] }, { cardId: 'wc_0123456789abcdef' })).toMatchObject({ ok: false, status: 403 });
    const owner: WorkPrincipal = { kind: 'person', personKey: 'justin', proof: 'presence', isOwner: true };
    expect(svc.createCard(owner, { title: 't', need: 'n', doneWhen: [{ id: 'd1', text: 'x' }] }, { cardId: 'wc_0123456789abcdef' }).ok).toBe(true);
    expect(svc.createCard(owner, { title: 't', need: 'n', doneWhen: [{ id: 'd1', text: 'x' }] }, { cardId: 'wc_0123456789abcdef' })).toMatchObject({ ok: false, status: 409, error: 'card-exists' });
  });
});

describe('the checks before Face ID', () => {
  const deps = (svc: WorkBoardService, owner: string | null = 'justin') => ({ enabled: () => true, svc: () => svc, ownerPersonKey: () => owner });
  it('refuses a switched-off board, a missing owner, an unreadable source, and what the write itself would refuse; writes nothing', () => {
    const { svc, journal } = makeService();
    const d = draftOf(BODY);
    expect(phoneCardPrecheck({ enabled: () => false, svc: () => svc, ownerPersonKey: () => 'justin' }, BODY.requestId, d, () => true)).toMatchObject({ status: 503, body: { error: 'work-board-disabled' } });
    expect(phoneCardPrecheck(deps(svc, null), BODY.requestId, d, () => true)).toMatchObject({ status: 409, body: { error: 'no-team-owner' } });
    expect(phoneCardPrecheck(deps(svc), BODY.requestId, d, () => false)).toMatchObject({ status: 404, body: { error: 'source-conversation-not-found' } });
    expect(phoneCardPrecheck(deps(svc), BODY.requestId, draftOf({ ...BODY, title: 'x'.repeat(5000) }), () => true)).toMatchObject({ status: 413, body: { error: 'over-limit', field: 'title' } });
    expect(phoneCardPrecheck(deps(svc), BODY.requestId, draftOf({ ...BODY, need: 'key sk-ant-ABCDEFGHIJKLMNOP' }), () => true)).toMatchObject({ status: 422, body: { error: 'credential-refused' } });
    expect(phoneCardPrecheck(deps(svc), BODY.requestId, d, () => true)).toBeNull();
    expect(journal).toHaveLength(0);
  });
  it('a card already made for this request goes on to the proof even if its conversation is gone (the replay answers it)', () => {
    const { svc } = makeService();
    const d = draftOf(BODY);
    expect(createPhoneCard(svc, 'justin', BODY.requestId, d, phoneCardDraftHash(d)).kind).toBe('created');
    expect(phoneCardPrecheck(deps(svc), BODY.requestId, d, () => false)).toBeNull();
  });
  it('a different draft under a used request, or a removed card, is refused before Face ID', () => {
    const { svc } = makeService();
    const d = draftOf(BODY);
    const r = createPhoneCard(svc, 'justin', BODY.requestId, d, phoneCardDraftHash(d));
    if (r.kind !== 'created') throw new Error('create');
    expect(phoneCardPrecheck(deps(svc), BODY.requestId, draftOf({ ...BODY, title: 'Other' }), () => true)).toMatchObject({ status: 409, body: { error: 'request-id-reused' } });
    const owner: WorkPrincipal = { kind: 'person', personKey: 'justin', proof: 'presence', isOwner: true };
    expect(svc.tap(owner, r.cardId, { action: 'redact' }).ok).toBe(true);
    expect(phoneCardPrecheck(deps(svc), BODY.requestId, d, () => true)).toMatchObject({ status: 409, body: { error: 'card-removed' } });
  });
});
