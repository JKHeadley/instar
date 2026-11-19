/**
 * identity-security-piece1e: the Telegram sender rule wired into the adapter.
 * Spec: docs/specs/identity-security-piece1e-telegram-senders.md
 */
import { describe, it, expect, vi } from 'vitest';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { addToNonEmptyTelegramAllowList, createSenderAuthorityWiring, OBSERVE_SENDERS_PER_DAY } from '../../src/messaging/telegramSenderWiring.js';
import { JOIN_REQUEST_COMMAND, telegramCommandAction } from '../../src/messaging/telegramSenderAuthority.js';

const OWNER = 42;
const MEMBER = 7;
const STRANGER = 99;

function adapter(cfg: Record<string, unknown> = {}): TelegramAdapter {
  return new TelegramAdapter(
    { token: 'fake-token', chatId: '-1001234567890', ownerUserId: OWNER, ...cfg } as never,
    '/tmp/fake-state-dir-' + Math.random().toString(36).slice(2, 10),
  );
}

function wire(a: TelegramAdapter, opts: { enforce: boolean; registered?: number[] }) {
  const observe = vi.fn();
  const ownerUnknown = vi.fn();
  a.setSenderAuthority({ enforce: () => opts.enforce, registeredIds: () => opts.registered ?? [], observe, ownerUnknown });
  const sent: Array<{ topicId: number; text: string }> = [];
  (a as unknown as { sendToTopic: (t: number, x: string) => Promise<unknown> }).sendToTopic = async (topicId, text) => { sent.push({ topicId, text }); return {}; };
  const api: Array<{ method: string; params: Record<string, unknown> }> = [];
  (a as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }).apiCall = async (method, params) => { api.push({ method, params }); return {}; };
  return { observe, ownerUnknown, sent, api };
}

describe('command classification', () => {
  it('maps commands to the action table', () => {
    expect(telegramCommandAction('/switch-account foo')).toBe('agent-control');
    expect(telegramCommandAction('/route@echo_bot x')).toBe('agent-control');
    expect(telegramCommandAction('/interrupt')).toBe('session-control');
    expect(telegramCommandAction('/unlink')).toBe('session-control');
    expect(telegramCommandAction('/sessions')).toBe('command');
  });
});

describe('join-request answers', () => {
  it('match exactly one command and one code, so the stop check can let them through', () => {
    for (const t of ['/approve 359fdd', '/decline 5f0890', '/deny 5f0890', '/approve@echo_bot ab12']) expect(JOIN_REQUEST_COMMAND.test(t)).toBe(true);
    for (const t of ['decline', '/decline', '/deny everything now', 'stop', '/stop', 'please /approve x']) expect(JOIN_REQUEST_COMMAND.test(t)).toBe(false);
  });
});

describe('senderMay: enforce vs observe', () => {
  it('enforcing: a stranger is refused, the owner and registered people are not', () => {
    const a = adapter();
    wire(a, { enforce: true, registered: [MEMBER] });
    expect(a.senderMay(STRANGER, 'message', { path: 'poll', legacy: true })).toBe(false);
    expect(a.senderMay(OWNER, 'agent-control', { path: 'poll', legacy: true })).toBe(true);
    expect(a.senderMay(MEMBER, 'message', { path: 'poll', legacy: true })).toBe(true);
    expect(a.senderMay(MEMBER, 'session-control', { path: 'poll', legacy: true })).toBe(true);
    expect(a.senderMay(MEMBER, 'agent-control', { path: 'poll', legacy: true })).toBe(false);
  });
  it('an empty list is not everyone when enforcing', () => {
    const a = adapter({ authorizedUserIds: [] });
    wire(a, { enforce: true });
    expect(a.senderMay(STRANGER, 'message', { path: 'poll', legacy: true })).toBe(false);
  });
  it('an unproven id is never refused (unknown keeps today\'s handling)', () => {
    const a = adapter();
    wire(a, { enforce: true });
    expect(a.senderMay(STRANGER, 'message', { path: 'forward', legacy: true, proven: false })).toBe(true);
  });
  it('observing: the legacy answer stands and a would-refuse is recorded', () => {
    const a = adapter();
    const { observe } = wire(a, { enforce: false });
    expect(a.senderMay(STRANGER, 'message', { path: 'poll', legacy: true })).toBe(true);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ userId: String(STRANGER), action: 'message', standing: 'stranger' }));
    expect(a.senderMay(OWNER, 'message', { path: 'poll', legacy: true })).toBe(true);
    expect(observe).toHaveBeenCalledTimes(1);
  });
  it('with no owner known, senders are unknown and the owner-unknown hook fires', () => {
    const a = adapter({ ownerUserId: undefined });
    const { ownerUnknown } = wire(a, { enforce: true });
    expect(a.senderStanding(STRANGER)).toBe('unknown');
    expect(a.senderMay(STRANGER, 'message', { path: 'poll', legacy: true })).toBe(true);
    expect(ownerUnknown).toHaveBeenCalled();
  });
  it('unknown keeps today\'s answer, never a pass past today\'s list (second pass #2)', () => {
    const a = adapter({ ownerUserId: undefined, authorizedUserIds: [7000001] });
    wire(a, { enforce: true });
    expect(a.senderMay(STRANGER, 'message', { path: 'poll', legacy: false })).toBe(false);
    expect(a.senderMay(STRANGER, 'message', { path: 'poll', legacy: true })).toBe(true);
  });
  it('bots (other agents, the anonymous-admin bot) keep today\'s answer on the polling path (second pass #3)', () => {
    const a = adapter({ authorizedUserIds: [] });
    const { observe } = wire(a, { enforce: true });
    const isAuthorized = (a as unknown as { isAuthorized: (id: number, o?: { isBot?: boolean }) => boolean }).isAuthorized.bind(a);
    expect(isAuthorized(1087968824, { isBot: true })).toBe(true);
    expect(isAuthorized(STRANGER)).toBe(false);
    expect(observe).not.toHaveBeenCalled();
  });
  it('switch off: senderEnforcing is false, so refused senders keep today\'s unknown-user flow (second pass #1)', () => {
    const a = adapter({ authorizedUserIds: [7000001] });
    wire(a, { enforce: false });
    expect(a.senderEnforcing()).toBe(false);
    const b = adapter();
    expect(b.senderEnforcing()).toBe(false); // nothing wired
  });
  it("'*' admits talking but no controls", () => {
    const a = adapter({ authorizedUserIds: ['*'] });
    wire(a, { enforce: true });
    expect(a.senderMay(STRANGER, 'message', { path: 'poll', legacy: true })).toBe(true);
    expect(a.senderMay(STRANGER, 'command', { path: 'poll', legacy: true })).toBe(false);
    expect(a.senderMay(STRANGER, 'session-control', { path: 'poll', legacy: true })).toBe(false);
  });
});

describe('commands and the way in', () => {
  it('a registered person cannot use a whole-agent control; told so in the topic', async () => {
    const a = adapter();
    const { sent } = wire(a, { enforce: true, registered: [MEMBER] });
    expect(await a.handleCommand('/switch-account other', 5, MEMBER)).toBe(true);
    expect(sent.at(-1)?.text).toMatch(/Only the agent's owner can use \/switch-account/);
  });
  it('/approve: only the owner resolves it', async () => {
    const a = adapter();
    const { sent } = wire(a, { enforce: false });
    const resolve = vi.fn().mockResolvedValue('Approved.');
    a.onResolveJoinRequest = resolve;
    await a.handleCommand('/approve ABC123', 5, MEMBER);
    expect(resolve).not.toHaveBeenCalled();
    expect(sent.at(-1)?.text).toMatch(/Only the agent's owner/);
    await a.handleCommand('/approve ABC123', 5, OWNER);
    expect(resolve).toHaveBeenCalledWith('ABC123', 'approved', String(OWNER));
    await a.handleCommand('/decline ABC123', 5, OWNER);
    expect(resolve).toHaveBeenLastCalledWith('ABC123', 'denied', String(OWNER));
  });
  it('/approve from an unproven or app-judged sender does nothing', async () => {
    const a = adapter();
    wire(a, { enforce: true });
    const resolve = vi.fn().mockResolvedValue('Approved.');
    a.onResolveJoinRequest = resolve;
    await a.handleCommand('/approve ABC123', 5, OWNER, undefined, { proven: false });
    await a.handleCommand('/approve ABC123', 5, OWNER, undefined, { judge: false });
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('answerStranger', () => {
  it('replies only in the stranger\'s own private chat, once a day, and asks the owner', async () => {
    const a = adapter();
    const { api, sent } = wire(a, { enforce: true });
    const ask = vi.fn().mockResolvedValue(undefined);
    a.onNotifyAdminJoinRequest = ask;
    await a.answerStranger({ userId: STRANGER, chatType: 'supergroup', chatId: -100, firstName: 'Mallory' });
    expect(api.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(ask).toHaveBeenCalledTimes(1);
    await a.answerStranger({ userId: STRANGER + 1, chatType: 'private', chatId: STRANGER + 1 });
    expect(api.filter((c) => c.method === 'sendMessage' && c.params.chat_id === String(STRANGER + 1))).toHaveLength(1);
    await a.answerStranger({ userId: STRANGER + 1, chatType: 'private', chatId: STRANGER + 1 });
    expect(api.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
  });
  it('caps at 20 senders a day per agent', async () => {
    const a = adapter();
    wire(a, { enforce: true });
    const ask = vi.fn().mockResolvedValue(undefined);
    a.onNotifyAdminJoinRequest = ask;
    for (let i = 0; i < 30; i++) await a.answerStranger({ userId: 1000 + i, chatType: 'private', chatId: 1000 + i });
    expect(ask).toHaveBeenCalledTimes(20);
  });
});

describe('the observe wiring', () => {
  const cfg = (enabled?: boolean, dev = false) => () => ({ developmentAgent: dev, security: { telegramSenderAuthority: { enabled } } });
  it('the switch is dev-gated', () => {
    const raise = vi.fn().mockResolvedValue(true);
    expect(createSenderAuthorityWiring({ config: cfg(undefined, true), registeredIds: () => [], raiseOwnerItem: raise }).enforce()).toBe(true);
    expect(createSenderAuthorityWiring({ config: cfg(undefined, false), registeredIds: () => [], raiseOwnerItem: raise }).enforce()).toBe(false);
    expect(createSenderAuthorityWiring({ config: cfg(false, true), registeredIds: () => [], raiseOwnerItem: raise }).enforce()).toBe(false);
  });
  it('raises one owner item, refreshed per new sender, capped per day', () => {
    const raise = vi.fn().mockResolvedValue(true);
    const w = createSenderAuthorityWiring({ config: cfg(undefined, false), registeredIds: () => [], raiseOwnerItem: raise, now: () => Date.parse('2026-11-18T12:00:00Z') });
    w.observe({ userId: '1', path: 'poll', action: 'message', standing: 'stranger' });
    w.observe({ userId: '1', path: 'poll', action: 'command', standing: 'stranger' });
    expect(raise).toHaveBeenCalledTimes(1);
    for (let i = 2; i < OBSERVE_SENDERS_PER_DAY + 20; i++) w.observe({ userId: String(i), path: 'poll', action: 'message', standing: 'stranger' });
    expect(raise).toHaveBeenCalledTimes(OBSERVE_SENDERS_PER_DAY);
    expect(raise.mock.calls.at(-1)?.[1]).toMatch(/would be refused/);
    expect(raise.mock.calls.at(-1)?.[1]).toMatch(new RegExp(`${OBSERVE_SENDERS_PER_DAY} or more`));
  });
  it('the owner-unknown item only on enforcing agents, once', () => {
    const raise = vi.fn().mockResolvedValue(true);
    createSenderAuthorityWiring({ config: cfg(undefined, false), registeredIds: () => [], raiseOwnerItem: raise }).ownerUnknown();
    expect(raise).not.toHaveBeenCalled();
    const w = createSenderAuthorityWiring({ config: cfg(undefined, true), registeredIds: () => [], raiseOwnerItem: raise });
    w.ownerUnknown(); w.ownerUnknown();
    expect(raise).toHaveBeenCalledTimes(1);
    expect(raise.mock.calls[0][1]).toMatch(/not protecting your agent/);
  });
  it('an approval never makes a one-person allowlist', () => {
    const empty = { messaging: [{ type: 'telegram', config: { authorizedUserIds: [] as unknown[] } }] };
    expect(addToNonEmptyTelegramAllowList(empty, 5)).toBe(false);
    expect(empty.messaging[0].config.authorizedUserIds).toEqual([]);
    const listed = { messaging: [{ type: 'telegram', config: { authorizedUserIds: ['42'] as unknown[] } }] };
    expect(addToNonEmptyTelegramAllowList(listed, 5)).toBe(true);
    expect(addToNonEmptyTelegramAllowList(listed, 5)).toBe(false);
    expect(listed.messaging[0].config.authorizedUserIds).toEqual(['42', 5]);
  });
});
