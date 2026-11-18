/**
 * Trust-journey decision 5: the account path's pure rules, both sides of every check.
 */
import { describe, it, expect } from 'vitest';
import {
  acceptanceStatement, CODE_LENGTH, isAcceptanceReply, newApprovalCode, normalizeCode,
  parseApproveCommand, receiptApproves, renderRequestCard, DISCLOSURE,
  type AcceptanceRecord, type Receipt, type RequestRecord,
} from '../../src/core/trustJourney/accountPath.js';

const now = new Date('2026-11-16T08:00:00Z');
const req: RequestRecord = {
  requestId: 'r1', code: 'AB12CD', proposalHash: 'h', principal: 'owner', adapter: 'telegram',
  approverPlatformId: '777', cardMessageId: '50', cardChatId: '777',
  expiresAt: '2026-11-23T08:00:00Z', status: 'open',
};
const acc: AcceptanceRecord = { acceptanceId: 'a1', principal: 'owner', adapter: 'telegram', accountId: '777', acceptedAt: '2026-11-16T07:00:00Z' };
const good: Receipt = {
  receiptId: 'x', adapter: 'telegram', senderId: '777', chatId: '777', chatType: 'private', messageId: '51',
  replyToMessageId: '50', text: 'approve ab12cd', senderIsBot: false, forwarded: false, uniqueKey: 'u:1',
  receivedAt: now.toISOString(), receivedBy: 'm1',
};
const none = () => false;

describe('codes', () => {
  it('are six characters from an unambiguous alphabet and unique', () => {
    const taken = new Set(['000000']);
    const c = newApprovalCode((x) => taken.has(x));
    expect(c).toHaveLength(CODE_LENGTH);
    expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    let n = 0;
    expect(() => newApprovalCode(() => true, (k) => { n++; return Buffer.alloc(k); })).toThrow();
    expect(n).toBe(64);
  });
  it('normalize case and look-alike letters', () => {
    expect(normalizeCode('ab1o2l')).toBe('AB1021');
  });
});

describe('the approve command', () => {
  it('accepts exactly `approve <code>`', () => {
    expect(parseApproveCommand('approve ab12cd')).toBe('AB12CD');
    expect(parseApproveCommand('  Approve AB12CD  ')).toBe('AB12CD');
  });
  it('refuses anything else, including a yes in words', () => {
    for (const t of ['yes', 'ok', 'no', 'approve', 'approve ab12c', 'approve ab12cd please', 'I approve ab12cd', 'approve ab12cd ab12cd', '']) {
      expect(parseApproveCommand(t)).toBeNull();
    }
  });
});

describe('acceptance and the card', () => {
  it('the statement names the service, account and installation and must come back unchanged', () => {
    const s = acceptanceStatement({ adapter: 'telegram', accountId: '777', installationId: 'inst-1' });
    expect(s).toContain('Telegram account 777');
    expect(s).toContain('Instar installation inst-1');
    expect(isAcceptanceReply(`  ${s.replace(/ /g, '  ')} `, s)).toBe(true);
    expect(isAcceptanceReply(s.replace('withdraw', 'revoke'), s)).toBe(false);
    expect(isAcceptanceReply('yes', s)).toBe(false);
  });
  it('the card carries the code, the reply instruction and the disclosure', () => {
    const card = renderRequestCard({ summary: { lines: ['Send email from you@x.com without asking'] }, code: 'AB12CD', expiresAt: req.expiresAt });
    expect(card).toContain('reply to this message with: approve AB12CD');
    expect(card).toContain('Any other reply approves nothing');
    expect(card).toContain(DISCLOSURE);
  });
});

describe('receiptApproves', () => {
  it('approves the right reply in the person\'s own direct chat', () => {
    expect(receiptApproves(good, req, acc, now, none)).toEqual({ ok: true });
  });
  const bad: Array<[string, Partial<Receipt>, string]> = [
    ['a group or topic chat', { chatType: 'supergroup', chatId: '-100' }, 'not-a-direct-chat'],
    ['a private chat that is not the sender\'s own', { chatId: '888' }, 'not-a-direct-chat'],
    ['another person', { senderId: '888', chatId: '888' }, 'not-the-approver'],
    ['a bot', { senderIsBot: true }, 'sender-is-bot'],
    ['a forwarded message', { forwarded: true }, 'forwarded-message'],
    ['no reply-to', { replyToMessageId: undefined }, 'not-a-reply-to-the-card'],
    ['a reply to another message', { replyToMessageId: '49' }, 'not-a-reply-to-the-card'],
    ['a yes in words', { text: 'yes, go ahead' }, 'not-the-approve-command'],
    ['a different code', { text: 'approve ZZZZZZ' }, 'wrong-code'],
    ['another adapter', { adapter: 'slack', chatType: 'im' }, 'wrong-adapter'],
  ];
  for (const [name, patch, reason] of bad) {
    it(`refuses ${name}`, () => {
      expect(receiptApproves({ ...good, ...patch }, req, acc, now, none)).toEqual({ ok: false, reason });
    });
  }
  it('refuses a used receipt, an expired or consumed request, and no or withdrawn acceptance', () => {
    expect(receiptApproves(good, req, acc, now, () => true)).toEqual({ ok: false, reason: 'receipt-already-used' });
    expect(receiptApproves(good, { ...req, expiresAt: '2026-11-16T07:59:59Z' }, acc, now, none)).toEqual({ ok: false, reason: 'request-expired' });
    expect(receiptApproves(good, { ...req, status: 'consumed' }, acc, now, none)).toEqual({ ok: false, reason: 'request-consumed' });
    expect(receiptApproves(good, req, null, now, none)).toEqual({ ok: false, reason: 'no-current-acceptance' });
    expect(receiptApproves(good, req, { ...acc, withdrawnAt: '2026-11-16T07:30:00Z' }, now, none)).toEqual({ ok: false, reason: 'no-current-acceptance' });
    expect(receiptApproves(good, req, { ...acc, principal: 'member' }, now, none)).toEqual({ ok: false, reason: 'no-current-acceptance' });
  });
  it('Slack: approves a DM reply, refuses a channel', () => {
    const sreq = { ...req, adapter: 'slack' as const, approverPlatformId: 'U1', cardChatId: 'D1', cardMessageId: '1700.1' };
    const sacc = { ...acc, adapter: 'slack' as const, accountId: 'U1' };
    const r = { ...good, adapter: 'slack' as const, senderId: 'U1', chatId: 'D1', chatType: 'im', replyToMessageId: '1700.1', uniqueKey: 'D1:1700.2' };
    expect(receiptApproves(r, sreq, sacc, now, none)).toEqual({ ok: true });
    expect(receiptApproves({ ...r, chatType: 'channel' }, sreq, sacc, now, none)).toEqual({ ok: false, reason: 'not-a-direct-chat' });
  });
});
