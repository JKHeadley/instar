/**
 * CMT-1632: every pairing line that sends the operator to the dashboard carries a direct link to
 * the Other agents page when an address is known, and names the page in plain words when not.
 * The four PairingInviteTelegram call sites, the TelegramAdapter fallback, and the URL builder.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import {
  PairingInviteTelegram, CALLBACK_PREFIX, NO_OWNER_REFUSAL, NOT_OWNER_REFUSAL, agentsPageUrl, dashboardHint, pasteInviteHint,
} from '../../../src/threadline/PairingInviteTelegram.js';
import { pairingDashboardFallback } from '../../../src/messaging/TelegramAdapter.js';
import { createInvite, inviteMessage, findInviteToken } from '../../../src/threadline/PairingInvite.js';

const OWNER = 4242;
const ORIGIN = 'https://cora.example.com';
const LINK = 'https://cora.example.com/dashboard/console/#/people/agents';
const INVITE = inviteMessage(createInvite({ identityPubHex: crypto.randomBytes(32).toString('hex'), owner: 'Justin', agent: 'Scout' }));
const IID = 'ab'.repeat(16);

function setup(o: { origin?: string | null; owner?: number | undefined; enforcing?: boolean; originThrows?: boolean } = {}) {
  const sent: Array<{ topicId: number; text: string; buttons?: unknown[] }> = [];
  const answers: string[] = [];
  const events = new EventEmitter();
  const ok = () => ({ ok: true as const });
  const tg = new PairingInviteTelegram({
    flow: {
      receiveInvite: async () => ({ ok: true, iid: IID, claimedAgent: 'Scout', claimedOwner: 'Justin', checkCode: 'K7Q2' }),
      approveAccept: ok, declineAccept: ok, approveFinish: ok, rejectFinish: ok,
    },
    events,
    send: async (topicId, text, buttons) => { sent.push({ topicId, text, buttons }); },
    answer: async (_id, text) => { answers.push(text); },
    ownerUserId: () => ('owner' in o ? o.owner : OWNER),
    chatId: () => '-100',
    operatorTopicId: () => 7,
    enforcing: () => o.enforcing ?? true,
    dashboardOrigin: () => { if (o.originThrows) throw new Error('boom'); return 'origin' in o ? o.origin ?? null : ORIGIN; },
  });
  return { tg, sent, answers, events };
}

const tap = (data: string, fromUserId = OWNER) => ({ callbackQueryId: 'q', data, fromUserId, verified: true, chatId: '-100' });

describe('agentsPageUrl / hints', () => {
  it('builds the Other agents page on the origin only, never anything else from the input', () => {
    expect(agentsPageUrl(ORIGIN)).toBe(LINK);
    expect(agentsPageUrl(`${ORIGIN}/`)).toBe(LINK);
    expect(agentsPageUrl(`${ORIGIN}/some/path?pin=1234#x`)).toBe(LINK);
    expect(agentsPageUrl('http://localhost:4042')).toBe('http://localhost:4042/dashboard/console/#/people/agents');
  });
  it('no usable origin → null (no fabricated URL)', () => {
    for (const bad of [null, undefined, '', '   ', 'not a url', 'ftp://x.example', 'https://user:pw@x.example', 'javascript:alert(1)']) {
      expect(agentsPageUrl(bad as never)).toBeNull();
    }
  });
  it('the hints carry the link when given, plain words when not', () => {
    expect(dashboardHint(LINK)).toContain(LINK);
    expect(dashboardHint(null)).not.toMatch(/https?:/);
    expect(dashboardHint(null)).toContain('Other agents page');
    expect(pasteInviteHint(LINK)).toMatch(/I was sent one.*https:\/\/cora\.example\.com/);
    expect(pasteInviteHint(null)).not.toMatch(/https?:/);
  });
});

describe('site 1: a forwarded invite this chat cannot take', () => {
  it('no owner named (Cora, 2026-11-11): the refusal links the page and says where to paste', async () => {
    const { tg, sent } = setup({ owner: undefined });
    await tg.onForwardedInvite({ text: INVITE, topicId: 9, fromUserId: OWNER, verified: true });
    expect(sent[0].text).toContain(NO_OWNER_REFUSAL);
    expect(sent[0].text).toContain(LINK);
    expect(sent[0].text).toContain('I was sent one');
    expect(sent[0].text).not.toContain(findInviteToken(INVITE)!);
  });
  it('no address known: plain words, no URL', async () => {
    const { tg, sent } = setup({ owner: undefined, origin: null });
    await tg.onForwardedInvite({ text: INVITE, topicId: 9, fromUserId: OWNER, verified: true });
    expect(sent[0].text).toContain('Other agents page');
    expect(sent[0].text).not.toMatch(/https?:/);
  });
  it('a getter that throws falls back to plain words, never a failed reply', async () => {
    const { tg, sent } = setup({ owner: undefined, originThrows: true });
    await tg.onForwardedInvite({ text: INVITE, topicId: 9, fromUserId: OWNER, verified: true });
    expect(sent[0].text).toContain(NO_OWNER_REFUSAL);
    expect(sent[0].text).not.toMatch(/https?:/);
  });
  it('someone known NOT to be the owner gets no link (the address is not theirs)', async () => {
    const { tg, sent } = setup();
    await tg.onForwardedInvite({ text: INVITE, topicId: 9, fromUserId: 1, verified: true });
    expect(sent[0].text).toContain(NOT_OWNER_REFUSAL);
    expect(sent[0].text).not.toMatch(/https?:/);
  });
});

describe('site 2: a refused button tap', () => {
  it('the owner tapping while Telegram approval is off: the answer carries the link', async () => {
    const { tg, answers } = setup({ enforcing: false });
    expect(await tg.onCallback(tap(`${CALLBACK_PREFIX}abc`))).toBe(true);
    expect(answers[0]).toContain(LINK);
    expect(answers[0].length).toBeLessThanOrEqual(200);
  });
  it('no address known: plain words', async () => {
    const { tg, answers } = setup({ enforcing: false, origin: null });
    await tg.onCallback(tap(`${CALLBACK_PREFIX}abc`));
    expect(answers[0]).toContain('Other agents page');
    expect(answers[0]).not.toMatch(/https?:/);
  });
  it('an answer that would pass Telegram\'s 200-character limit drops to plain words instead of failing', async () => {
    const { tg, answers } = setup({ enforcing: false, origin: `https://${'a'.repeat(150)}.example.com` });
    await tg.onCallback(tap(`${CALLBACK_PREFIX}abc`));
    expect(answers[0]).not.toMatch(/https?:/);
    expect(answers[0]).toContain('Other agents page');
  });
});

describe('site 3: an expired or used button', () => {
  it('carries the link', async () => {
    const { tg, answers } = setup();
    await tg.onCallback(tap(`${CALLBACK_PREFIX}${'0'.repeat(24)}`));
    expect(answers[0]).toMatch(/expired/);
    expect(answers[0]).toContain(LINK);
  });
  it('no address known: plain words', async () => {
    const { tg, answers } = setup({ origin: null });
    await tg.onCallback(tap(`${CALLBACK_PREFIX}${'0'.repeat(24)}`));
    expect(answers[0]).toMatch(/expired/);
    expect(answers[0]).not.toMatch(/https?:/);
  });
});

describe('site 4: a finish prompt while Telegram approval is off', () => {
  const finish = { kind: 'finish-prompt', iid: IID, claimedAgent: 'Carl', claimedOwner: '', acceptorFp: 'f'.repeat(32), checkCode: 'AB12' };
  it('carries the link', async () => {
    const { events, sent } = setup({ enforcing: false });
    events.emit('event', finish);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent[0].buttons).toBeUndefined();
    expect(sent[0].text).toContain(LINK);
  });
  it('no address known: plain words', async () => {
    const { events, sent } = setup({ enforcing: false, origin: null });
    events.emit('event', finish);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent[0].text).toContain('Other agents page');
    expect(sent[0].text).not.toMatch(/https?:/);
  });
});

describe('TelegramAdapter fallback (no pairing handler, or the handler failed)', () => {
  it('carries the link when the public address is known, plain words when not', () => {
    expect(pairingDashboardFallback(ORIGIN)).toContain(LINK);
    expect(pairingDashboardFallback(null)).toContain('Other agents page');
    expect(pairingDashboardFallback(null)).not.toMatch(/https?:/);
  });
});
