/**
 * The Chief of Staff's own Telegram topic (docs/specs/chief-of-staff-topic.md §1.4, Migration):
 * dark ⇒ nothing created or pinned; standby never mints; the holder creates once, records the id and
 * pins the greeting; a changed displayName renames exactly once; a reused topic is recorded, not
 * duplicated; rollback unpins and keeps the topic; re-enable re-pins; Telegram failures never throw.
 */
import { describe, it, expect } from 'vitest';
import { ensureChiefOfStaffTopic, chiefOfStaffTopicTitle, CHIEF_OF_STAFF_TOPIC_STATE_KEY, CHIEF_OF_STAFF_TOPIC_NAME_STATE_KEY, CHIEF_OF_STAFF_TOPIC_PINNED_STATE_KEY, type ChiefOfStaffTopicTelegram, type ChiefOfStaffTopicState } from '../../src/messaging/ChiefOfStaffTopic.js';

function fakeState(initial: Record<string, unknown> = {}, readOnly = false): ChiefOfStaffTopicState & { data: Record<string, unknown> } {
  const data = { ...initial };
  return { data, readOnly, get: <T,>(k: string) => (k in data ? (data[k] as T) : null), set: (k, v) => { if (readOnly) throw new Error('read-only'); data[k] = v; } };
}
function fakeTelegram(over: Partial<ChiefOfStaffTopicTelegram> & { reuse?: boolean } = {}) {
  const calls: string[] = [];
  let next = 500;
  const t: ChiefOfStaffTopicTelegram & { calls: string[] } = {
    calls,
    findOrCreateForumTopic: async (name) => { calls.push(`create:${name}`); return { topicId: 777, name, reused: over.reuse === true }; },
    editForumTopic: async (id, name) => { calls.push(`rename:${id}:${name}`); return true; },
    sendGreeting: async (id) => { calls.push(`send:${id}`); return { messageId: ++next }; },
    pinTopicMessage: async (id, m) => { calls.push(`pin:${id}:${m}`); return true; },
    unpinTopicMessages: async (id) => { calls.push(`unpin:${id}`); return true; },
    ...over,
  };
  return t;
}
const on = { enabled: () => true, displayName: () => undefined };

describe('ensureChiefOfStaffTopic', () => {
  it('dark: nothing created, nothing pinned, nothing recorded', async () => {
    const t = fakeTelegram(); const s = fakeState();
    expect(await ensureChiefOfStaffTopic(t, s, { enabled: () => false, displayName: () => undefined })).toEqual({ outcome: 'dark' });
    expect(t.calls).toEqual([]); expect(s.data).toEqual({});
  });
  it('an unreadable gate reads as OFF', async () => {
    const t = fakeTelegram(); const s = fakeState();
    expect(await ensureChiefOfStaffTopic(t, s, { enabled: () => { throw new Error('config'); }, displayName: () => undefined })).toEqual({ outcome: 'dark' });
    expect(t.calls).toEqual([]);
  });
  it('standby with nothing recorded never mints; it waits to adopt', async () => {
    const t = fakeTelegram(); const s = fakeState({}, true);
    expect(await ensureChiefOfStaffTopic(t, s, on)).toEqual({ outcome: 'standby-awaiting-adoption' });
    expect(t.calls).toEqual([]);
  });
  it('the holder creates once, records the id + title, sends and pins the greeting; the next boot is a no-op', async () => {
    const t = fakeTelegram(); const s = fakeState();
    const r = await ensureChiefOfStaffTopic(t, s, on);
    expect(r).toEqual({ outcome: 'created', topicId: 777, pinned: true });
    expect(s.data[CHIEF_OF_STAFF_TOPIC_STATE_KEY]).toBe(777);
    expect(s.data[CHIEF_OF_STAFF_TOPIC_NAME_STATE_KEY]).toBe(chiefOfStaffTopicTitle(undefined));
    expect(s.data[CHIEF_OF_STAFF_TOPIC_PINNED_STATE_KEY]).toBe(true);
    expect(t.calls).toEqual([`create:${chiefOfStaffTopicTitle(undefined)}`, 'send:777', 'pin:777:501']);
    expect(await ensureChiefOfStaffTopic(t, s, on)).toEqual({ outcome: 'present', topicId: 777 });
    expect(t.calls).toHaveLength(3);
  });
  it('a topic that already exists by name is reused, not duplicated', async () => {
    const t = fakeTelegram({ reuse: true }); const s = fakeState();
    expect(await ensureChiefOfStaffTopic(t, s, on)).toEqual({ outcome: 'reused', topicId: 777, pinned: true });
  });
  it('a changed displayName renames exactly once and keeps the emoji', async () => {
    const t = fakeTelegram(); const s = fakeState();
    await ensureChiefOfStaffTopic(t, s, on);
    const renamed = { enabled: () => true, displayName: () => 'COO' };
    expect(await ensureChiefOfStaffTopic(t, s, renamed)).toEqual({ outcome: 'renamed', topicId: 777 });
    expect(t.calls.filter((c) => c.startsWith('rename:'))).toEqual(['rename:777:🧭 COO']);
    expect(await ensureChiefOfStaffTopic(t, s, renamed)).toEqual({ outcome: 'present', topicId: 777 });
    expect(t.calls.filter((c) => c.startsWith('rename:'))).toHaveLength(1);
  });
  it('rollback: feature off with a recorded topic ⇒ unpinned, topic kept; re-enable re-pins', async () => {
    const t = fakeTelegram(); const s = fakeState();
    await ensureChiefOfStaffTopic(t, s, on);
    const off = { enabled: () => false, displayName: () => undefined };
    expect(await ensureChiefOfStaffTopic(t, s, off)).toEqual({ outcome: 'unpinned', topicId: 777 });
    expect(s.data[CHIEF_OF_STAFF_TOPIC_STATE_KEY]).toBe(777); expect(s.data[CHIEF_OF_STAFF_TOPIC_PINNED_STATE_KEY]).toBe(false);
    expect(await ensureChiefOfStaffTopic(t, s, off)).toEqual({ outcome: 'kept-dark', topicId: 777 });
    expect(t.calls.filter((c) => c.startsWith('unpin:'))).toHaveLength(1);
    expect(await ensureChiefOfStaffTopic(t, s, on)).toEqual({ outcome: 'present', topicId: 777 });
    expect(s.data[CHIEF_OF_STAFF_TOPIC_PINNED_STATE_KEY]).toBe(true);
    expect(t.calls.filter((c) => c.startsWith('pin:'))).toHaveLength(2);
  });
  it('a standby with the feature off and an adopted id writes nothing', async () => {
    const t = fakeTelegram(); const s = fakeState({ [CHIEF_OF_STAFF_TOPIC_STATE_KEY]: 777, [CHIEF_OF_STAFF_TOPIC_PINNED_STATE_KEY]: true }, true);
    expect(await ensureChiefOfStaffTopic(t, s, { enabled: () => false, displayName: () => undefined })).toEqual({ outcome: 'kept-dark', topicId: 777 });
    expect(t.calls).toEqual([]);
  });
  it('Telegram failures never throw: create failure is reported; a held greeting defers the pin; a failed pin is retried next boot', async () => {
    const s1 = fakeState();
    const r1 = await ensureChiefOfStaffTopic(fakeTelegram({ findOrCreateForumTopic: async () => { throw new Error('429'); } }), s1, on);
    expect(r1).toEqual({ outcome: 'failed', reason: '429' }); expect(s1.data).toEqual({});
    const s2 = fakeState();
    let t = Date.parse('2026-11-10T00:00:00Z');
    const onAt = { ...on, now: () => t };
    const held = fakeTelegram({ sendGreeting: async () => ({}) });
    expect(await ensureChiefOfStaffTopic(held, s2, onAt)).toEqual({ outcome: 'created', topicId: 777, pinned: false });
    expect(s2.data[CHIEF_OF_STAFF_TOPIC_PINNED_STATE_KEY]).toBeUndefined();
    // next boot within 24h: NO second greeting (one held copy, not one per boot)
    const again = fakeTelegram();
    t += 3_600_000;
    expect(await ensureChiefOfStaffTopic(again, s2, onAt)).toEqual({ outcome: 'present', topicId: 777 });
    expect(again.calls.filter((c) => c.startsWith('send:'))).toEqual([]);
    // after 24h the greeting is sent again, delivered this time, and pinned
    t += 24 * 3_600_000;
    expect(await ensureChiefOfStaffTopic(again, s2, onAt)).toEqual({ outcome: 'present', topicId: 777 });
    expect(again.calls.filter((c) => c.startsWith('send:'))).toHaveLength(1);
    expect(s2.data[CHIEF_OF_STAFF_TOPIC_PINNED_STATE_KEY]).toBe(true);
    // a delivered greeting whose PIN failed: the next boot pins the STORED id without sending a second greeting
    const s3 = fakeState();
    const pinFails = fakeTelegram({ pinTopicMessage: async () => false });
    expect(await ensureChiefOfStaffTopic(pinFails, s3, on)).toEqual({ outcome: 'created', topicId: 777, pinned: false });
    const retry = fakeTelegram();
    expect(await ensureChiefOfStaffTopic(retry, s3, on)).toEqual({ outcome: 'present', topicId: 777 });
    expect(retry.calls).toEqual(['pin:777:501']); // the stored greeting id, no send
  });
  it('the title is the emoji + the display name, bounded', () => {
    expect(chiefOfStaffTopicTitle('  ')).toBe('🧭 Chief of Staff');
    expect(chiefOfStaffTopicTitle('x'.repeat(200)).length).toBeLessThanOrEqual(100);
  });
});
