/**
 * Chief of Staff owner rules (src/core/chiefOfStaffOwner.ts) — Echo Bugs topic 10000002533.
 * An agent switched Chief of Staff on with no owner; the owner-only gate then refused the
 * operator six times while the standby proxy said each message was delivered. These cover both
 * sides of every rule: owner vs not, no-owner, unverified, and the switched-on-but-ownerless hold.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  chiefOfStaffInboundVerdict, chiefOfStaffRefusesInbound, chiefOfStaffRefusalLine,
  chiefOfStaffActive, makeChiefOfStaffGate,
} from '../../src/core/chiefOfStaffOwner.js';
import { ensureChiefOfStaffTopic, CHIEF_OF_STAFF_TOPIC_STATE_KEY, CHIEF_OF_STAFF_TOPIC_PINNED_STATE_KEY } from '../../src/messaging/ChiefOfStaffTopic.js';
import { PresenceProxy } from '../../src/monitoring/PresenceProxy.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const COS = 4242;
const OWNER = 777;

describe('inbound verdict', () => {
  it('leaves every other conversation alone', () => {
    expect(chiefOfStaffInboundVerdict({ topicId: 1, cosTopicId: COS, senderId: 5, owner: undefined })).toBe('not-cos-topic');
    expect(chiefOfStaffInboundVerdict({ topicId: COS, cosTopicId: null, senderId: 5, owner: undefined })).toBe('not-cos-topic');
    expect(chiefOfStaffRefusesInbound({ topicId: 1, cosTopicId: COS, senderId: 0, owner: undefined })).toBe(false);
  });
  it('accepts the verified owner', () => {
    expect(chiefOfStaffInboundVerdict({ topicId: COS, cosTopicId: COS, senderId: OWNER, owner: OWNER })).toBe('owner');
    expect(chiefOfStaffRefusesInbound({ topicId: COS, cosTopicId: COS, senderId: OWNER, owner: OWNER })).toBe(false);
  });
  it('refuses an unknown sender, an unverified sender, and everyone when there is no owner', () => {
    expect(chiefOfStaffInboundVerdict({ topicId: COS, cosTopicId: COS, senderId: 99, owner: OWNER })).toBe('not-owner');
    expect(chiefOfStaffInboundVerdict({ topicId: COS, cosTopicId: COS, senderId: 0, owner: OWNER })).toBe('unverified');
    expect(chiefOfStaffInboundVerdict({ topicId: COS, cosTopicId: COS, senderId: undefined, owner: OWNER })).toBe('unverified');
    expect(chiefOfStaffInboundVerdict({ topicId: COS, cosTopicId: COS, senderId: OWNER, owner: undefined })).toBe('no-owner');
    for (const senderId of [99, 0, OWNER]) {
      expect(chiefOfStaffRefusesInbound({ topicId: COS, cosTopicId: COS, senderId, owner: senderId === OWNER ? undefined : OWNER })).toBe(true);
    }
  });
  it('every refusal tells the sender plainly that the message was not delivered', () => {
    for (const v of ['no-owner', 'not-owner', 'unverified'] as const) expect(chiefOfStaffRefusalLine(v)).toMatch(/^This message was not delivered\./);
    expect(chiefOfStaffRefusalLine('owner')).toBeNull();
    expect(chiefOfStaffRefusalLine('not-cos-topic')).toBeNull();
  });
});

describe('activation needs a verified owner', () => {
  it('is live only when switched on AND an owner exists', () => {
    expect(chiefOfStaffActive(true, OWNER)).toBe(true);
    expect(chiefOfStaffActive(true, undefined)).toBe(false);
    expect(chiefOfStaffActive(false, OWNER)).toBe(false);
  });
  it('holds an ownerless switch-on off and reports it once per episode, not per tick', () => {
    let owner: number | undefined;
    const report = vi.fn();
    const gate = makeChiefOfStaffGate({ switchedOn: () => true, owner: () => owner, reportNoOwner: report });
    expect(gate()).toBe(false); expect(gate()).toBe(false); expect(gate()).toBe(false);
    expect(report).toHaveBeenCalledTimes(1);
    owner = OWNER; // the established operator becomes known → binds to it
    expect(gate()).toBe(true);
    owner = undefined; // lost again → a new episode, reported again
    expect(gate()).toBe(false);
    expect(report).toHaveBeenCalledTimes(2);
  });
  it('switched off never reports, and an unreadable owner reads as no owner', () => {
    const report = vi.fn();
    expect(makeChiefOfStaffGate({ switchedOn: () => false, owner: () => undefined, reportNoOwner: report })()).toBe(false);
    expect(report).not.toHaveBeenCalled();
    expect(makeChiefOfStaffGate({ switchedOn: () => true, owner: () => { throw new Error('store down'); }, reportNoOwner: report })()).toBe(false);
    expect(report).toHaveBeenCalledTimes(1);
  });
});

function memState(init: Record<string, unknown> = {}) {
  const m = new Map(Object.entries(init));
  return { readOnly: false, get: <T,>(k: string) => (m.has(k) ? m.get(k) as T : null), set: (k: string, v: unknown) => { m.set(k, v); }, m };
}
function fakeTelegram() {
  return {
    findOrCreateForumTopic: vi.fn(async () => ({ topicId: COS, name: 'x', reused: false })),
    editForumTopic: vi.fn(async () => true),
    sendGreeting: vi.fn(async () => ({ messageId: 9 })),
    pinTopicMessage: vi.fn(async () => true),
    unpinTopicMessages: vi.fn(async () => true),
  };
}

describe('the Chief of Staff topic is not created without a verified owner', () => {
  it('switched on with no owner: nothing created, nothing sent', async () => {
    const tg = fakeTelegram(); const st = memState();
    const r = await ensureChiefOfStaffTopic(tg, st, { enabled: () => true, ownerKnown: () => false, displayName: () => undefined });
    expect(r).toEqual({ outcome: 'held-no-owner', topicId: null });
    expect(tg.findOrCreateForumTopic).not.toHaveBeenCalled();
    expect(tg.sendGreeting).not.toHaveBeenCalled();
  });
  it('an existing install keeps its topic and pin while held (no rollback churn)', async () => {
    const tg = fakeTelegram(); const st = memState({ [CHIEF_OF_STAFF_TOPIC_STATE_KEY]: COS, [CHIEF_OF_STAFF_TOPIC_PINNED_STATE_KEY]: true });
    const r = await ensureChiefOfStaffTopic(tg, st, { enabled: () => true, ownerKnown: () => false, displayName: () => undefined });
    expect(r).toEqual({ outcome: 'held-no-owner', topicId: COS });
    expect(tg.unpinTopicMessages).not.toHaveBeenCalled();
    expect(st.get(CHIEF_OF_STAFF_TOPIC_PINNED_STATE_KEY)).toBe(true);
  });
  it('with a verified owner it is created as before; an unreadable owner holds', async () => {
    const tg = fakeTelegram(); const st = memState();
    const r = await ensureChiefOfStaffTopic(tg, st, { enabled: () => true, ownerKnown: () => true, displayName: () => undefined });
    expect(r.outcome).toBe('created');
    const tg2 = fakeTelegram();
    const r2 = await ensureChiefOfStaffTopic(tg2, memState(), { enabled: () => true, ownerKnown: () => { throw new Error('x'); }, displayName: () => undefined });
    expect(r2.outcome).toBe('held-no-owner');
    expect(tg2.findOrCreateForumTopic).not.toHaveBeenCalled();
  });
});

describe('a refused message is never acknowledged as delivered (standby proxy)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function proxyWith(owner: number | undefined) {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-cos-'));
    const sent: string[] = [];
    const proxy = new PresenceProxy({
      stateDir, intelligence: null, agentName: 'inspec',
      captureSessionOutput: () => 'Some terminal output here\nWorking on things...',
      getSessionForTopic: () => 'cos-session', isSessionAlive: () => true,
      sendMessage: async (_t: number, text: string) => { sent.push(text); },
      getAuthorizedUserIds: () => [], getProcessTree: () => [], hasAgentRespondedSince: () => false,
      // The production predicate (server.ts) — the same verdict the inbound gate uses.
      isInboundRefused: (topicId: number, uid: string | undefined) => chiefOfStaffRefusesInbound({ topicId, cosTopicId: COS, senderId: Number(uid) || 0, owner }),
      tier1DelayMs: 50, tier2DelayMs: 200, tier3DelayMs: 500,
    } as never);
    proxy.start();
    const say = (uid: number | undefined, topic = COS) => proxy.onMessageLogged({ messageId: 1, channelId: String(topic), text: 'checking in', fromUser: true, timestamp: new Date().toISOString(), platformUserId: uid === undefined ? undefined : String(uid) });
    return { proxy, sent, say, stateDir };
  }

  it('the incident: no owner → the operator\'s message gets no "delivered to the session" claim', async () => {
    const { proxy, sent, say } = proxyWith(undefined);
    say(OWNER);
    await vi.advanceTimersByTimeAsync(600);
    expect(sent).toEqual([]);
    expect(proxy.getState(COS)).toBeUndefined();
  });
  it('a non-owner and an unverified sender get no standby either', async () => {
    const { sent, say } = proxyWith(OWNER);
    say(99); say(undefined);
    await vi.advanceTimersByTimeAsync(600);
    expect(sent).toEqual([]);
  });
  it('the verified owner still gets the normal standby, and other conversations are untouched', async () => {
    const a = proxyWith(OWNER); a.say(OWNER);
    await vi.advanceTimersByTimeAsync(60);
    expect(a.sent.length).toBe(1);
    const b = proxyWith(undefined); b.say(OWNER, 555);
    await vi.advanceTimersByTimeAsync(60);
    expect(b.sent.length).toBe(1);
  });
});

describe('owner taps use the verified owner (configured, else the one verified operator)', () => {
  let adapter: TelegramAdapter; let tmpDir: string;
  let calls: { method: string; body: Record<string, unknown> }[];
  const answerText = () => calls.find((c) => c.method === 'answerCallbackQuery')?.body.text;
  const tap = (from: number) => adapter.handleForwardedCallback({ id: 'cbq', from: { id: from }, data: 'cos:unpark:telegram:1', message: { message_id: 1, chat: { id: from } } } as never);
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-owner-'));
    adapter = new TelegramAdapter({ token: 'test-token', chatId: '-100999' }, tmpDir);
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: { body: string }) => {
      calls.push({ method: String(url).split('/').pop()!, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) } as unknown as Response;
    }));
  });
  afterEach(async () => {
    await adapter.stop(); vi.unstubAllGlobals();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/chief-of-staff-owner.test.ts' });
  });
  it('getVerifiedOwner: none, the verified operator, and a configured owner that always wins', () => {
    expect(adapter.getVerifiedOwner()).toBeUndefined();
    adapter.setCallbackApproverResolver(() => OWNER);
    expect(adapter.getVerifiedOwner()).toBe(OWNER);
    const configured = new TelegramAdapter({ token: 't', chatId: '-1', ownerUserId: '555' as unknown as number }, tmpDir);
    configured.setCallbackApproverResolver(() => OWNER);
    expect(configured.getVerifiedOwner()).toBe(555);
  });
  it('no owner refuses the tap and says why; the verified operator\'s tap reaches the loop; anyone else is refused', async () => {
    const handler = vi.fn(async () => 'ok' as const);
    adapter.onChiefOfStaffTap = handler;
    await tap(OWNER);
    expect(handler).not.toHaveBeenCalled();
    expect(answerText()).toMatch(/No verified owner/);
    calls = [];
    adapter.setCallbackApproverResolver(() => OWNER);
    await tap(99);
    expect(handler).not.toHaveBeenCalled();
    expect(answerText()).toBe('Only the owner can tap this.');
    calls = [];
    await tap(OWNER);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(answerText()).toBe('Done.');
  });
});
