/**
 * Telegram surface for the pairing handshake (docs/specs/a2a-pairing-invite-link.md §11.6–§11.8):
 * every notice becomes a message in the topic where the invite was made or forwarded (else the
 * Lifeline topic), nothing is dropped silently, and the owner can pre-authorize the Finish for an
 * invite their agent posted.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PairingInviteTelegram, OWN_AGENT_BUTTON, OWN_AGENT_PROMPT, OWN_AGENT_DONE,
} from '../../../src/threadline/PairingInviteTelegram.js';
import { PairingTopicStore } from '../../../src/threadline/PairingTopicStore.js';
import { createInvite, inviteMessage } from '../../../src/threadline/PairingInvite.js';
import { pairingNoticeText, type PairingNotice } from '../../../src/threadline/pairingHandshake.js';

const OWNER = 4242;
const own = createInvite({ identityPubHex: crypto.randomBytes(32).toString('hex'), owner: 'Justin', agent: 'PP' });
const OWN_MSG = inviteMessage(own);
const OTHER_IID = 'cd'.repeat(16);

function setup(opts: { operatorTopic?: number | undefined; failSend?: boolean; enforcing?: boolean; noTopics?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-notices-'));
  const topics = new PairingTopicStore(dir);
  const sent: Array<{ topicId: number; text: string; buttons?: Array<{ text: string; data: string }> }> = [];
  const answers: string[] = [];
  const reports: Array<{ what: string; reason: string }> = [];
  const calls: string[] = [];
  const events = new EventEmitter();
  const tg = new PairingInviteTelegram({
    flow: {
      receiveInvite: async () => { calls.push('receive'); return { ok: true, iid: OTHER_IID, claimedAgent: 'Echo', claimedOwner: 'Justin', checkCode: 'K7Q2' }; },
      approveAccept: (iid) => {
        calls.push(`approve:${iid}`);
        // The handshake emits its 'approved' notice synchronously inside approveAccept.
        events.emit('notice', { kind: 'approved', iid, peerFp: 'ab'.repeat(16), peerName: 'PP' } satisfies PairingNotice);
        return { ok: true };
      },
      declineAccept: () => ({ ok: true }),
      approveFinish: (iid) => { calls.push(`finish:${iid}`); return { ok: true }; },
      rejectFinish: () => ({ ok: true }),
      preauthorizeFinish: (iid) => { calls.push(`own-agent:${iid}`); return iid === own.iid ? { ok: true } : { ok: false, reason: 'no such invite' }; },
      listPendingAccepts: () => [{ iid: OTHER_IID, exp: new Date(Date.now() + 3600_000).toISOString() }],
    },
    events,
    send: async (topicId, text, buttons) => {
      if (opts.failSend) throw new Error('telegram down');
      sent.push({ topicId, text, buttons });
    },
    answer: async (_id, text) => { answers.push(text); },
    ownerUserId: () => OWNER,
    chatId: () => '-100',
    operatorTopicId: () => ('operatorTopic' in opts ? opts.operatorTopic : 3),
    enforcing: () => opts.enforcing ?? true,
    topics: opts.noTopics ? undefined : topics,
    ownOpenInvite: (iid) => (iid === own.iid ? { exp: own.exp } : null),
    reportUndelivered: (what, reason) => { reports.push({ what, reason }); },
  });
  return { tg, sent, answers, reports, calls, events, topics, dir };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const notice = (kind: PairingNotice['kind'], iid: string, extra: Record<string, unknown> = {}) =>
  ({ kind, iid, peerFp: 'ab'.repeat(16), peerName: 'PP', ...extra }) as PairingNotice;

describe('PairingInviteTelegram — handshake notices', () => {
  it('a notice for a forwarded invite goes to the topic it was forwarded into, in plain words', async () => {
    const { tg, sent, events } = setup();
    await tg.onForwardedInvite({ text: `fwd ${OWN_MSG}`, topicId: 61, fromUserId: OWNER, verified: true });
    events.emit('notice', notice('paired', OTHER_IID, { role: 'recipient', checked: true }));
    await tick();
    const last = sent[sent.length - 1];
    expect(last.topicId).toBe(61);
    expect(last.text).toBe(pairingNoticeText(notice('paired', OTHER_IID, { role: 'recipient', checked: true })));
    expect(last.text).toMatch(/^Connected ✓ "PP"/);
  });

  it('the Approve tap is answered at once AND posts "Approved — finishing…" in the invite\'s topic', async () => {
    const { tg, sent, answers } = setup();
    await tg.onForwardedInvite({ text: `fwd ${OWN_MSG}`, topicId: 61, fromUserId: OWNER, verified: true });
    const approve = sent[0].buttons!.find((b) => b.text === 'Approve')!;
    await tg.onCallback({ callbackQueryId: 'q', data: approve.data, fromUserId: OWNER, chatId: '-100', verified: true });
    await tick();
    expect(answers[0]).toMatch(/^Approved\. Finishing the connection/);
    expect(sent.some((m) => m.topicId === 61 && m.text === 'Approved — finishing the connection with "PP" and checking we can talk…')).toBe(true);
  });

  it('an invite with no topic of its own falls back to the Lifeline topic', async () => {
    const { sent, events } = setup();
    events.emit('notice', notice('pairing-timeout', 'ee'.repeat(16), { role: 'recipient', stage: 'no-answer' }));
    await tick();
    expect(sent[0].topicId).toBe(3);
    expect(sent[0].text).toContain('hasn\'t answered my approval in 5 minutes');
  });

  it('no topic at all is reported, never dropped silently', async () => {
    const { sent, events, reports } = setup({ operatorTopic: undefined });
    events.emit('notice', notice('paired', 'ee'.repeat(16), { role: 'inviter', checked: true }));
    events.emit('event', { kind: 'finish-prompt', iid: 'ee'.repeat(16), claimedAgent: 'X', claimedOwner: '', acceptorFp: 'ab'.repeat(16), checkCode: 'AAAA' });
    await tick();
    expect(sent).toEqual([]);
    expect(reports.map((r) => r.what)).toEqual(['pairing notice paired', 'finish prompt']);
    expect(reports[0].reason).toMatch(/no topic/);
  });

  it('a failed send is reported, not swallowed', async () => {
    const { events, reports } = setup({ failSend: true });
    events.emit('notice', notice('accept-refused', 'ee'.repeat(16), { role: 'recipient', reason: 'expired' }));
    await tick();
    expect(reports).toEqual([expect.objectContaining({ what: 'pairing notice accept-refused', reason: expect.stringContaining('telegram down') })]);
  });

  it('the engine\'s "paired" event is not announced on its own: only the handshake\'s notice is', async () => {
    const { sent, events } = setup();
    events.emit('event', { kind: 'paired', peerFp: 'ab'.repeat(16), claimedAgent: 'PP', role: 'recipient' });
    await tick();
    expect(sent).toEqual([]);
  });

  it('the Finish prompt goes to the topic where the invite was posted, not Lifeline', async () => {
    const { tg, sent, events } = setup();
    await tg.noteOutboundInvite(`Send this: ${OWN_MSG}`, 88);
    events.emit('event', { kind: 'finish-prompt', iid: own.iid, claimedAgent: 'Echo', claimedOwner: 'Justin', acceptorFp: 'ab'.repeat(16), checkCode: 'AAAA' });
    await tick();
    const prompt = sent.find((m) => m.text.includes('accepted your pairing invite'))!;
    expect(prompt.topicId).toBe(88);
    expect(prompt.buttons?.map((b) => b.text)).toEqual(['Finish', 'Not them']);
  });

  it('an invite the agent posts: its topic is remembered (across a restart) and the owner is offered "It\'s one of my agents" once', async () => {
    const { tg, sent, dir } = setup();
    await tg.noteOutboundInvite(`Send this to Echo: ${OWN_MSG}`, 88);
    await tg.noteOutboundInvite(`again: ${OWN_MSG}`, 88);
    const offers = sent.filter((m) => m.text === OWN_AGENT_PROMPT);
    expect(offers).toHaveLength(1);
    expect(offers[0].topicId).toBe(88);
    expect(offers[0].buttons?.map((b) => b.text)).toEqual([OWN_AGENT_BUTTON]);
    expect(new PairingTopicStore(dir).get(own.iid)).toBe(88);
    const raw = fs.readFileSync(path.join(dir, 'threadline', 'pairing-topics.json'), 'utf-8');
    expect(raw).not.toContain(own.secret);
    expect((fs.statSync(path.join(dir, 'threadline', 'pairing-topics.json')).mode & 0o777)).toBe(0o600);
  });

  it('the owner\'s tap pre-authorizes the Finish; a tap by anyone else does not', async () => {
    const { tg, sent, answers, calls } = setup();
    await tg.noteOutboundInvite(`Send: ${OWN_MSG}`, 88);
    const btn = sent.find((m) => m.text === OWN_AGENT_PROMPT)!.buttons![0];
    await tg.onCallback({ callbackQueryId: 'q1', data: btn.data, fromUserId: 1, chatId: '-100', verified: true });
    expect(calls).not.toContain(`own-agent:${own.iid}`);
    await tg.onCallback({ callbackQueryId: 'q2', data: btn.data, fromUserId: OWNER, chatId: '-100', verified: false });
    expect(calls).not.toContain(`own-agent:${own.iid}`);
    await tg.onCallback({ callbackQueryId: 'q3', data: btn.data, fromUserId: OWNER, chatId: '-100', verified: true });
    expect(calls).toContain(`own-agent:${own.iid}`);
    expect(answers[answers.length - 1]).toBe(OWN_AGENT_DONE);
    expect(sent[sent.length - 1]).toMatchObject({ topicId: 88, text: OWN_AGENT_DONE });
  });

  it('no offer when Telegram approval is off, or for an invite that is not this agent\'s own', async () => {
    const off = setup({ enforcing: false });
    await off.tg.noteOutboundInvite(`Send: ${OWN_MSG}`, 88);
    expect(off.sent).toEqual([]);
    expect(off.topics.get(own.iid)).toBe(88); // the topic is still remembered
    const other = setup();
    const foreign = inviteMessage(createInvite({ identityPubHex: crypto.randomBytes(32).toString('hex'), owner: 'Carl', agent: 'Scout' }));
    await other.tg.noteOutboundInvite(foreign, 88);
    expect(other.sent).toEqual([]);
  });

  it('a route-supplied topic is used for the inviter\'s notices', async () => {
    const { tg, sent, events } = setup();
    tg.noteInviteTopic(own.iid, 77, own.exp);
    events.emit('notice', notice('invite-expired', own.iid, { role: 'inviter', peerName: '' }));
    await tick();
    expect(sent[0]).toMatchObject({ topicId: 77, text: expect.stringContaining('expired before anyone used it') });
  });
});

describe('PairingTopicStore', () => {
  it('drops entries 48 h after their invite expires, and survives a corrupt file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pts-'));
    let now = Date.parse('2026-10-20T00:00:00Z');
    const s = new PairingTopicStore(dir, () => now);
    s.set('ab'.repeat(16), 5, 'inviter', '2026-10-20T01:00:00Z');
    s.set('cd'.repeat(16), 6, 'recipient', '2026-10-25T01:00:00Z');
    now = Date.parse('2026-10-22T02:00:00Z');
    s.set('ef'.repeat(16), 7, 'inviter', '2026-10-22T03:00:00Z');
    expect(s.get('ab'.repeat(16))).toBeUndefined();
    expect(s.get('cd'.repeat(16))).toBe(6);
    fs.writeFileSync(path.join(dir, 'threadline', 'pairing-topics.json'), '{nope');
    const problems: string[] = [];
    const s2 = new PairingTopicStore(dir, () => now, (p) => problems.push(p));
    expect(s2.get('cd'.repeat(16))).toBeUndefined();
    expect(problems[0]).toMatch(/not valid JSON/);
  });
});
