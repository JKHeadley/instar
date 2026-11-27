/**
 * Pinned messages (docs/specs/conversation-pinned-messages.md): the `pin` event kind, its reduction
 * in every arrival order, the index rebuild, that a pin is never a message, the cap, the clock rule,
 * the replicated wire round-trip, the shared helpers, and the team gate's exact mappings.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppConversationStore, validateAppEvent, pinEventWins, MAX_PINS_PER_CONVERSATION, type PinEvent } from '../../src/core/AppConversationStore.js';
import { applyPin, pinPreview, pinRowsFor, isRealTelegramMessageId, isSlackTs, isConversationPinsEnabled, telegramPinEventId, pinRequestEventId } from '../../src/core/ConversationPins.js';
import { appEventFromReplicatedData, buildAppConversationRecordData, appConversationRecordStoreSchema } from '../../src/core/AppConversationsReplicatedStore.js';
import { teamConversationTarget } from '../../src/server/mobilePairingRoutes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/conversation-pins.test.ts' }); });
const KEY = '11111111-1111-4111-8111-111111111111';
function store(): AppConversationStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pins-'));
  dirs.push(dir);
  return new AppConversationStore({ stateDir: dir, machineId: () => 'm1' });
}
function pin(over: Partial<PinEvent> = {}): PinEvent {
  return { eventId: 'pin-1', kind: 'pin', conversationKey: KEY, at: '2026-11-09T10:00:00.000Z', machineId: 'm1', pinnedMessageId: 'msg-1', pinState: 'pinned', pinnedBy: { name: 'Justin', role: 'owner' }, source: 'app', ...over };
}
function seed(s: AppConversationStore): void {
  s.append({ eventId: 'c1', kind: 'created', conversationKey: KEY, at: '2026-11-09T09:00:00.000Z', machineId: 'm1', title: 'Plans' });
  s.append({ eventId: 'e1', kind: 'message', conversationKey: KEY, at: '2026-11-09T09:01:00.000Z', machineId: 'm1', messageId: 'msg-1', role: 'operator', text: 'first' });
  s.append({ eventId: 'e2', kind: 'message', conversationKey: KEY, at: '2026-11-09T09:02:00.000Z', machineId: 'm1', messageId: 'msg-2', role: 'agent', text: 'second' });
}

describe('the pin event', () => {
  it('validates a well-formed pin and refuses malformed ones', () => {
    expect(validateAppEvent(pin())).toMatchObject({ kind: 'pin', pinnedMessageId: 'msg-1', pinState: 'pinned' });
    expect(validateAppEvent(pin({ preview: 'hello' }))).toMatchObject({ preview: 'hello' });
    expect(validateAppEvent({ ...pin(), pinnedMessageId: 'bad id' })).toBeNull();
    expect(validateAppEvent({ ...pin(), pinState: 'maybe' })).toBeNull();
    expect(validateAppEvent({ ...pin(), pinnedBy: { name: 'X', role: 'admin' } })).toBeNull();
    expect(validateAppEvent({ ...pin(), pinnedBy: { name: '', role: 'owner' } })).toBeNull();
    expect(validateAppEvent({ ...pin(), source: 'slack' })).toBeNull();
    expect(validateAppEvent({ ...pin(), preview: 'x'.repeat(201) })).toBeNull();
    // Compared as text, so only the exact UTC form is accepted.
    expect(validateAppEvent({ ...pin(), at: '2026-11-09T10:00:00Z' })).toBeNull();
    expect(validateAppEvent({ ...pin(), at: '2026-11-09T12:00:00.000+02:00' })).toBeNull();
  });

  it('round-trips through the replicated wire form, with no dropped fields', () => {
    const data = buildAppConversationRecordData(pin({ preview: 'p' }))({ physical: 1, logical: 0 } as never, 'm1');
    expect(appEventFromReplicatedData(data!)).toEqual(pin({ preview: 'p' }));
    for (const f of ['pinnedMessageId', 'pinState', 'pinnedBy', 'preview', 'source']) expect(appConversationRecordStoreSchema.knownFields).toContain(f);
  });

  it('the winner is the greatest (at, machineId, eventId)', () => {
    const a = { at: '2026-11-09T10:00:00.000Z', machineId: 'm1', eventId: 'a' };
    expect(pinEventWins(a, null)).toBe(true);
    expect(pinEventWins({ ...a, at: '2026-11-09T10:00:00.001Z' }, a)).toBe(true);
    expect(pinEventWins({ ...a, machineId: 'm2' }, a)).toBe(true);
    expect(pinEventWins({ ...a, eventId: 'b' }, a)).toBe(true);
    expect(pinEventWins(a, { ...a, eventId: 'b' })).toBe(false);
  });
});

describe('the store', () => {
  it('reduces pin and unpin the same way in every arrival order', () => {
    const evs = [
      pin({ eventId: 'p1', at: '2026-11-09T10:00:00.000Z' }),
      pin({ eventId: 'p2', at: '2026-11-09T10:01:00.000Z', pinState: 'unpinned' }),
      pin({ eventId: 'p3', at: '2026-11-09T10:02:00.000Z', pinnedMessageId: 'msg-2' }),
    ];
    const orders = [[0, 1, 2], [2, 1, 0], [1, 0, 2], [1, 2, 0]];
    for (const o of orders) {
      const s = store(); seed(s);
      for (const i of o) s.ingestReplicated(evs[i]);
      expect(s.listPins(KEY).map((p) => p.messageId)).toEqual(['msg-2']);
      expect(s.pinState(KEY, 'msg-1')).toBe('unpinned');
    }
  });

  it('lists newest pin first and a pin never changes activity, preview or messages', () => {
    const s = store(); seed(s);
    const before = s.getConversation(KEY)!;
    s.append(pin({ eventId: 'p1', at: '2026-11-09T11:00:00.000Z' }));
    s.append(pin({ eventId: 'p2', at: '2026-11-09T11:05:00.000Z', pinnedMessageId: 'msg-2', preview: 'second' }));
    expect(s.listPins(KEY).map((p) => [p.messageId, p.preview])).toEqual([['msg-2', 'second'], ['msg-1', null]]);
    const after = s.getConversation(KEY)!;
    expect([after.lastActivity, after.lastPreview]).toEqual([before.lastActivity, before.lastPreview]);
    expect(s.browseMessages(KEY, null).messages.map((m) => m.messageId)).toEqual(['msg-1', 'msg-2']);
  });

  it('a rebuilt index reproduces the pins from the files', () => {
    const s = store(); seed(s);
    s.append(pin({ eventId: 'p1' }));
    s.append(pin({ eventId: 'p2', at: '2026-11-09T10:00:01.000Z', pinState: 'unpinned' }));
    s.append(pin({ eventId: 'p3', at: '2026-11-09T10:00:02.000Z', pinnedMessageId: 'msg-2' }));
    const want = s.listPins(KEY);
    s.rebuildIndex();
    expect(s.listPins(KEY)).toEqual(want);
  });

  it('a pin in a Telegram topic never lists as an app conversation', () => {
    const s = store();
    s.append(pin({ conversationKey: 'telegram:42', pinnedMessageId: '9001' }));
    expect(s.listConversations().conversations).toHaveLength(0);
    expect(s.listPins('telegram:42').map((p) => p.messageId)).toEqual(['9001']);
  });
});

describe('applyPin', () => {
  const by = { name: 'Justin', role: 'owner' as const };
  it('writes only on a change, and a retry is a duplicate', () => {
    const s = store(); seed(s);
    const base = { conversationKey: KEY, messageId: 'msg-1', by, source: 'app' as const, machineId: 'm1', at: '2026-11-09T10:00:00.000Z' };
    expect(applyPin(s, { ...base, pinned: true, eventId: 'r1' })).toEqual({ ok: true, changed: true, duplicate: false });
    expect(applyPin(s, { ...base, pinned: true, eventId: 'r1' })).toEqual({ ok: true, changed: false, duplicate: true });
    expect(applyPin(s, { ...base, pinned: true, eventId: 'r2' })).toEqual({ ok: true, changed: false, duplicate: false });
    expect(applyPin(s, { ...base, pinned: false, eventId: 'r3' })).toEqual({ ok: true, changed: true, duplicate: false });
    expect(applyPin(s, { ...base, pinned: false, eventId: 'r4' })).toEqual({ ok: true, changed: false, duplicate: false });
    expect(s.listPins(KEY)).toEqual([]);
  });

  it('a writer whose clock is behind still wins with its newer choice', () => {
    const s = store(); seed(s);
    const base = { conversationKey: KEY, messageId: 'msg-1', by, source: 'app' as const, machineId: 'm1' };
    applyPin(s, { ...base, pinned: true, eventId: 'r1', at: '2026-11-09T12:00:00.000Z' });
    applyPin(s, { ...base, pinned: false, eventId: 'r2', at: '2026-11-09T11:00:00.000Z' }); // an earlier clock
    expect(s.pinState(KEY, 'msg-1')).toBe('unpinned');
    expect(s.getEvent(KEY, 'r2')!.at).toBe('2026-11-09T12:00:00.001Z');
  });

  it('refuses a pin past the cap, but always allows an unpin', () => {
    const s = store(); seed(s);
    for (let i = 0; i < MAX_PINS_PER_CONVERSATION; i++) s.append(pin({ eventId: `p${i}`, pinnedMessageId: `m-${i}` }));
    const base = { conversationKey: KEY, by, source: 'app' as const, machineId: 'm1', at: '2026-11-09T13:00:00.000Z' };
    expect(applyPin(s, { ...base, messageId: 'msg-1', pinned: true, eventId: 'over' })).toEqual({ ok: false, error: 'too-many-pins' });
    expect(applyPin(s, { ...base, messageId: 'm-0', pinned: false, eventId: 'un' }).ok).toBe(true);
  });
});

describe('helpers', () => {
  it('pinRowsFor leaves out a pin the reader may not read and builds a read-time preview', () => {
    const s = store(); seed(s);
    s.append(pin({ eventId: 'p1' }));
    s.append(pin({ eventId: 'p2', at: '2026-11-09T10:00:01.000Z', pinnedMessageId: 'msg-2' }));
    expect(pinRowsFor(s, KEY, (id) => id !== 'msg-2').map((p) => p.messageId)).toEqual(['msg-1']);
    expect(pinRowsFor(s, KEY, () => true, (id) => `text of ${id}`)[0]).toMatchObject({ messageId: 'msg-2', preview: 'text of msg-2', pinnedBy: { name: 'Justin', role: 'owner' }, source: 'app' });
  });
  it('previews are one line and bounded', () => {
    expect(pinPreview('  a\n\nb\tc ')).toBe('a b c');
    expect(pinPreview('x'.repeat(300))!.length).toBe(200);
    expect(pinPreview('')).toBeUndefined();
    expect(pinPreview(null)).toBeUndefined();
  });
  it('tells real Telegram ids and Slack timestamps apart from stand-ins', () => {
    expect(isRealTelegramMessageId('4521')).toBe(true);
    expect(isRealTelegramMessageId(String(2 ** 52 + 5))).toBe(false);
    expect(isRealTelegramMessageId('msg-1')).toBe(false);
    expect(isSlackTs('1793600000.000100')).toBe(true);
    expect(isSlackTs('app-msg-1')).toBe(false);
  });
  it('the switch is on unless set to false', () => {
    expect(isConversationPinsEnabled({} as never)).toBe(true);
    expect(isConversationPinsEnabled({ mobilePairing: { native: { pins: { enabled: false } } } } as never)).toBe(false);
  });
  it('event ids are stable per request and per Telegram update', () => {
    expect(pinRequestEventId('d1', 'r1')).toBe(pinRequestEventId('d1', 'r1'));
    expect(pinRequestEventId('d1', 'r1')).not.toBe(pinRequestEventId('d2', 'r1'));
    expect(telegramPinEventId(7, 100, 101)).toBe(telegramPinEventId(7, 100, 101));
  });
});

describe('the team gate reads pin routes exactly', () => {
  it('a POST is a send and a GET is a read, for every kind of conversation', () => {
    expect(teamConversationTarget('POST', `/mobile/chat/app/${KEY}/pins`)).toEqual({ ref: KEY, op: 'send' });
    expect(teamConversationTarget('GET', `/mobile/chat/app/${KEY}/pins`)).toEqual({ ref: KEY, op: 'read' });
    expect(teamConversationTarget('POST', '/mobile/chat/7/pins')).toEqual({ ref: 'telegram:7', op: 'send' });
    expect(teamConversationTarget('GET', '/mobile/chat/7/pins')).toEqual({ ref: 'telegram:7', op: 'read' });
    expect(teamConversationTarget('POST', '/mobile/chat/slack/-3/pins')).toEqual({ ref: 'slack:-3', op: 'send' });
    // The existing mappings are unchanged.
    expect(teamConversationTarget('POST', `/mobile/chat/app/${KEY}`)).toEqual({ ref: KEY, op: 'send' });
    expect(teamConversationTarget('GET', `/mobile/chat/app/${KEY}/messages`)).toEqual({ ref: KEY, op: 'read' });
    expect(teamConversationTarget('POST', '/mobile/chat/7')).toEqual({ ref: 'telegram:7', op: 'send' });
  });
});
