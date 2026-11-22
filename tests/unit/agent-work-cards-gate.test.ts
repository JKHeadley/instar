/**
 * agent-work-cards-default §3 — the request-to-card gate: the requester from the durable row (every adapter arm, both
 * sides), the deterministic card write, idempotency and linking, the daily ceiling as a retryable reason, the sweep
 * (enabled-at once, backfill by age, pace), and deliver (gate first, note, evidence only with an item).
 */
import { describe, it, expect } from 'vitest';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { WorkBoardService, resolveWorkBoardSettings, type WorkPrincipal } from '../../src/core/WorkBoardService.js';
import { workCardRecordStoreSchema, requestCardId, requestTextHashOf, SCHEMA_MAX, type UnionEntry } from '../../src/core/WorkCardStore.js';
import { WorkBoardRequestGate, conversationKeyOf, telegramTopicOf, type RequestGateDeps, type GateCommitmentRow, type TelegramRow, type AppRow } from '../../src/core/WorkBoardRequestGate.js';

const OWNER: WorkPrincipal = { kind: 'person', personKey: 'justin', proof: 'pin', isOwner: true };

function rig(over: Partial<RequestGateDeps> = {}, settingsOver: Record<string, unknown> = {}) {
  const journal: UnionEntry[] = [];
  let clock = Date.parse('2026-11-20T20:00:00Z');
  let logical = 0;
  const settings = resolveWorkBoardSettings(settingsOver);
  const svc = new WorkBoardService({
    machineId: 'm_a',
    emit: (_key, build) => {
      const hlc: HlcTimestamp = { physical: clock, logical: logical++, node: 'm_a' };
      const data = build(hlc, 'm_a'); if (!data) return { outcome: 'skipped' };
      if (!workCardRecordStoreSchema.validate(data, { countDroppedField: () => {} } as never)) return { outcome: 'dropped:invalid' };
      journal.push({ data, origin: 'm_a' }); return { outcome: 'emitted', seq: journal.length, hlc };
    },
    loadUnion: () => journal, now: () => clock, settings: () => settings, ownerPersonKey: () => 'justin',
    detectCredential: (t) => (/sk-ant-[A-Za-z0-9]{10,}/.test(t) ? 'anthropic-api-key' : null),
    dayOf: (ms) => ({ day: new Date(ms).toISOString().slice(0, 10), resetsAt: new Date(Math.ceil(ms / 86_400_000) * 86_400_000).toISOString() }),
    displayName: (k) => k,
  });
  svc.rebuild();
  const rows = new Map<string, GateCommitmentRow>();
  const annotations: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const superseded: string[][] = [];
  const telegramRows = new Map<string, TelegramRow>();
  const appRows = new Map<string, AppRow>();
  const devices = new Map<string, { status: string; revokedAt?: string; userId?: string; role?: 'owner' | 'msp' | 'team' }>();
  const notes: Array<{ cardId: string; text: string; by: string }> = [];
  const deps: RequestGateDeps = {
    svc, machineId: 'm_a', now: () => clock, settings: () => settings, ownerPersonKey: () => 'justin',
    detectCredential: (t) => (/sk-ant-[A-Za-z0-9]{10,}/.test(t) ? 'anthropic-api-key' : null),
    operatorConversation: (k) => (k.startsWith('telegram:') || k.startsWith('slack:') || /^[0-9a-f-]{36}$/.test(k) ? { ok: true, projectKey: k === 'telegram:42' ? 'telegram:42' : null } : { ok: false }),
    telegramRow: (topic, mid) => { const e = telegramRows.get(`${topic}:${mid}`); return e ? { entry: e } : { entry: null }; },
    appRow: (k, mid) => appRows.get(`${k}:${mid}`) ?? null,
    deviceRecord: (id) => devices.get(id) ?? null,
    telegramOwnerId: () => 777,
    teamPersonForTelegramId: (id) => (id === 888 ? 'adriana' : null),
    commitments: {
      list: () => [...rows.values()],
      annotate: (id, patch) => { annotations.push({ id, patch }); const r = rows.get(id); if (r) Object.assign(r, Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v === null ? undefined : v]))); },
      supersedeSentinels: (ck, ur, ar, by) => { superseded.push([ck, ur, ar, by]); return []; },
    },
    teamKey: () => 'justin',
    writeNote: (cardId, text, by) => { notes.push({ cardId, text, by }); return { ok: true, eventId: `wbn-${notes.length}` }; },
    ...over,
  };
  const gate = new WorkBoardRequestGate(deps);
  let n = 0;
  const commitment = (over: Partial<GateCommitmentRow> = {}): GateCommitmentRow => {
    n++;
    const c: GateCommitmentRow = { id: `CMT-${String(n).padStart(3, '0')}`, originMachineId: 'm_a', status: 'pending', createdAt: new Date(clock).toISOString(), source: 'agent', userRequest: 'Please fix the venue list', agentResponse: 'I will tidy the venue list today', topicId: 42, ...over };
    rows.set(c.id, c);
    return c;
  };
  return { svc, gate, rows, annotations, superseded, telegramRows, appRows, devices, notes, commitment, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

const TEXT = 'Please fix the venue list before Friday.';
const native = (over: Partial<TelegramRow> = {}): TelegramRow => ({ text: TEXT, fromUser: true, forwarded: false, telegramUserId: 777, ...over });

describe('verifySource: the requester from the durable row, per adapter arm', () => {
  it('owner native Telegram row with forwarded:false verifies as the owner, with the whole text and its hash', () => {
    const t = rig(); t.telegramRows.set('42:1001', native());
    expect(t.gate.verifySource('telegram:42', '1001')).toEqual({ sourceVerified: true, requesterPersonKey: 'justin', requesterIsOwner: true, requestText: TEXT, requestTextHash: requestTextHashOf(TEXT) });
  });
  it('a member linked by Telegram id verifies as a member; an unknown sender is no requester; agent-originated and relayed rows are no requester', () => {
    const t = rig();
    t.telegramRows.set('42:1', native({ telegramUserId: 888 }));
    t.telegramRows.set('42:2', native({ telegramUserId: 999 }));
    t.telegramRows.set('42:3', native({ fromUser: false }));
    t.telegramRows.set('42:4', native({ rowOrigin: 'a2a' }));
    t.telegramRows.set('42:5', native({ telegramUserId: undefined }));
    expect(t.gate.verifySource('telegram:42', '1')).toMatchObject({ sourceVerified: true, requesterPersonKey: 'adriana', requesterIsOwner: false });
    for (const m of ['2', '3', '4', '5']) expect(t.gate.verifySource('telegram:42', m), m).toEqual({ sourceVerified: false, sourceUnverifiedReason: 'no-requester' });
  });
  it('a forwarded row and a native row with forwarded undefined are unproven provenance', () => {
    const t = rig();
    t.telegramRows.set('42:1', native({ forwarded: true }));
    t.telegramRows.set('42:2', native({ forwarded: undefined }));
    expect(t.gate.verifySource('telegram:42', '1')).toEqual({ sourceVerified: false, sourceUnverifiedReason: 'unproven-provenance' });
    expect(t.gate.verifySource('telegram:42', '2')).toEqual({ sourceVerified: false, sourceUnverifiedReason: 'unproven-provenance' });
  });
  it('no message id, not found, unreadable, budget exceeded, too long and credential-shaped are each their own verdict', () => {
    const t = rig({ telegramRow: (topic, mid) => (mid === 7 ? { entry: null, unreadable: true } : mid === 8 ? { entry: null, budgetExceeded: true } : { entry: topic === 42 && mid === 9 ? native({ text: 'x'.repeat(SCHEMA_MAX.need + 1) }) : mid === 10 ? native({ text: 'use sk-ant-abcdefghijklmnop' }) : null }) });
    expect(t.gate.verifySource('telegram:42', null)).toEqual({ sourceVerified: false, sourceUnverifiedReason: 'no-message-id' });
    expect(t.gate.verifySource('telegram:42', 'abc')).toEqual({ sourceVerified: false, sourceUnverifiedReason: 'no-message-id' });
    expect(t.gate.verifySource(null, '1')).toEqual({ sourceVerified: false, sourceUnverifiedReason: 'no-message-id' });
    expect(t.gate.verifySource('telegram:42', '6')).toEqual({ sourceVerified: false, sourceUnverifiedReason: 'not-found' });
    expect(t.gate.verifySource('telegram:42', '7')).toEqual({ sourceVerified: false, sourceUnverifiedReason: 'unreadable' });
    expect(t.gate.verifySource('telegram:42', '8')).toEqual({ sourceVerified: false, sourceUnverifiedReason: 'budget-exceeded' });
    expect(t.gate.verifySource('telegram:42', '9')).toEqual({ sourceVerified: false, sourceUnverifiedReason: 'request-too-long' });
    expect(t.gate.verifySource('telegram:42', '10')).toEqual({ sourceVerified: false, sourceUnverifiedReason: 'credential-shaped' });
    const none = rig({ telegramRow: undefined, appRow: undefined });
    expect(none.gate.verifySource('telegram:42', '1')).toEqual({ sourceVerified: false, sourceUnverifiedReason: 'unreadable' });
    expect(none.gate.verifySource('0d1c5b2e-1111-4222-8333-444455556666', '1')).toEqual({ sourceVerified: false, sourceUnverifiedReason: 'unreadable' });
  });
  it('a mirrored (app-sent) Telegram row is proven by the device record held here: active, not revoked, role and person matching; a member\'s device never resolves to the owner', () => {
    const t = rig();
    t.devices.set('dev-owner', { status: 'active' });
    t.devices.set('dev-member', { status: 'active', userId: 'adriana', role: 'team' });
    t.devices.set('dev-revoked', { status: 'revoked', revokedAt: '2026-11-19T00:00:00Z' });
    t.telegramRows.set('42:1', native({ via: 'mobile-device', deviceId: 'dev-owner', senderRole: 'owner', forwarded: undefined }));
    t.telegramRows.set('42:2', native({ via: 'mobile-device', deviceId: 'dev-member', senderRole: 'team', senderPerson: { machineId: 'm_a', userId: 'adriana' }, teamPhone: true, forwarded: undefined }));
    t.telegramRows.set('42:3', native({ via: 'mobile-device', deviceId: 'dev-member', senderRole: 'owner', forwarded: undefined })); // role mismatch
    t.telegramRows.set('42:4', native({ via: 'mobile-device', deviceId: 'dev-revoked', senderRole: 'owner', forwarded: undefined }));
    t.telegramRows.set('42:5', native({ via: 'mobile-device', deviceId: 'dev-elsewhere', senderRole: 'owner', forwarded: undefined })); // record on another machine
    t.telegramRows.set('42:6', native({ via: 'mobile-device', deviceId: 'dev-member', senderRole: 'team', senderPerson: { machineId: 'm_b', userId: 'adriana' }, forwarded: undefined })); // person on another machine
    t.telegramRows.set('42:7', native({ via: 'mobile-device', senderRole: 'owner', teamPhone: true, forwarded: undefined })); // team phone with no device
    expect(t.gate.verifySource('telegram:42', '1')).toMatchObject({ sourceVerified: true, requesterPersonKey: 'justin', requesterIsOwner: true });
    expect(t.gate.verifySource('telegram:42', '2')).toMatchObject({ sourceVerified: true, requesterPersonKey: 'adriana', requesterIsOwner: false });
    for (const m of ['3', '4', '5', '6', '7']) expect(t.gate.verifySource('telegram:42', m), m).toEqual({ sourceVerified: false, sourceUnverifiedReason: 'unproven-provenance' });
  });
  it('an app conversation event is proven the same way; an event older than the sender fields, or an agent reply, never names a requester', () => {
    const t = rig(); const K = '0d1c5b2e-1111-4222-8333-444455556666';
    t.devices.set('dev-owner', { status: 'active' }); t.devices.set('dev-member', { status: 'active', userId: 'adriana', role: 'team' });
    t.appRows.set(`${K}:m1`, { role: 'operator', text: TEXT, deviceId: 'dev-owner', senderRole: 'owner' });
    t.appRows.set(`${K}:m2`, { role: 'operator', text: TEXT, deviceId: 'dev-member', senderRole: 'team', senderPerson: { machineId: 'm_a', userId: 'adriana' } });
    t.appRows.set(`${K}:m3`, { role: 'operator', text: TEXT, deviceId: 'dev-owner' }); // older event: no senderRole
    t.appRows.set(`${K}:m4`, { role: 'agent', text: 'done', deviceId: 'dev-owner', senderRole: 'owner' });
    expect(t.gate.verifySource(K, 'm1')).toMatchObject({ sourceVerified: true, requesterIsOwner: true });
    expect(t.gate.verifySource(K, 'm2')).toMatchObject({ sourceVerified: true, requesterPersonKey: 'adriana', requesterIsOwner: false });
    expect(t.gate.verifySource(K, 'm3')).toEqual({ sourceVerified: false, sourceUnverifiedReason: 'unproven-provenance' });
    expect(t.gate.verifySource(K, 'm4')).toEqual({ sourceVerified: false, sourceUnverifiedReason: 'no-requester' });
    expect(t.gate.verifySource(K, 'm9')).toEqual({ sourceVerified: false, sourceUnverifiedReason: 'not-found' });
  });
  it('Slack: no row seam ⇒ unproven provenance, which the verdict states; with the seam, the configured owner id with no bot marker verifies, a bot row does not', () => {
    const none = rig();
    expect(none.gate.verifySource('slack:C1:T1', 'm1')).toEqual({ sourceVerified: false, sourceUnverifiedReason: 'unproven-provenance' });
    const t = rig({ slackRow: (_c, _t, mid) => (mid === 'm1' ? { text: TEXT, user: 'U_OWNER', bot: false } : mid === 'm2' ? { text: TEXT, user: 'U_BOT', bot: true } : null), slackOwnerId: () => 'U_OWNER' });
    expect(t.gate.verifySource('slack:C1:T1', 'm1')).toMatchObject({ sourceVerified: true, requesterIsOwner: true });
    expect(t.gate.verifySource('slack:C1:T1', 'm2')).toEqual({ sourceVerified: false, sourceUnverifiedReason: 'no-requester' });
  });
  it('helpers: the Telegram topic of a key, and the conversation a commitment was recorded from', () => {
    expect(telegramTopicOf('telegram:42')).toBe(42); expect(telegramTopicOf('app:x')).toBeNull();
    expect(conversationKeyOf({ sourceConversationKey: 'slack:C:T' })).toBe('slack:C:T');
    expect(conversationKeyOf({ topicId: 42 })).toBe('telegram:42');
    expect(conversationKeyOf({})).toBeNull();
  });
});

describe('writeCard: one card per commitment, by identity', () => {
  it('an owner-verified request writes a held, request-approved card with the whole text as need, one Done item, the refs and the hold; the commitment is annotated; sentinels are superseded', () => {
    const t = rig();
    const c = t.commitment({ sourceConversationKey: 'telegram:42', sourceMessageId: '1001', sourceVerified: true, requesterPersonKey: 'justin', requesterIsOwner: true, requestText: TEXT, requestTextHash: requestTextHashOf(TEXT) });
    const r = t.gate.onRecorded(c)!;
    expect(r).toMatchObject({ written: true, cardId: requestCardId('m_a', c.id) });
    const v = t.svc.view(r.cardId)!;
    expect(v.card).toMatchObject({ need: TEXT, title: 'Please fix the venue list', outward: false, carrier: 'agent', projectKey: 'telegram:42', requestApproved: true, pickupHeld: true, source: { conversationKey: 'telegram:42', messageId: '1001' } });
    expect(v.card.doneWhen).toEqual([{ id: 'm1', text: 'Done: I will tidy the venue list today', certify: 'agent-may-certify' }]);
    expect(v.card.refs).toEqual([{ kind: 'commitment', id: `m_a:${c.id}` }]);
    expect(v.card.recordedInAgentWords).toBe(true); // userRequest differs from the row's text
    expect(v.status).toBe('with-agent');
    expect(t.annotations.at(-1)).toMatchObject({ id: c.id, patch: { cardId: r.cardId, cardWritten: true, cardPending: false } });
    expect(t.superseded).toEqual([['telegram:42', c.userRequest, c.agentResponse, c.id]]);
    // the second run links, never a second card
    const again = t.gate.onRecorded(c)!;
    expect(again).toMatchObject({ written: false, cardId: r.cardId });
    expect(t.svc.cardIds()).toHaveLength(1);
  });
  it('a member\'s request is not-started (unapproved); an unverified one too; an outward request becomes an ordinary ask with both fields filled; milestones become the items', () => {
    const t = rig();
    const m = t.gate.onRecorded(t.commitment({ sourceConversationKey: 'telegram:42', sourceMessageId: '1', sourceVerified: true, requesterPersonKey: 'adriana', requesterIsOwner: false, requestText: TEXT, requestTextHash: requestTextHashOf(TEXT) }))!;
    expect(t.svc.view(m.cardId)!.status).toBe('not-started');
    const u = t.gate.onRecorded(t.commitment({ sourceConversationKey: 'telegram:42', sourceMessageId: '2', sourceVerified: false, sourceUnverifiedReason: 'unproven-provenance' }))!;
    expect(t.svc.view(u.cardId)!.status).toBe('not-started');
    expect(t.svc.view(u.cardId)!.card.need).toBe('Please fix the venue list'); // cut userRequest, not a locked text
    expect(t.svc.view(u.cardId)!.card.needLockedToRequest).toBe(false);
    const o = t.gate.onRecorded(t.commitment({ sourceConversationKey: 'telegram:42', sourceMessageId: '3', outward: true, milestones: ['Email drafted', 'Email sent'] }))!;
    const ov = t.svc.view(o.cardId)!;
    expect(ov.status).toBe('needs-approval');
    expect(ov.card.recommendation).toBe('I will tidy the venue list today');
    expect(ov.card.whyYou).toBe('This request sends outside your team or spends money, so it waits for you.');
    expect(ov.card.doneWhen.map((d) => d.text)).toEqual(['Email drafted', 'Email sent']);
  });
  it('a commitment from no operator conversation gets a terminal reason and no card; a sentinel capture is never carded; the gate off writes nothing', () => {
    const t = rig({ operatorConversation: () => ({ ok: false }) });
    const c = t.commitment({ sourceConversationKey: 'telegram:42' });
    expect(t.gate.onRecorded(c)).toMatchObject({ written: false, reason: 'not-operator-conversation' });
    expect(t.annotations.at(-1)).toMatchObject({ id: c.id, patch: { cardPending: false, cardReason: 'not-operator-conversation' } });
    expect(t.gate.onRecorded(t.commitment({ source: 'sentinel' }))).toBeNull();
    const off = rig({}, { requestCards: { enabled: false } });
    expect(off.gate.onRecorded(off.commitment())).toBeNull();
    expect(off.gate.sweep().written).toBe(0);
  });
  it('the daily ceiling is a retryable refusal: cardPending with the reason and cardRefused; the sweep writes the card after the reset', () => {
    const t = rig({}, { maxAgentCardsPerDay: 1 });
    expect(t.gate.onRecorded(t.commitment({ sourceConversationKey: 'telegram:42', sourceMessageId: '1' }))!.written).toBe(true);
    const c2 = t.commitment({ sourceConversationKey: 'telegram:42', sourceMessageId: '2' });
    expect(t.gate.onRecorded(c2)).toMatchObject({ written: false, reason: 'daily-card-ceiling', retryable: true });
    expect(t.annotations.at(-1)).toMatchObject({ id: c2.id, patch: { cardPending: true, cardReason: 'daily-card-ceiling', cardRefused: 'daily-card-ceiling' } });
    expect(t.gate.needsCard().map((c) => c.id)).toEqual([c2.id]);
    t.advance(86_400_000);
    const s = t.gate.sweep();
    expect(s.written).toBe(1);
    expect(t.gate.needsCard()).toEqual([]);
  });
  it('a commitment recorded from a card\'s own conversation links to that card (a pickup session records against its card)', () => {
    const t = rig();
    const first = t.gate.onRecorded(t.commitment({ sourceConversationKey: 'telegram:42', sourceMessageId: '1' }))!;
    const ck = t.svc.view(first.cardId)!.card.conversationKey;
    const c2 = t.commitment({ sourceConversationKey: ck, sourceMessageId: 'n1' });
    const r = t.gate.onRecorded(c2)!;
    expect(r).toMatchObject({ cardId: first.cardId, written: false, linked: true });
    expect(t.svc.view(first.cardId)!.card.refs.map((x) => x.id)).toEqual([`m_a:${first.cardId === requestCardId('m_a', 'CMT-001') ? 'CMT-001' : ''}`, `m_a:${c2.id}`]);
    expect(t.svc.cardIds()).toHaveLength(1);
  });
});

describe('the sweep', () => {
  it('writes enabled-at once, backfills recent open requests uncounted and held as backfill, skips stale ones with a terminal reason, paces, and repairs refs; a replica\'s card uses the replicated text', () => {
    const t = rig({}, { requestCards: { sweepPerTick: 2, backfillMaxAgeDays: 14 }, maxAgentCardsPerDay: 1 });
    const stale = t.commitment({ sourceConversationKey: 'telegram:42', sourceMessageId: '0', createdAt: new Date(t.now() - 20 * 86_400_000).toISOString() });
    const recent = [1, 2, 3].map((i) => t.commitment({ sourceConversationKey: 'telegram:42', sourceMessageId: String(i), createdAt: new Date(t.now() - i * 60_000).toISOString() }));
    const replica = t.commitment({ originMachineId: 'm_b', sourceConversationKey: 'telegram:42', sourceMessageId: '9', sourceVerified: true, requesterPersonKey: 'justin', requesterIsOwner: true, requestText: TEXT, requestTextHash: requestTextHashOf(TEXT), createdAt: new Date(t.now() - 30_000).toISOString() });
    t.commitment({ status: 'delivered', sourceConversationKey: 'telegram:42' }); // closed: never in the set
    expect(t.svc.enabledAt('justin')).toBeNull();
    const s1 = t.gate.sweep();
    expect(s1.enabledAt).not.toBeNull();
    expect(s1.skipped).toBe(1); // the stale one
    expect(t.annotations.some((a) => a.id === stale.id && a.patch.cardReason === 'backfill-skipped-stale')).toBe(true);
    expect(s1.written).toBe(2); // paced: two per tick, oldest first; the daily ceiling does not count backfill
    const s2 = t.gate.sweep();
    expect(s2.written).toBe(2);
    expect(t.gate.needsCard()).toEqual([]);
    for (const c of recent) { const id = requestCardId('m_a', c.id); expect(t.svc.view(id)!.card.pickupHold).toEqual({ kind: 'backfill' }); }
    const rv = t.svc.view(requestCardId('m_b', replica.id))!;
    expect(rv.card.need).toBe(TEXT); expect(rv.card.requestApproved).toBe(true);
    expect(t.annotations.some((a) => a.id === replica.id)).toBe(false); // a replica is never annotated
    expect(t.svc.markEnabledAt('justin')).toMatchObject({ ok: true, duplicate: true });
    // a missing ref on the card is repaired on the next pass
    const cid = requestCardId('m_a', recent[0].id);
    t.svc.edit({ kind: 'agent', server: true }, cid, { refs: [] });
    expect(t.gate.cardFor(recent[0])).toBe(cid); // the derived id still answers
    t.gate.sweep();
    expect(t.svc.view(cid)!.card.refs).toEqual([{ kind: 'commitment', id: `m_a:${recent[0].id}` }]);
  });
  it('the first run waits for every live peer', () => {
    const t = rig({ caughtUpWithAllPeers: () => false });
    t.commitment({ sourceConversationKey: 'telegram:42', sourceMessageId: '1' });
    expect(t.gate.sweep()).toMatchObject({ written: 0, enabledAt: null });
    expect(t.svc.enabledAt('justin')).toBeNull();
  });
});

describe('deliver', () => {
  it('runs the gate first on a cardless commitment, writes a note, evidence only with itemId and text, and a claim only when that was the last item', () => {
    const t = rig();
    const c = t.commitment({ sourceConversationKey: 'telegram:42', sourceMessageId: '1', sourceVerified: true, requesterPersonKey: 'justin', requesterIsOwner: true, requestText: TEXT, requestTextHash: requestTextHashOf(TEXT), milestones: ['Draft', 'Send'] });
    const d1 = t.gate.onDeliver(c, { deliveryMessageId: '5' });
    expect(d1).toMatchObject({ cardId: requestCardId('m_a', c.id), noted: true, evidenced: false, claimed: false });
    expect(t.notes[0]).toMatchObject({ text: 'Delivered: message 5', by: 'server:commitment-deliver' });
    const d2 = t.gate.onDeliver(c, { evidence: 'Drafted the email', itemId: 'm1' });
    expect(d2).toMatchObject({ evidenced: true, claimed: false });
    const d3 = t.gate.onDeliver(c, { evidence: 'Sent it', itemId: 'm2' });
    expect(d3).toMatchObject({ evidenced: true, claimed: true });
    expect(t.svc.view(d3.cardId!)!.card.done).toBe(true);
    const bad = t.gate.onDeliver(c, { evidence: 'x', itemId: 'nope' });
    expect(bad.refusal).toBe('unknown-item');
  });
  it('a person-written card accepts the owner tap, and a delivery with evidence but no item writes a note only', () => {
    const t = rig();
    const c = t.commitment({ sourceConversationKey: 'telegram:42', sourceMessageId: '1' });
    t.gate.onRecorded(c);
    const id = requestCardId('m_a', c.id);
    expect(t.svc.tap(OWNER, id, { action: 'approve', materialHash: t.svc.view(id)!.card.materialHash }).ok).toBe(true);
    const d = t.gate.onDeliver(c, { evidence: 'I replied' });
    expect(d).toMatchObject({ noted: true, evidenced: false, claimed: false });
    expect(t.notes.at(-1)!.text).toBe('Delivered: I replied');
  });
});
