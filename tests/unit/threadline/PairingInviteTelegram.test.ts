/**
 * Telegram surface for invite pairing (docs/specs/a2a-pairing-invite-link.md §6.1):
 * who may open a prompt, who may tap, one decision per prompt, and the operator notices.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PairingInviteTelegram, CALLBACK_PREFIX, resolveApprovalOwner, NO_OWNER_REFUSAL, NOT_OWNER_REFUSAL, NOT_OWNER_DASHBOARD_LINE,
} from '../../../src/threadline/PairingInviteTelegram.js';
import { TopicOperatorStore } from '../../../src/users/TopicOperatorStore.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { createInvite, inviteMessage, findInviteToken, decodeInvite } from '../../../src/threadline/PairingInvite.js';
import type { OperatorLinkOrigin } from '../../../src/server/dashboardPaths.js';

const OWNER = 4242;
const INVITE = inviteMessage(createInvite({ identityPubHex: crypto.randomBytes(32).toString('hex'), owner: 'Justin', agent: 'Scout' }));
const IID = 'ab'.repeat(16);

function setup(opts: { enforcing?: boolean; operatorTopic?: number | undefined; now?: () => number; owner?: () => number | undefined; dashboardOrigin?: () => OperatorLinkOrigin; topics?: Map<string, number> } = {}) {
  const calls: string[] = [];
  const sent: Array<{ topicId: number; text: string; buttons?: Array<{ text: string; data: string }> }> = [];
  const answers: string[] = [];
  const events = new EventEmitter();
  let enforcing = opts.enforcing ?? true;
  const ok = (name: string) => (iid: string) => { calls.push(`${name}:${iid}`); return { ok: true as const }; };
  const tg = new PairingInviteTelegram({
    flow: {
      receiveInvite: async (text: string) => { calls.push('receive'); return decodeInvite(findInviteToken(text) ?? '').ok ? { ok: true, iid: IID, claimedAgent: 'Scout', claimedOwner: 'Justin', checkCode: 'K7Q2' } : { ok: false, reason: 'bad' }; },
      approveAccept: ok('approve'), declineAccept: ok('decline'), approveFinish: ok('finish'), rejectFinish: ok('not-them'),
    },
    events,
    send: async (topicId, text, buttons) => { sent.push({ topicId, text, buttons }); },
    answer: async (_id, text) => { answers.push(text); },
    ownerUserId: opts.owner ?? (() => OWNER),
    chatId: () => '-100',
    operatorTopicId: () => ('operatorTopic' in opts ? opts.operatorTopic : 7),
    enforcing: () => enforcing,
    now: opts.now,
    dashboardOrigin: opts.dashboardOrigin,
    topics: opts.topics ? { get: (iid: string) => opts.topics!.get(iid), set: (iid: string, t: number) => { opts.topics!.set(iid, t); } } : undefined,
  });
  return { tg, calls, sent, answers, events, setEnforcing: (v: boolean) => { enforcing = v; } };
}

const okForward = { text: `here: ${INVITE}`, topicId: 9, fromUserId: OWNER, verified: true };
const tap = (data: string, over: Partial<{ fromUserId: number; verified: boolean; chatId: string | undefined }> = {}) =>
  ({ callbackQueryId: 'q', data, fromUserId: OWNER, verified: true, chatId: '-100', ...over });

describe('PairingInviteTelegram', () => {
  it('detects invites, and scrubs the secret out of text', () => {
    expect(PairingInviteTelegram.carriesInvite(`Fwd: ${INVITE}`)).toBe(true);
    expect(PairingInviteTelegram.carriesInvite('tlinv1 is the prefix')).toBe(false);
    const token = findInviteToken(INVITE)!;
    expect(PairingInviteTelegram.scrub(`x ${token} y`)).toBe('x tlinv1:[removed] y');
    expect(PairingInviteTelegram.scrub(INVITE)).not.toContain(token);
  });

  it('the owner, verified, enforcing: opens an Approve/Decline prompt in the same topic', async () => {
    const { tg, sent, calls } = setup();
    // Waiting on Approve/Decline is neither refused nor connected (the lifeline may acknowledge it).
    expect(await tg.onForwardedInvite(okForward)).toEqual({ outcome: 'awaiting-approval', refused: false });
    expect(calls).toEqual(['receive']);
    expect(sent[0].topicId).toBe(9);
    expect(sent[0].text).toContain('calls itself "Scout"');
    expect(sent[0].buttons?.map((b) => b.text)).toEqual(['Approve', 'Decline']);
    expect(sent[0].buttons!.every((b) => b.data.startsWith(CALLBACK_PREFIX) && Buffer.byteLength(b.data) <= 64)).toBe(true);
  });

  it.each([
    ['not verified (no lifeline secret)', { verified: false }],
    ['not the owner', { fromUserId: 1 }],
    ['no sender id (an unverified forward had it removed)', { fromUserId: undefined }],
  ])('a forwarded invite opens NO prompt when %s, and points at the dashboard', async (_n, over) => {
    const { tg, sent, calls } = setup();
    expect(await tg.onForwardedInvite({ ...okForward, ...over } as never)).toEqual({ outcome: 'refused', refused: true });
    expect(calls).toEqual([]);
    expect(sent[0].buttons).toBeUndefined();
    expect(sent[0].text).toMatch(/dashboard/);
  });

  it('observe mode: Telegram approval is off', async () => {
    const { tg, sent, calls } = setup({ enforcing: false });
    expect(await tg.onForwardedInvite(okForward)).toEqual({ outcome: 'refused', refused: true });
    expect(calls).toEqual([]);
    expect(sent[0].text).toMatch(/dashboard/);
  });

  it('an unusable invite is reported, with no buttons', async () => {
    const { tg, sent } = setup();
    expect(await tg.onForwardedInvite({ ...okForward, text: 'tlinv1:AAAA.BBBB' })).toEqual({ outcome: 'invalid', refused: true });
    expect(sent[0].text).toContain("can't use that pairing invite");
    expect(sent[0].buttons).toBeUndefined();
  });

  it('a tap acts once: Approve calls the engine, and the sibling Decline is spent too', async () => {
    const { tg, sent, calls, answers } = setup();
    await tg.onForwardedInvite(okForward);
    const [approve, decline] = sent[0].buttons!;
    expect(await tg.onCallback(tap(approve.data))).toBe(true);
    expect(calls).toContain(`approve:${IID}`);
    await tg.onCallback(tap(approve.data));
    await tg.onCallback(tap(decline.data));
    expect(calls.filter((c) => c !== 'receive')).toEqual([`approve:${IID}`]);
    expect(answers.at(-1)).toMatch(/expired or was already used/);
  });

  it.each([
    ['unverified tap', { verified: false }],
    ['another member of the group', { fromUserId: 99 }],
    ['wrong chat', { chatId: '-200' }],
    ['a tap that names no chat', { chatId: undefined }],
  ])('%s is refused and does NOT spend the button', async (_n, over) => {
    const { tg, sent, calls } = setup();
    await tg.onForwardedInvite(okForward);
    const approve = sent[0].buttons![0].data;
    await tg.onCallback(tap(approve, over));
    expect(calls).toEqual(['receive']);
    await tg.onCallback(tap(approve)); // the real owner can still use it
    expect(calls).toEqual(['receive', `approve:${IID}`]);
  });

  it('a tap after the guard dropped to observe is refused', async () => {
    const { tg, sent, calls, setEnforcing } = setup();
    await tg.onForwardedInvite(okForward);
    setEnforcing(false);
    await tg.onCallback(tap(sent[0].buttons![0].data));
    expect(calls).toEqual(['receive']);
  });

  it('a button expires after 24 hours', async () => {
    let t = 1_000_000;
    const { tg, sent, calls, answers } = setup({ now: () => t });
    await tg.onForwardedInvite(okForward);
    t += 24 * 60 * 60_000 + 1;
    await tg.onCallback(tap(sent[0].buttons![0].data));
    expect(calls).toEqual(['receive']);
    expect(answers.at(-1)).toMatch(/expired/);
  });

  it('data that is not ours is left to the caller; a forged token does nothing', async () => {
    const { tg, calls, answers } = setup();
    expect(await tg.onCallback(tap('tc:g:abc'))).toBe(false);
    expect(await tg.onCallback(tap(`${CALLBACK_PREFIX}${'0'.repeat(24)}`))).toBe(true);
    expect(calls).toEqual([]);
    expect(answers[0]).toMatch(/expired/);
  });

  it('a finish prompt goes to the operator topic with Finish / Not them, and a tap finishes', async () => {
    const { tg, sent, calls, events } = setup();
    events.emit('event', { kind: 'finish-prompt', iid: IID, claimedAgent: 'Carl', claimedOwner: 'Carl O', acceptorFp: 'f'.repeat(32), checkCode: 'AB12' });
    await new Promise((r) => setImmediate(r));
    expect(sent[0].topicId).toBe(7);
    expect(sent[0].buttons?.map((b) => b.text)).toEqual(['Finish', 'Not them']);
    await tg.onCallback(tap(sent[0].buttons![0].data));
    expect(calls).toEqual([`finish:${IID}`]);
  });

  it('when not enforcing, a finish prompt has no buttons and points at the dashboard', async () => {
    const { sent, events } = setup({ enforcing: false });
    events.emit('event', { kind: 'finish-prompt', iid: IID, claimedAgent: 'Carl', claimedOwner: '', acceptorFp: 'f'.repeat(32), checkCode: 'AB12' });
    await new Promise((r) => setImmediate(r));
    expect(sent[0].buttons).toBeUndefined();
    expect(sent[0].text).toMatch(/dashboard/);
  });

  it('the leak alarm and the used-elsewhere notice reach the operator', async () => {
    const { sent, events } = setup();
    events.emit('event', { kind: 'second-accept-alarm', iid: IID, pausedFp: 'a'.repeat(32), lateFp: 'b'.repeat(32), lateClaimedAgent: 'Mallory', lateClaimedOwner: 'M' });
    events.emit('event', { kind: 'invite-used-elsewhere', iid: IID, inviterFp: 'c'.repeat(32) });
    await new Promise((r) => setImmediate(r));
    expect(sent.map((s) => s.text).join('\n')).toMatch(/two agents used the same pairing invite[\s\S]*already been used/);
  });

  it('says it cannot tell who approves connections for it (not "only the approver") when it can name nobody', async () => {
    const { tg, sent, calls } = setup({ owner: () => undefined });
    expect(await tg.onForwardedInvite(okForward)).toEqual({ outcome: 'refused', refused: true });
    expect(calls).toEqual([]);
    // The approver is THIS agent's human, never the owner the invite claims ("Justin" here),
    // and the line does not claim the setting is missing (it may be ambiguous or invalid).
    expect(sent[0].text).toMatch(/approve new connections for me/);
    expect(sent[0].text).not.toMatch(/Justin|its owner|hasn't been told/);
    expect(sent[0].text).toContain(NO_OWNER_REFUSAL);
    expect(sent[0].text).not.toContain(NOT_OWNER_REFUSAL);
    expect(sent[0].text).toMatch(/dashboard/);
  });

  it('a genuine non-approver hears that only the person who approves connections for this agent can do it', async () => {
    const { tg, sent } = setup();
    expect(await tg.onForwardedInvite({ ...okForward, fromUserId: 1 })).toEqual({ outcome: 'refused', refused: true });
    expect(sent[0].text).not.toContain(String(OWNER));
    expect(sent[0].text).toContain(NOT_OWNER_REFUSAL);
    expect(sent[0].text).not.toContain(NO_OWNER_REFUSAL);
  });
});

describe('resolveApprovalOwner (who may approve when no owner id is configured)', () => {
  const OP = 7812716706;
  let dir: string;
  let store: TopicOperatorStore;
  const evidence = (uid: number, messageId = '11') => ({
    kind: 'authenticated-inbound' as const, ingress: 'telegram-lifeline-forward' as const,
    authorization: 'telegram-is-authorized-sender' as const, senderUid: String(uid), messageId,
  });
  const bindVerified = (topic: number, uid: number) =>
    store.setAuthenticatedOperator(topic, { platform: 'telegram', uid: String(uid), displayName: 'Justin' }, evidence(uid));
  const bindings = () => Object.values(store.allBindings());
  const ever = () => store.everVerifiedOperatorUids();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-owner-'));
    store = new TopicOperatorStore(dir);
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/threadline/PairingInviteTelegram.test.ts' }); });

  it('a configured owner wins, whatever the bindings say', () => {
    bindVerified(3, 555);
    expect(resolveApprovalOwner(OWNER, bindings(), ever())).toBe(OWNER);
  });

  it('a configured owner written as a string still counts; a malformed one means no owner, never the bindings', () => {
    bindVerified(3, 555);
    expect(resolveApprovalOwner(String(OWNER), bindings(), ever())).toBe(OWNER);
    expect(resolveApprovalOwner('not-an-id', bindings(), ever())).toBeUndefined();
    expect(resolveApprovalOwner(-5, bindings(), ever())).toBeUndefined();
  });

  it('no owner + exactly one verified operator (on one or several topics) → that operator', () => {
    expect(bindVerified(3, OP)).not.toBeNull();
    expect(resolveApprovalOwner(undefined, bindings(), ever())).toBe(OP);
    bindVerified(9, OP);
    expect(resolveApprovalOwner(undefined, bindings(), ever())).toBe(OP);
  });

  it('no owner + two different verified operators → nobody (never pick one)', () => {
    bindVerified(3, OP);
    bindVerified(9, 555);
    expect(resolveApprovalOwner(undefined, bindings(), ever())).toBeUndefined();
  });

  it('no owner + no bindings → nobody', () => {
    expect(resolveApprovalOwner(undefined, bindings(), ever())).toBeUndefined();
    expect(resolveApprovalOwner(undefined, null, null)).toBeUndefined();
  });

  it('a manually asserted record (POST /topic-operator) never counts', () => {
    expect(store.setOperator(3, { platform: 'telegram', uid: String(OP), displayName: 'Justin' })).not.toBeNull();
    expect(bindings(), ever()).toHaveLength(1);
    expect(resolveApprovalOwner(undefined, bindings(), ever())).toBeUndefined();
  });

  it('an asserted record for someone else does not make a verified operator ambiguous, nor stand in for one', () => {
    bindVerified(3, OP);
    store.setOperator(9, { platform: 'telegram', uid: '555' });
    expect(resolveApprovalOwner(undefined, bindings(), ever())).toBe(OP);
  });

  it('owner, then a second group member speaks last in the SAME topic → nobody (latest binding is the member)', () => {
    bindVerified(3, OP);
    expect(resolveApprovalOwner(undefined, bindings(), ever())).toBe(OP);
    bindVerified(3, 555); // replaces the owner's binding on topic 3
    expect(store.getOperator(3)?.uid).toBe('555');
    expect(Object.keys(store.all())).toEqual(['3']); // current bindings name only the member
    expect(ever()).toEqual([String(OP), '555']);
    expect(resolveApprovalOwner(undefined, bindings(), ever())).toBeUndefined();
    bindVerified(3, OP); // the owner speaking again does not undo the history
    expect(resolveApprovalOwner(undefined, bindings(), ever())).toBeUndefined();
  });

  it('the current bindings must name the one ever-verified id (a mismatch or a missing history is no owner)', () => {
    bindVerified(3, OP);
    expect(resolveApprovalOwner(undefined, bindings(), ['555'])).toBeUndefined();
    expect(resolveApprovalOwner(undefined, bindings(), [])).toBeUndefined();
    expect(resolveApprovalOwner(undefined, bindings(), null)).toBeUndefined();
  });

  it('two current verified operators refuse even if the history (e.g. a hand-edited file) names only one', () => {
    bindVerified(3, OP);
    bindVerified(9, 555);
    expect(resolveApprovalOwner(undefined, bindings(), [String(OP)])).toBeUndefined();
  });

  it('an assertion that overwrites a verified binding neither erases nor adds to the ever-verified record', () => {
    bindVerified(3, OP);
    bindVerified(9, 555);
    store.setOperator(9, { platform: 'telegram', uid: String(OP) }); // wipes 555's verified binding on topic 9
    expect(Object.keys(store.all())).toEqual(['3']);
    expect(ever()).toEqual([String(OP), '555']);
    expect(resolveApprovalOwner(undefined, bindings(), ever())).toBeUndefined();
    store.setOperator(12, { platform: 'telegram', uid: '999' });
    expect(ever()).toEqual([String(OP), '555']);
    // and it survives a reload from disk
    expect(new TopicOperatorStore(dir).everVerifiedOperatorUids()).toEqual([String(OP), '555']);
  });

  it('upgrade: state written before the record existed is seeded from the current verified bindings', () => {
    const verified = (uid: number) => ({ platform: 'telegram', uid: String(uid), names: ['justin'], boundAt: '', boundFrom: 'authenticated-inbound', establishmentEvidence: evidence(uid) });
    fs.writeFileSync(path.join(dir, 'topic-operators.json'), JSON.stringify({
      '3': verified(OP),
      '9': { platform: 'telegram', uid: '555', names: [], boundAt: '', boundFrom: 'operator-api-assertion', establishmentEvidence: { kind: 'operator-api-assertion', route: 'POST /topic-operator' } },
    }));
    const s1 = new TopicOperatorStore(dir);
    expect(s1.everVerifiedOperatorUids()).toEqual([String(OP)]); // the assertion is not seeded
    expect(resolveApprovalOwner(undefined, Object.values(s1.allBindings()), s1.everVerifiedOperatorUids())).toBe(OP);
    // two verified people already in the old state → seeded as two → no owner
    fs.writeFileSync(path.join(dir, 'topic-operators.json'), JSON.stringify({ '3': verified(OP), '9': verified(555) }));
    const s2 = new TopicOperatorStore(dir);
    expect(s2.everVerifiedOperatorUids()).toEqual([String(OP), '555']);
    expect(resolveApprovalOwner(undefined, Object.values(s2.allBindings()), s2.everVerifiedOperatorUids())).toBeUndefined();
  });

  it('an unreadable ever-verified record fails closed, with a visible marker (never read as empty)', () => {
    const verified = { platform: 'telegram', uid: String(OP), names: [], boundAt: '', boundFrom: 'authenticated-inbound', establishmentEvidence: evidence(OP) };
    fs.writeFileSync(path.join(dir, 'topic-operators.json'), JSON.stringify({ '3': verified, _everVerifiedOperators: { telegram: 'oops' } }));
    const s1 = new TopicOperatorStore(dir);
    expect(s1.everVerifiedOperatorUids()).toBeNull();
    expect(resolveApprovalOwner(undefined, Object.values(s1.allBindings()), s1.everVerifiedOperatorUids())).toBeUndefined();
    expect(s1.getBinding('_everVerifiedOperators')).toBeNull(); // the reserved key is never a binding
  });

  // Echo review #1: a CORRUPT FILE (not just a corrupt record) must also fail closed. Before the
  // fix it read as "pre-upgrade, seed from nothing", so the next member to speak became the approver.
  it.each([
    ['unparseable JSON', '{not-json'],
    ['a null top level', 'null'],
    ['an array top level', '[]'],
    ['a scalar top level', '42'],
  ])('a corrupt file (%s) is unreadable history: a non-owner member who binds next is NOT the approver', (_n, body) => {
    fs.writeFileSync(path.join(dir, 'topic-operators.json'), body);
    const s1 = new TopicOperatorStore(dir);
    expect(s1.everVerifiedOperatorUids()).toBeNull();
    s1.setAuthenticatedOperator(3, { platform: 'telegram', uid: '555', displayName: 'Member' }, evidence(555));
    expect(s1.getOperator(3)?.uid).toBe('555');
    expect(resolveApprovalOwner(undefined, Object.values(s1.allBindings()), s1.everVerifiedOperatorUids())).toBeUndefined();
    // …and after that write, a reload still refuses.
    const s2 = new TopicOperatorStore(dir);
    expect(resolveApprovalOwner(undefined, Object.values(s2.allBindings()), s2.everVerifiedOperatorUids())).toBeUndefined();
  });

  it('the unreadable marker survives save() and a reload, written explicitly rather than as fake ids', () => {
    fs.writeFileSync(path.join(dir, 'topic-operators.json'), '{not-json');
    const s1 = new TopicOperatorStore(dir);
    s1.setAuthenticatedOperator(3, { platform: 'telegram', uid: String(OP) }, evidence(OP));
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'topic-operators.json'), 'utf-8'));
    expect(onDisk._everVerifiedOperators).toEqual({ telegram: [String(OP)], unreadable: true });
    const s2 = new TopicOperatorStore(dir);
    expect(s2.everVerifiedOperatorUids()).toBeNull();
    expect(resolveApprovalOwner(undefined, Object.values(s2.allBindings()), s2.everVerifiedOperatorUids())).toBeUndefined();
    // documented repair: delete the _everVerifiedOperators key → re-seeded from current verified bindings
    delete onDisk._everVerifiedOperators;
    fs.writeFileSync(path.join(dir, 'topic-operators.json'), JSON.stringify(onDisk));
    const s3 = new TopicOperatorStore(dir);
    expect(s3.everVerifiedOperatorUids()).toEqual([String(OP)]);
    expect(resolveApprovalOwner(undefined, Object.values(s3.allBindings()), s3.everVerifiedOperatorUids())).toBe(OP);
  });

  it('an ABSENT file (fresh install) seeds exactly as before: the owner binds, approval works', () => {
    expect(fs.existsSync(path.join(dir, 'topic-operators.json'))).toBe(false);
    expect(store.everVerifiedOperatorUids()).toEqual([]);
    bindVerified(3, OP);
    expect(resolveApprovalOwner(undefined, bindings(), ever())).toBe(OP);
    const reloaded = new TopicOperatorStore(dir);
    expect(reloaded.everVerifiedOperatorUids()).toEqual([String(OP)]);
    expect(resolveApprovalOwner(undefined, Object.values(reloaded.allBindings()), reloaded.everVerifiedOperatorUids())).toBe(OP);
  });

  it('only numeric ids are recorded, so a non-numeric uid can never make the record unreadable on reload', () => {
    store.setAuthenticatedOperator(3, { platform: 'telegram', uid: 'abc' }, { ...evidence(OP), senderUid: 'abc' });
    expect(store.getOperator(3)?.uid).toBe('abc'); // the binding itself is the store's existing behaviour
    expect(ever()).toEqual([]);
    bindVerified(9, OP);
    const reloaded = new TopicOperatorStore(dir);
    expect(reloaded.everVerifiedOperatorUids()).toEqual([String(OP)]);
    // the non-numeric binding is still a second current principal → no owner
    expect(resolveApprovalOwner(undefined, Object.values(reloaded.allBindings()), reloaded.everVerifiedOperatorUids())).toBeUndefined();
  });

  it('a legacy or self-described record without evidence (someone who merely messaged) never counts', () => {
    const forged = { platform: 'telegram', uid: String(OP), names: [], boundAt: '', boundFrom: 'authenticated-inbound' };
    expect(resolveApprovalOwner(undefined, [forged], [String(OP)])).toBeUndefined();
    const mismatched = { ...forged, establishmentEvidence: evidence(555) };
    expect(resolveApprovalOwner(undefined, [mismatched], [String(OP)])).toBeUndefined();
  });

  it('a verified binding on another platform does not count as a Telegram owner', () => {
    const wa = { platform: 'whatsapp', uid: String(OP), names: [], boundAt: '', boundFrom: 'authenticated-inbound', establishmentEvidence: evidence(OP) };
    expect(resolveApprovalOwner(undefined, [wa], [String(OP)])).toBeUndefined();
  });

  it('end to end: no owner configured, the verified operator forwards → Approve prompt; anyone else → non-owner refusal', async () => {
    bindVerified(3, OP);
    const owner = () => resolveApprovalOwner(undefined, bindings(), ever());
    const a = setup({ owner });
    await a.tg.onForwardedInvite({ ...okForward, fromUserId: OP });
    expect(a.sent[0].buttons?.map((b) => b.text)).toEqual(['Approve', 'Decline']);
    await a.tg.onCallback(tap(a.sent[0].buttons![0].data, { fromUserId: OP }));
    expect(a.calls).toEqual(['receive', `approve:${IID}`]);

    const b = setup({ owner });
    await b.tg.onForwardedInvite({ ...okForward, fromUserId: 555 });
    expect(b.calls).toEqual([]);
    expect(b.sent[0].text).toContain(NOT_OWNER_REFUSAL);
  });
});

describe('every dashboard redirect carries a direct link (topic 10000002573)', () => {
  const PUBLIC = () => ({ kind: 'public' as const, origin: 'https://cora.example.dev' });
  const PASTE_URL = 'https://cora.example.dev/dashboard/console/#/people/agents?connect=paste';
  const PAGE_URL = 'https://cora.example.dev/dashboard/console/#/people/agents';

  it('no owner set (Cora, Nov 11): the refusal links straight to the paste box, and the invite is not in it', async () => {
    const { tg, sent, calls } = setup({ owner: () => undefined, dashboardOrigin: PUBLIC });
    await tg.onForwardedInvite(okForward);
    expect(calls).toEqual([]);
    expect(sent[0].text).toContain(NO_OWNER_REFUSAL);
    expect(sent[0].text).toContain(`Paste the invite on the dashboard with your PIN: ${PASTE_URL}`);
    expect(sent[0].text).not.toContain('Threadline tab');
    expect(sent[0].text).not.toContain(findInviteToken(INVITE)!);
    expect(sent[0].text).not.toContain('tlinv1:');
  });

  it('no address the phone can open: says so plainly instead of a bare "open the tab"', async () => {
    const pending = setup({ owner: () => undefined, dashboardOrigin: () => ({ kind: 'pending' }) });
    await pending.tg.onForwardedInvite(okForward);
    expect(pending.sent[0].text).toContain("can't give you a link yet");
    const unknown = setup({ owner: () => undefined });
    await unknown.tg.onForwardedInvite(okForward);
    expect(unknown.sent[0].text).toContain("I don't know this agent's dashboard address");
    const thrown = setup({ owner: () => undefined, dashboardOrigin: () => { throw new Error('boom'); } });
    await thrown.tg.onForwardedInvite(okForward);
    expect(thrown.sent[0].text).toContain("I don't know this agent's dashboard address");
  });

  it('a refused tap: the toast points at a link posted in the invite\'s topic, once per invite', async () => {
    const { tg, sent, answers, setEnforcing } = setup({ dashboardOrigin: PUBLIC, topics: new Map() });
    await tg.onForwardedInvite(okForward);
    const approve = sent[0].buttons![0].data;
    setEnforcing(false);
    await tg.onCallback(tap(approve));
    expect(answers.at(-1)).toContain('I posted the dashboard link in this chat.');
    expect(sent.at(-1)).toMatchObject({ topicId: 9 });
    expect(sent.at(-1)!.text).toBe(`Decide on this pairing on the dashboard with your PIN: ${PAGE_URL}`);
    const before = sent.length;
    await tg.onCallback(tap(approve));
    expect(sent.length).toBe(before); // a repeated tap does not repeat the post
    expect(answers.at(-1)).toContain('The dashboard link is in this chat.');
  });

  it('an expired button: the link goes to the Lifeline topic; with no topic at all the toast says where to go', async () => {
    const { tg, sent, answers } = setup({ dashboardOrigin: PUBLIC });
    await tg.onCallback(tap(`${CALLBACK_PREFIX}${'00'.repeat(12)}`));
    expect(answers.at(-1)).toMatch(/expired or was already used\. I posted the dashboard link/);
    expect(sent.at(-1)).toMatchObject({ topicId: 7, text: `See where this pairing stands on the dashboard with your PIN: ${PAGE_URL}` });
    const none = setup({ operatorTopic: undefined, dashboardOrigin: PUBLIC });
    await none.tg.onCallback(tap(`${CALLBACK_PREFIX}${'00'.repeat(12)}`));
    expect(none.answers.at(-1)).toContain("Other agents page");
  });

  it('someone known not to be the approver gets no dashboard address, in the chat or the toast', async () => {
    const { tg, sent, answers } = setup({ dashboardOrigin: PUBLIC, topics: new Map() });
    await tg.onForwardedInvite({ ...okForward, fromUserId: 999 });
    expect(sent[0].text).toContain(NOT_OWNER_REFUSAL);
    expect(sent[0].text).toContain(NOT_OWNER_DASHBOARD_LINE);
    expect(sent[0].text).not.toContain('https://');
    await tg.onForwardedInvite(okForward);
    const approve = sent.at(-1)!.buttons![0].data;
    const before = sent.length;
    await tg.onCallback(tap(approve, { fromUserId: 999 }));
    expect(answers.at(-1)).toBe(`${NOT_OWNER_REFUSAL} ${NOT_OWNER_DASHBOARD_LINE}`);
    expect(sent.length).toBe(before); // no link posted into the chat for them
  });

  it('a finish prompt while Telegram approval is off carries the page link', async () => {
    const { sent, events } = setup({ enforcing: false, dashboardOrigin: PUBLIC });
    events.emit('event', { kind: 'finish-prompt', iid: IID, claimedAgent: 'Scout', claimedOwner: 'Carl', checkCode: 'K7Q2' });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent[0].text).toContain(`Finish it on the dashboard with your PIN: ${PAGE_URL}`);
    expect(sent[0].text).not.toContain('Threadline tab');
  });

  it('the "finishing by myself" notice links where to unpair', async () => {
    const { sent, events } = setup({ dashboardOrigin: PUBLIC });
    events.emit('notice', { kind: 'finishing', iid: IID, peerName: 'Scout', auto: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent[0].text).toContain(`If that isn't your agent, unpair it on the dashboard with your PIN: ${PAGE_URL}`);
    expect(sent[0].text).not.toContain('Threadline tab');
  });
});
