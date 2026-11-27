/**
 * chats-model.js (dashboard-conversations-browser-device.md §4.8, §4.10, Tests: "Unit"): view
 * models, the five origin verdicts, the unread hook, cursor paging, the poll scheduler (budget
 * across several conversations, backoff, 404 fallback, no visible tab → no polls, leader handover),
 * the media type allowlist, and unfinished-send final states with the 23-hour rule.
 */
import { describe, it, expect } from 'vitest';
import * as m from '../../dashboard/console/chats-model.js';

const UUID = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';

describe('conversation refs and the hash', () => {
  it('round-trips opaque source message identities without accepting control characters or truncation', () => {
    expect(m.messageFromQuery('m=event%3Aone%26two')).toBe('event:one&two');
    expect(m.messageFromQuery('m=144556')).toBe('144556');
    for (const value of ['', 'x'.repeat(201), 'line\nfeed', '\u0000']) expect(m.messageFromQuery(`m=${encodeURIComponent(value)}`)).toBeNull();
    expect(m.messageFromQuery('c=telegram%3A7')).toBeNull();
  });
  it('parses and formats each kind, refusing anything else', () => {
    expect(m.parseConversationRef(`app:${UUID}`)).toEqual({ kind: 'app', id: UUID });
    expect(m.parseConversationRef('telegram:134088')).toEqual({ kind: 'telegram', id: '134088' });
    expect(m.parseConversationRef('slack:-42')).toEqual({ kind: 'slack', id: '-42' });
    for (const bad of ['app:not-a-uuid', 'telegram:0', 'telegram:abc', 'slack:x', 'mail:1', '', null]) expect(m.parseConversationRef(bad)).toBeNull();
    expect(m.refFromQuery(`c=${encodeURIComponent(`app:${UUID}`)}`)).toEqual({ kind: 'app', id: UUID });
    expect(m.hashFor({ kind: 'telegram', id: '7' })).toBe('#/work/chats?c=telegram%3A7');
  });
});

describe('the list', () => {
  const body = {
    conversations: [
      { id: UUID, platform: 'app', title: 'Plans', lastActivity: '2026-11-08T10:00:00Z', lastPreview: 'hi', machine: 'm1' },
      { id: 134088, platform: 'telegram', title: 'Instar', lastActivity: '2026-11-08T09:00:00Z', lastPreview: '', unreadCount: 3 },
      { id: -5, platform: 'slack', title: '#general', lastActivity: '2026-11-08T08:00:00Z', lastPreview: 'x', unreadCount: -1 },
      { id: 'junk', platform: 'app' },
      { id: 1, platform: 'mail' },
    ],
    nextCursor: 'abc', pool: { failed: [{ machineId: 'm2', reason: 'deadline' }] },
  };
  it('builds labelled rows, newest first as given, and drops rows it cannot address', () => {
    const rows = m.listRows(body);
    expect(rows.map((r: { key: string }) => r.key)).toEqual([`app:${UUID}`, 'telegram:134088', 'slack:-5']);
    expect(rows.map((r: { kindLabel: string }) => r.kindLabel)).toEqual(['App', 'Telegram', 'Slack']);
  });
  it('uses plain words for missing and synthetic Telegram titles while keeping address keys', () => {
    const rows = m.listRows({ conversations: [
      { id: 134088, platform: 'telegram' },
      { id: 42, platform: 'telegram', title: 'Telegram topic #42' },
      { id: 77, platform: 'telegram', title: '77' },
      { id: 32, platform: 'telegram', title: '  Release planning  ' },
      { id: UUID, platform: 'app', title: '123' },
    ] });
    expect(rows.map(row => [row.key, row.title])).toEqual([
      ['telegram:134088', 'Unnamed conversation'], ['telegram:42', 'Unnamed conversation'],
      ['telegram:77', 'Unnamed conversation'], ['telegram:32', 'Release planning'],
      [`app:${UUID}`, '123'],
    ]);
  });
  it('the unread hook: a non-negative integer count, else null', () => {
    const rows = m.listRows(body);
    expect(rows.map((r: { unread: number | null }) => r.unread)).toEqual([null, 3, null]);
  });
  it('reads the cursor and the machines that did not answer; pages merge without duplicates', () => {
    expect(m.listMeta(body)).toMatchObject({ nextCursor: 'abc', failed: [{ machineId: 'm2' }] });
    const a = m.listRows(body);
    const merged = m.mergeListPages(a, m.listRows({ conversations: [{ id: 134088, platform: 'telegram', title: 'dup' }, { id: 9, platform: 'telegram', title: 'new' }] }));
    expect(merged.map((r: { key: string }) => r.key)).toEqual([`app:${UUID}`, 'telegram:134088', 'slack:-5', 'telegram:9']);
    expect(m.listMeta({}).nextCursor).toBeNull();
  });
  it('titles are 1–80 characters', () => {
    expect(m.validTitle('  ok ')).toBe('ok');
    expect(m.validTitle('')).toBeNull();
    expect(m.validTitle('x'.repeat(81))).toBeNull();
  });
});

describe('bubbles and the five origin verdicts', () => {
  const op = (extra: object) => ({ eventId: 'e1', messageId: 'msg-1', role: 'operator', text: 'hello', at: '2026-11-08T10:00:00Z', deliveryState: 'delivered', ...extra });
  it('verified: signed; from a browser; this browser; approved on dashboard', () => {
    expect(m.bubble('app', op({ originVerified: 'verified' })).mark.label).toBe('signed');
    expect(m.bubble('app', op({ originVerified: 'verified', originClient: 'browser' })).mark.label).toBe('signed from a browser');
    expect(m.bubble('app', op({ originVerified: 'verified', originClient: 'browser' }), { own: () => true }).mark.label).toBe('signed (this browser)');
    expect(m.bubble('app', op({ originVerified: 'verified', originApprovedVia: 'dashboard-pin' })).mark.label).toBe('signed · approved on dashboard');
  });
  it('redacted, failed, unknown, none', () => {
    expect(m.bubble('app', op({ originVerified: 'redacted' })).mark.label).toBe('signed — an invite or desktop code was removed');
    expect(m.bubble('app', op({ originVerified: 'failed' })).mark).toMatchObject({ label: '⚠ signature does not check out', tone: 'bad' });
    expect(m.bubble('app', op({ originVerified: 'unknown' })).mark.label).toBe('couldn\'t check on this machine');
    expect(m.bubble('app', op({ originVerified: 'none' })).mark).toBeNull();
  });
  it('sides: operator right, agent left, Slack participants left with their name', () => {
    expect(m.bubble('app', { eventId: 'a', role: 'agent', text: 'x', at: '2026-11-08T10:00:00Z' }).side).toBe('left');
    expect(m.bubble('telegram', { messageId: 5, fromUser: true, text: 'x', timestamp: '2026-11-08T10:00:00Z' }).side).toBe('right');
    expect(m.bubble('telegram', { messageId: 6, fromUser: false, text: 'y', timestamp: '2026-11-08T10:00:00Z' }).side).toBe('left');
    const p = m.bubble('slack', { eventId: 'slack:1', role: 'participant', senderName: 'Dana', text: 'z', at: '2026-11-08T10:00:00Z' });
    expect(p).toMatchObject({ side: 'left', who: 'Dana' });
  });
  it('delivery states, with the refusal detail', () => {
    expect(m.bubble('app', op({ deliveryState: 'refused', deliveryDetail: 'paused' })).delivery.label).toBe('not delivered — paused');
    expect(m.bubble('app', op({ deliveryState: 'unknown' })).delivery.label).toBe('unknown — check the conversation');
    expect(m.bubble('app', op({ deliveryState: 'pending' })).delivery.label).toBe('sending');
  });
  it('events: messages become bubbles, delivery events update the state', () => {
    let list = m.applyEvents([], [{ kind: 'message', eventId: 'op-1', messageId: 'msg-1', role: 'operator', text: 'hi', at: '2026-11-08T10:00:00Z', deliveryState: 'pending' }]);
    expect(list[0].delivery.label).toBe('sending');
    list = m.applyEvents(list, [{ kind: 'delivery', messageId: 'msg-1', state: 'delivered' }, { kind: 'label', title: 'x' }]);
    expect(list).toHaveLength(1);
    expect(list[0].delivery.label).toBe('delivered');
  });
  it('bubbles sort oldest first and de-duplicate', () => {
    const b = m.bubbles('app', [
      { eventId: 'b', role: 'agent', text: '2', at: '2026-11-08T10:01:00Z' },
      { eventId: 'a', role: 'agent', text: '1', at: '2026-11-08T10:00:00Z' },
      { eventId: 'b', role: 'agent', text: '2 again', at: '2026-11-08T10:01:00Z' },
    ]);
    expect(b.map((x: { text: string }) => x.text)).toEqual(['1', '2 again']);
  });
});

describe('media type allowlist', () => {
  it('SVG, HTML, XML, PDF, HEIC and unknown are never viewable', () => {
    for (const t of ['image/svg+xml', 'text/html', 'application/xml', 'text/xml', 'application/pdf', 'image/heic', 'application/x-whatever', '', undefined]) {
      expect(m.blobTypeFor(t)).toBe('application/octet-stream');
    }
  });
  it('the listed types are viewable with their own type', () => {
    for (const t of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/quicktime', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav']) expect(m.blobTypeFor(t)).toBe(t);
    expect(m.blobTypeFor('IMAGE/PNG; charset=binary')).toBe('image/png');
    expect(m.attachmentView({ sha256: 'a', mediaType: 'image/svg+xml', filename: 'x.svg' }).display).toBe('file');
  });
  it('file limits', () => {
    expect(m.checkFiles([{ name: 'a', size: 10 }], { maxFiles: 10, maxFileBytes: 100, maxMessageBytes: 1000 }).ok).toBe(true);
    expect(m.checkFiles([{ name: 'a', size: 101 }], { maxFiles: 10, maxFileBytes: 100, maxMessageBytes: 1000 }).ok).toBe(false);
    expect(m.checkFiles(Array.from({ length: 11 }, () => ({ name: 'a', size: 1 })), { maxFiles: 10 }).ok).toBe(false);
  });
});

describe('unfinished sends', () => {
  const now = 1_800_000_000_000;
  const id = (ms: number) => `${String(ms)}-3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b`;
  it('retried only under the same device and machine, and under 23 hours', () => {
    const e = { requestId: id(now - 1000), deviceId: 'd1', machineId: 'm1' };
    expect(m.unfinishedAction(e, { deviceId: 'd1', machineId: 'm1', nowMs: now })).toBe('retry');
    expect(m.unfinishedAction(e, { deviceId: 'd2', machineId: 'm1', nowMs: now })).toBe('unknown');
    expect(m.unfinishedAction(e, { deviceId: 'd1', machineId: 'm2', nowMs: now })).toBe('unknown');
    expect(m.unfinishedAction({ ...e, requestId: id(now - 23 * 3600_000 - 1) }, { deviceId: 'd1', machineId: 'm1', nowMs: now })).toBe('unknown');
    expect(m.unfinishedAction({ requestId: 'x' }, { deviceId: 'd1', machineId: 'm1', nowMs: now })).toBe('drop');
  });
  it('final states: a delivery state, 404, 403, 409; 429/5xx/network are retried', () => {
    expect(m.sendOutcome(200, { deliveryState: 'delivered' })).toMatchObject({ final: true, state: 'delivered' });
    expect(m.sendOutcome(200, { deliveryState: 'pending' }).final).toBe(false);
    expect(m.sendOutcome(404, {})).toMatchObject({ final: true, state: 'gone' });
    // Live proof findings: a Telegram send answers `outcome`, and a 503 that names its reason is final.
    expect(m.sendOutcome(200, { ok: true, outcome: 'delivered', eventId: 'op-1', mirrored: true })).toMatchObject({ final: true, state: 'delivered' });
    expect(m.sendOutcome(200, { ok: true, outcome: 'refused' })).toMatchObject({ final: true, state: 'refused' });
    expect(m.sendOutcome(503, { error: 'chat-unavailable', detail: 'This agent has no Telegram owner to speak as.' })).toMatchObject({ final: true, state: 'refused', label: { label: 'not delivered — This agent has no Telegram owner to speak as.' } });
    expect(m.sendOutcome(503, {}).final).toBe(false);
    // The read-only note names the right reason (live proof finding).
    expect(m.telegramReadOnlyNote({ approvalPath: 'telegram', telegramSend: false })).toBe('Sending to Telegram works from the machine serving Telegram.');
    expect(m.telegramReadOnlyNote({ approvalPath: 'dashboard', telegramSend: false })).toMatch(/needs a Telegram owner/);
    expect(m.sendOutcome(403, {}).final).toBe(true);
    expect(m.sendOutcome(409, {}).label.label).toBe('unknown — check the conversation');
    expect(m.sendOutcome(409, { error: 'not-serving' }).label.label).toBe('Sending to Telegram works from the machine serving Telegram');
    for (const s of [429, 500, 503, 0]) expect(m.sendOutcome(s, {}).final).toBe(false);
  });
});

describe('one poller per browser', () => {
  it('the union drops stale announcements, keeps at most 8, and always keeps the focused tab\'s', () => {
    const now = 100_000;
    const anns = Array.from({ length: 10 }, (_, i) => ({ tab: `t${i}`, ref: `telegram:${i + 1}`, at: now - 1000, focusedAt: i * 10 }));
    anns.push({ tab: 'old', ref: 'telegram:99', at: now - 26_000, focusedAt: 1e9 });
    anns.push({ tab: 'f', ref: 'telegram:50', at: now, focusedAt: 0, focused: true } as never);
    const u = m.pollUnion(anns, now);
    expect(u).toHaveLength(8);
    expect(u[0]).toBe('telegram:50');
    expect(u).not.toContain('telegram:99');
    expect(u).not.toContain('telegram:1');
  });

  it('never more than the budget a minute, never two at once, nothing while hidden', () => {
    const s = m.createScheduler({ budget: 60 });
    let t = 0;
    s.setConversations([1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ ref: `app:${i}`, kind: 'app' })), t);
    expect(s.next(t, { visible: false }).task).toBeUndefined();
    let reads = 0;
    const startTimes: number[] = [];
    while (t < 5 * 60_000) {
      const n = s.next(t);
      if (n.task) {
        s.start(n.task, t); startTimes.push(t); reads++;
        expect(s.next(t).task).toBeUndefined(); // the first is still in flight
        t += 50;
        s.finish(n.task, t, { status: 200 });
      } else t += Math.max(1, Math.min(n.waitMs ?? 100, 1000));
    }
    for (let i = 0; i < startTimes.length; i++) {
      const inMinute = startTimes.filter((x) => x > startTimes[i]! - 60_000 && x <= startTimes[i]!).length;
      expect(inMinute).toBeLessThanOrEqual(60);
    }
    expect(reads).toBeGreaterThan(200); // the budget is actually used, not starved
    // With eight conversations the 4 s interval is stretched to fit.
    expect(s.intervalOf('events|app:1')).toBeGreaterThan(4000);
  });

  it('a 429 doubles the interval up to 30 s, honouring Retry-After; a success halves it back', () => {
    const s = m.createScheduler({ budget: 1000 });
    s.setConversations([{ ref: 'app:1', kind: 'app' }], 0);
    const task = s.tasks().find((x: { mode: string }) => x.mode === 'events');
    for (let i = 0; i < 6; i++) { s.start(task, 0); s.finish(task, 0, { status: 429 }); }
    expect(s.intervalOf('events|app:1')).toBe(30_000);
    s.start(task, 0); s.finish(task, 0, { status: 429, retryAfterMs: 45_000 });
    expect(s.next(40_000).task?.id).not.toBe('events|app:1');
    s.start(task, 50_000); s.finish(task, 50_000, { status: 200 });
    expect(s.intervalOf('events|app:1')).toBe(15_000);
  });

  it('an app conversation whose events answer 404 falls back to the pool page every 15 s, then recovers', () => {
    const s = m.createScheduler();
    s.setConversations([{ ref: 'app:1', kind: 'app' }], 0);
    s.fallBack('app:1', 0);
    expect(s.tasks().map((x: { id: string }) => x.id)).toContain('fallback|app:1');
    expect(s.intervalOf('fallback|app:1')).toBe(15_000);
    s.recover('app:1', 1);
    expect(s.tasks().map((x: { id: string }) => x.id)).toContain('events|app:1');
  });

  it('Telegram and Slack: newest page every 5 s plus a pool read every 30 s', () => {
    const s = m.createScheduler({ budget: 1000 });
    s.setConversations([{ ref: 'telegram:1', kind: 'telegram' }], 0);
    const ids = s.tasks().map((x: { id: string }) => x.id).sort();
    expect(ids).toEqual(['list', 'newest|telegram:1', 'pool|telegram:1']);
    expect(s.intervalOf('newest|telegram:1')).toBe(5000);
    expect(s.intervalOf('pool|telegram:1')).toBe(30_000);
  });

  it('a new leader carries the backoff state on', () => {
    const a = m.createScheduler({ budget: 1000 });
    a.setConversations([{ ref: 'app:1', kind: 'app' }], 0);
    const task = a.tasks().find((x: { mode: string }) => x.mode === 'events');
    a.start(task, 0); a.finish(task, 0, { status: 429 });
    const b = m.createScheduler({ budget: 1000 });
    b.setConversations([{ ref: 'app:1', kind: 'app' }], 0);
    b.restore(a.snapshot());
    expect(b.intervalOf('events|app:1')).toBe(a.intervalOf('events|app:1'));
  });

  it('operator reads spend from the same budget', () => {
    const s = m.createScheduler({ budget: 2 });
    s.setConversations([], 0);
    s.spend(0); s.spend(1);
    expect(s.canSpend(2)).toBe(false);
    expect(s.next(2).waitMs).toBeGreaterThan(0);
    expect(s.canSpend(60_001)).toBe(true);
  });
});

describe('setup words', () => {
  it('names every refusal in plain words', () => {
    expect(m.setupRefusal(409, { error: 'approval-unavailable' })).toBe('Set up this browser from the machine serving Telegram.');
    expect(m.setupRefusal(503, { error: 'browser-devices-off' })).toContain('switched off');
    expect(m.setupRefusal(0, {})).toBe('The agent could not be reached.');
  });
});

describe('approval wording names the private chat', () => {
  it('names the bot and says not a group, and falls back without a name', () => {
    expect(m.approvalWords('telegram', { name: 'Echo Agent', username: 'echo_test_bot' }))
      .toBe('Approve it in your private Telegram chat with Echo Agent (@echo_test_bot), not a group (tap Approve, or type the code here), or on your phone.');
    expect(m.privateChatWords({ name: 'Echo Agent', username: null })).toBe('your private Telegram chat with Echo Agent, not a group');
    expect(m.privateChatWords({ name: 'Echo Agent', username: 'bad name!' })).toBe('your private Telegram chat with Echo Agent, not a group');
    expect(m.approvalWords('telegram')).toBe('Approve it in your private Telegram chat with the agent (tap Approve, or type the code here), or on your phone.');
    expect(m.privateChatWords(null)).toBe('your private Telegram chat with the agent');
  });
  it('owner-phone comes first, with Telegram as a backup only when its copy went out', () => {
    expect(m.approvalWords('owner-phone', { name: 'Echo Agent', username: 'echo_test_bot' }, true))
      .toBe('Approve it on your iPhone: open the Instar app and confirm with Face ID. Or tap Approve in your private Telegram chat with Echo Agent (@echo_test_bot), not a group, which also has a code you can type here.');
    expect(m.approvalWords('owner-phone', null, false)).toBe('Approve it on your iPhone: open the Instar app and confirm with Face ID.');
  });
});

describe('Chief of Staff: pinned row and tree order (chief-of-staff-topic.md §1.4)', () => {
  const body = {
    conversations: [
      { id: 5, platform: 'telegram', title: 'Unfiled', lastActivity: '2030-01-01T00:00:05Z' },
      { id: 4, platform: 'telegram', title: 'Sub', lastActivity: '2030-01-01T00:00:04Z', parentConversationKey: 'telegram:3' },
      { id: 3, platform: 'telegram', title: 'Project', lastActivity: '2030-01-01T00:00:03Z', parentConversationKey: 'telegram:1' },
      { id: 2, platform: 'telegram', title: 'Orphan', lastActivity: '2030-01-01T00:00:02Z', parentConversationKey: 'telegram:999' },
      { id: 1, platform: 'telegram', title: '🧭 Chief of Staff', lastActivity: '2030-01-01T00:00:01Z', parentConversationKey: null },
    ],
    pinned: { id: 1, platform: 'telegram', title: '🧭 Chief of Staff', lastActivity: '2030-01-01T00:00:01Z', parentConversationKey: null },
  };
  it('listPinned reads the pinned row; absent ⇒ null', () => {
    expect(m.listPinned(body)?.key).toBe('telegram:1');
    expect(m.listPinned({ conversations: [] })).toBeNull();
  });
  it('orderWithTree: pinned first, children under parents depth-first, unknown parents stay top-level in place', () => {
    const ordered = m.orderWithTree(m.listRows(body), 'telegram:1');
    expect(ordered.map((r) => [r.key, r.depth])).toEqual([['telegram:1', 0], ['telegram:3', 1], ['telegram:4', 2], ['telegram:5', 0], ['telegram:2', 0]]);
  });
  it('a cycle in the records never loops the view and still shows every row', () => {
    const rows = m.listRows({ conversations: [
      { id: 7, platform: 'telegram', title: 'A', parentConversationKey: 'telegram:8' },
      { id: 8, platform: 'telegram', title: 'B', parentConversationKey: 'telegram:7' },
    ] });
    const ordered = m.orderWithTree(rows, null);
    expect(ordered.map((r) => r.key).sort()).toEqual(['telegram:7', 'telegram:8']);
  });
  it('without the fields (feature off) nothing changes: no parent, no pin, flat order', () => {
    const rows = m.listRows({ conversations: [{ id: 1, platform: 'telegram', title: 'x' }, { id: 2, platform: 'telegram', title: 'y' }] });
    expect(rows.every((r) => r.parent === null)).toBe(true);
    expect(m.orderWithTree(rows, null).map((r) => [r.key, r.depth])).toEqual([['telegram:1', 0], ['telegram:2', 0]]);
  });
});

describe('pinned messages (conversation-pinned-messages)', () => {
  const pins = [
    { messageId: 'msg-2', pinnedAt: '2026-11-09T10:01:00.000Z', pinnedBy: { name: 'Justin', role: 'owner' }, preview: 'second', source: 'app' },
    { messageId: 'msg-1', pinnedAt: '2026-11-09T10:00:00.000Z', pinnedBy: { name: 'Ada', role: 'telegram' }, preview: null, source: 'telegram' },
    { messageId: 'bad id', preview: 'dropped' },
  ];
  it('reads pins from an answer, dropping malformed ones, and null when the answer has none', () => {
    const got = m.pinsFrom({ pins })!;
    expect(got.map((p) => p.messageId)).toEqual(['msg-2', 'msg-1']);
    expect(got[1]).toMatchObject({ who: 'Ada', preview: null, fromTelegram: true });
    expect(m.pinsFrom({ messages: [] })).toBeNull();
  });
  it('the bar shows the pin and "1 of N", and a tap steps to the next, back to the first', () => {
    const got = m.pinsFrom({ pins })!;
    expect(m.pinBarText(got, 0)).toEqual({ label: 'Pinned', count: '1 of 2', preview: 'second', messageId: 'msg-2' });
    expect(m.pinBarText(got, 1)).toMatchObject({ count: '2 of 2', preview: 'Pinned message' });
    expect(m.pinBarText([got[0]], 0)).toMatchObject({ count: '' });
    expect(m.pinBarText([], 0)).toBeNull();
    expect([m.nextPinIndex(0, 2), m.nextPinIndex(1, 2), m.nextPinIndex(0, 0)]).toEqual([1, 0, 0]);
  });
  it('only a real message can be pinned; a Telegram row needs its Telegram id', () => {
    expect(m.pinIdOf('app', { id: 'e1', messageId: 'msg-1' })).toBe('msg-1');
    expect(m.pinIdOf('app', { id: 'local:1', messageId: 'msg-1' })).toBeNull();
    expect(m.pinIdOf('telegram', { id: 'e1', messageId: '9001' })).toBe('9001');
    expect(m.pinIdOf('telegram', { id: 'e1', messageId: null })).toBeNull();
    expect(m.pinIdOf('slack', { id: 'slack:1', messageId: '1793600000.000100' })).toBe('1793600000.000100');
  });
  it('names each pin route and the words an answer leaves', () => {
    expect(m.pinsPathOf({ kind: 'app', id: UUID })).toBe(`/mobile/chat/app/${UUID}/pins`);
    expect(m.pinsPathOf({ kind: 'telegram', id: '42' })).toBe('/mobile/chat/42/pins');
    expect(m.pinsPathOf({ kind: 'slack', id: '-3' })).toBe('/mobile/chat/slack/-3/pins');
    expect(m.pinOutcomeWords({ ok: true, data: { mirror: 'done' } })).toBe('');
    expect(m.pinOutcomeWords({ ok: true, data: { mirror: 'failed', mirrorDetail: 'Telegram did not let the agent pin this message. The pin is kept in the app.' } })).toContain('kept in the app');
    expect(m.pinOutcomeWords({ ok: false, data: { error: 'too-many-pins' } })).toContain('100 pinned messages');
  });
});

describe('conversations pinned to the top of the list (conversation-list-pins)', () => {
  const body = {
    conversations: [
      { id: UUID, platform: 'app', title: 'Plans', lastActivity: '2026-11-14T09:00:00.000Z', lastPreview: 'fresh' },
      { id: 7, platform: 'telegram', title: 'Ops', lastActivity: '2026-11-13T09:00:00.000Z' },
      { id: -5, platform: 'slack', title: 'DM', lastActivity: null, machine: 'm1' },
    ],
    pinnedRows: [
      { id: -5, platform: 'slack', title: 'DM', lastActivity: null, machine: 'm1' },
      { id: UUID, platform: 'app', title: 'Plans', lastActivity: '2026-11-14T08:00:00.000Z', lastPreview: 'older copy' },
    ],
  };
  it('reads pinnedRows in pin order; absent ⇒ null (feature off or a later page)', () => {
    expect(m.listPinnedRows(body)!.map((r: { key: string }) => r.key)).toEqual(['slack:-5', `app:${UUID}`]);
    expect(m.listPinnedRows({ conversations: [] })).toBeNull();
    expect(m.listPinnedRows({ pinnedRows: [] })).toEqual([]);
  });
  it('splits the list: pinned first in pin order, preferring the list\'s own newer copy; the rest keep their order', () => {
    const rows = m.listRows(body);
    const { pinned, rest } = m.splitPinned(rows, m.listPinnedRows(body));
    expect(pinned.map((r: { key: string }) => r.key)).toEqual(['slack:-5', `app:${UUID}`]);
    expect(pinned[1].preview).toBe('fresh');
    expect(rest.map((r: { key: string }) => r.key)).toEqual(['telegram:7']);
    // A pinned row older than the page still leads.
    const older = m.splitPinned(rows.slice(1), m.listPinnedRows(body));
    expect(older.pinned.map((r: { key: string }) => r.key)).toEqual(['slack:-5', `app:${UUID}`]);
    expect(m.splitPinned(rows, null).pinned).toEqual([]);
  });
  it('the pin ref of a row is the canonical one the route takes', () => {
    const rows = m.listRows(body);
    expect(m.listPinRefOf(rows[0])).toBe(`app:${UUID}`);
    expect(m.listPinRefOf(rows[1])).toBe('telegram:7');
    expect(m.listPinRefOf(rows[2])).toBe('slack:m1:-5');
    expect(m.listPinRefOf({ ...rows[2], machine: null })).toBeNull();
  });
  it('plain words for a refused pin', () => {
    expect(m.listPinOutcomeWords({ ok: true, data: {} })).toBeNull();
    expect(m.listPinOutcomeWords({ ok: false, data: { error: 'pin-limit' } })).toContain('50 pinned conversations');
    expect(m.listPinOutcomeWords({ ok: false, data: { error: 'list-pins-off' } })).toContain('turned off');
  });
});

describe('message time (bubble and pin line)', () => {
  // Local-time constructors keep these independent of the machine's time zone.
  const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).toISOString();
  const nowMs = new Date(2026, 10, 17, 0, 1).getTime(); // Nov 17, 2026, 00:01

  it('shows only the time for a message sent today', () => {
    const text = m.messageTime(at(2026, 10, 17, 0, 0), nowMs, 'en-US');
    expect(text).toMatch(/^12:00\sAM$/);
    expect(text).not.toMatch(/2026|Nov/);
  });

  it('shows day, month, year and time for yesterday at 23:59 when it is now 00:01', () => {
    expect(m.messageTime(at(2026, 10, 16, 23, 59), nowMs, 'en-US')).toMatch(/^Nov 16, 2026,? 11:59\sPM$/);
  });

  it('shows the other year for a message from a previous year', () => {
    expect(m.messageTime(at(2025, 0, 3, 9, 5), nowMs, 'en-US')).toMatch(/^Jan 3, 2025,? 9:05\sAM$/);
  });

  it('returns nothing for a missing or unreadable time', () => {
    expect(m.messageTime('', nowMs)).toBe('');
    expect(m.messageTime('not a date', nowMs)).toBe('');
    expect(m.messageTime(undefined as unknown as string, nowMs)).toBe('');
  });
});

describe('the list grouped by the conversation hierarchy (console-chats-grouped)', () => {
  const effortA = { kind: 'effort', id: 'eff-a' };
  const effortB = { kind: 'effort', id: 'eff-b' };
  const sub = { kind: 'effort', id: 'eff-a-sub' };
  const tg = (topicId: number) => ({ kind: 'conversation', platform: 'telegram', chatId: '-100', topicId });
  const conv = (topicId: number, path: Array<{ ref: unknown; title: string }>) => ({
    ref: tg(topicId), title: `T${topicId}`, kind: 'conversation', role: path.length ? 'worker' : 'unassigned', primaryPath: path,
    visibleChildCount: 0, source: { platform: 'telegram', conversationId: topicId, title: `T${topicId}` },
  });
  const page = (items: unknown[], nextCursor: string | null = null) => ({ items, partial: false, nextCursor });
  const body = { conversations: [
    { id: 1, platform: 'telegram', title: 'Chief of Staff', lastActivity: '2026-11-17T12:00:00Z', unreadCount: 1 },
    { id: 2, platform: 'telegram', title: 'Build', lastActivity: '2026-11-17T11:00:00Z', unreadCount: 2 },
    { id: 3, platform: 'telegram', title: 'Loose', lastActivity: '2026-11-17T10:00:00Z' },
    { id: 4, platform: 'telegram', title: 'Deep', lastActivity: '2026-11-17T09:00:00Z', unreadCount: 3 },
    { id: 5, platform: 'telegram', title: 'Other', lastActivity: '2026-11-17T08:00:00Z' },
  ] };

  it('indexes each conversation under its TOP-LEVEL effort, across pages; nested efforts roll up', () => {
    const index = m.hierarchyIndex([
      page([conv(2, [{ ref: effortA, title: 'App work' }]), { ref: effortA, title: 'App work', kind: 'effort', role: 'effort', primaryPath: [], visibleChildCount: 2 }], 'next'),
      page([conv(4, [{ ref: effortA, title: 'App work' }, { ref: sub, title: 'Sub' }]), conv(5, [{ ref: effortB, title: '  ' }]), conv(3, [])]),
    ])!;
    expect(index.get('telegram:2')?.title).toBe('App work');
    expect(index.get('telegram:4')).toEqual(index.get('telegram:2'));
    expect(index.get('telegram:5')?.title).toBe('Untitled group');
    expect(index.has('telegram:3')).toBe(false);
  });

  it('a malformed or missing hierarchy reads as none (the list stays flat)', () => {
    expect(m.hierarchyIndex([])).toBeNull();
    expect(m.hierarchyIndex([{ items: 'x', partial: false }])).toBeNull();
    expect(m.hierarchyIndex([page([{ ref: { kind: 'bogus' }, title: 'x' }])])).toBeNull();
  });

  it('groupRows: Chief of Staff leads alone, one group per effort with count and unread, the rest "Not in a group yet"', () => {
    const index = m.hierarchyIndex([page([conv(2, [{ ref: effortA, title: 'App work' }]), conv(4, [{ ref: effortA, title: 'App work' }]), conv(5, [{ ref: effortB, title: 'Windows' }])])]);
    const g = m.groupRows(m.listRows(body), index, 'telegram:1');
    expect(g.lead?.key).toBe('telegram:1');
    expect(g.groups.map((x: { title: string; count: number; unread: number }) => [x.title, x.count, x.unread])).toEqual([['App work', 2, 5], ['Windows', 1, 0]]);
    expect(g.groups[0].rows.map((r: { key: string; depth: number }) => [r.key, r.depth])).toEqual([['telegram:2', 1], ['telegram:4', 1]]);
    expect(g.groups[0].lastActivity).toBe('2026-11-17T11:00:00Z');
    expect(g.ungrouped.map((r: { key: string }) => r.key)).toEqual(['telegram:3']);
    expect(m.groupCountWords(1)).toBe('1 conversation');
    expect(m.groupCountWords(2)).toBe('2 conversations');
  });

  it('the remembered view: only "all" means all; anything else is grouped', () => {
    expect(m.listViewFrom('all')).toBe('all');
    for (const v of ['grouped', null, '', 'x']) expect(m.listViewFrom(v)).toBe('grouped');
  });
});

describe('which groups are tracked projects (console-chats-grouped)', () => {
  const effA = { kind: 'effort', id: 'eff-a' };
  const effB = { kind: 'effort', id: 'eff-b' };
  const tgRef = (topicId: number) => ({ kind: 'conversation', platform: 'telegram', chatId: '-100', topicId });
  const conv = (topicId: number, path: Array<{ ref: unknown; title: string }>) => ({
    ref: tgRef(topicId), title: `T${topicId}`, kind: 'conversation', role: 'worker', primaryPath: path, visibleChildCount: 0,
    source: { platform: 'telegram', conversationId: topicId, title: `T${topicId}` },
  });
  const effort = (ref: unknown, title: string, frontDoor?: unknown) => ({ ref, title, kind: 'effort', role: 'effort', primaryPath: [], visibleChildCount: 1, metadata: frontDoor ? { frontDoor } : {} });
  const pages = [{ partial: false, nextCursor: null, items: [
    conv(20, [{ ref: effA, title: 'Apps' }]), conv(21, [{ ref: effA, title: 'Apps' }, { ref: { kind: 'effort', id: 'sub' }, title: 'Sub' }]),
    effort(effA, 'Apps', tgRef(21)), conv(30, [{ ref: effB, title: 'Misc' }]), effort(effB, 'Misc'),
  ] }];

  it('effortMembers lists every conversation under each top-level effort, front door first, nested ones included', () => {
    const members = m.effortMembers(pages)!;
    const keyA = [...members.keys()].find((k) => members.get(k)!.includes('telegram:20'))!;
    expect(members.get(keyA)).toEqual(['telegram:21', 'telegram:20']);
    expect([...members.values()]).toContainEqual(['telegram:30']);
    expect(m.effortMembers([{ items: 'x', partial: false }])).toBeNull();
  });

  it('the status chip mapping is shared with the phone apps: route states and raw verdicts; pausedBy wins; anything else no chip', () => {
    const chip = (p: object) => m.projectStatusOf(p)?.label ?? null;
    for (const w of ['moving', 'moving-under-existing-owner']) expect(chip({ state: w })).toBe('Moving');
    for (const w of ['stalled', 'stopped-retrying', 'stuck']) expect(chip({ state: w })).toBe('Stuck');
    for (const w of ['waiting-on-you', 'waiting-on-user']) expect(chip({ lastVerdict: w })).toBe('Needs you');
    for (const w of ['done', 'done-verified']) expect(chip({ state: w })).toBe('Done');
    expect(chip({ state: 'drifting' })).toBe('Drifting');
    expect(chip({ state: 'paused' })).toBe('Paused');
    expect(chip({ state: 'moving', pausedBy: 'owner' })).toBe('Paused');
    for (const w of ['claims-done', 'unknown', 'toString', '']) expect(chip({ state: w })).toBeNull();
  });

  it('projectsForGroups: a group is a project when ANY conversation under it is tracked (front door first); a failed read leaves all plain', () => {
    const members = m.effortMembers(pages)!;
    const tracked = m.trackedProjects({ projects: [
      { key: 'telegram:20', conversationKey: 'telegram:20', title: 'Worker project', state: 'stalled' },
      { key: 'telegram:21', title: 'Front door project', state: 'waiting-on-you' },
    ] })!;
    const byGroup = m.projectsForGroups(members, tracked);
    expect(byGroup.size).toBe(1);
    const p = [...byGroup.values()][0];
    expect(p.title).toBe('Front door project');
    expect(p.status.label).toBe('Needs you');
    expect(p.href).toBe('#/work/board?project=telegram%3A21');
    expect(m.projectsForGroups(members, m.trackedProjects(null)).size).toBe(0);
    expect(m.projectsForGroups(null, tracked).size).toBe(0);
    // A bare app id is an app conversation key.
    const app = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    expect(m.trackedProjects({ projects: [{ key: app, state: 'moving' }] })!.has(`app:${app}`)).toBe(true);
  });
});

describe('messagePieces: inline markdown in a message (console-chat-markdown)', () => {
  const plain = (text: string) => ({ text, bold: false, italic: false, code: false, strike: false, url: null });
  it('text with no markers comes back unchanged, line breaks and list dashes as typed', () => {
    expect(m.messagePieces('hello there')).toEqual([plain('hello there')]);
    expect(m.messagePieces('Plan:\n- one\n- two')).toEqual([plain('Plan:\n- one\n- two')]);
    expect(m.messagePieces('')).toEqual([]);
  });
  it('bold, italic, code and strike', () => {
    expect(m.messagePieces('**Build things.** now')).toEqual([{ ...plain('Build things.'), bold: true }, plain(' now')]);
    expect(m.messagePieces('__b__')).toEqual([{ ...plain('b'), bold: true }]);
    expect(m.messagePieces('an *idea* and _another_')).toEqual([plain('an '), { ...plain('idea'), italic: true }, plain(' and '), { ...plain('another'), italic: true }]);
    expect(m.messagePieces('run `npm **test**`')).toEqual([plain('run '), { ...plain('npm **test**'), code: true }]);
    expect(m.messagePieces('~~gone~~')).toEqual([{ ...plain('gone'), strike: true }]);
  });
  it('***x*** is bold and italic', () => {
    expect(m.messagePieces('***both***')).toEqual([{ ...plain('both'), bold: true, italic: true }]);
  });
  it('my_file_name is not italic; an unmatched marker stays literal', () => {
    expect(m.messagePieces('open my_file_name.txt')).toEqual([plain('open my_file_name.txt')]);
    expect(m.messagePieces('2 * 3 = 6')).toEqual([plain('2 * 3 = 6')]);
    expect(m.messagePieces('**not closed')).toEqual([plain('**not closed')]);
    expect(m.messagePieces('a `tick')).toEqual([plain('a `tick')]);
  });
  it('web links become links; javascript: and data: stay as the typed text', () => {
    expect(m.messagePieces('see [docs](https://example.com/x)')).toEqual([plain('see '), { ...plain('docs'), url: 'https://example.com/x' }]);
    expect(m.messagePieces('[x](javascript:alert(1))')).toEqual([plain('[x](javascript:alert(1))')]);
    expect(m.messagePieces('[x](data:text/html,hi)')).toEqual([plain('[x](data:text/html,hi)')]);
    expect(m.safeMessageUrl('http://a.b')).toBe('http://a.b');
    expect(m.safeMessageUrl('JavaScript:alert(1)')).toBeNull();
  });

  it('grouped sections (iPhone parity, Justin 2026-11-18): Projects apart from Groups, no empty groups, project names without "Project:"', () => {
    // The prefix rule: only "Project" + a separator; "Projector…" stays whole; nothing left → unchanged.
    expect(m.stripProjectPrefix('Project: Instar topic management')).toBe('Instar topic management');
    expect(m.stripProjectPrefix('Project \u2013 Windows app')).toBe('Windows app');
    expect(m.stripProjectPrefix('Project - Mac app')).toBe('Mac app');
    expect(m.stripProjectPrefix('project:lowercase')).toBe('lowercase');
    expect(m.stripProjectPrefix('Project \u2014 Em dash')).toBe('Em dash');
    expect(m.stripProjectPrefix('Projector setup')).toBe('Projector setup');
    expect(m.stripProjectPrefix('Projects: plural')).toBe('Projects: plural');
    expect(m.stripProjectPrefix('Project:')).toBe('Project:');
    expect(m.stripProjectPrefix('My Project: x')).toBe('My Project: x');
    // Display title: the tracked project's own title first; else the group title stripped; plain groups untouched.
    expect(m.groupDisplayTitle({ title: 'Project: Old name' }, { key: 'telegram:9', title: 'Real project' })).toBe('Real project');
    expect(m.groupDisplayTitle({ title: 'Project: Old name' }, { key: 'telegram:9', title: 'Project: Real' })).toBe('Real');
    expect(m.groupDisplayTitle({ title: 'Project: Old name' }, { key: 'telegram:9', title: '' })).toBe('Old name');
    expect(m.groupDisplayTitle({ title: 'Project \u2013 Old' }, { key: 'telegram:9', title: 'telegram:9' })).toBe('Old');
    expect(m.groupDisplayTitle({ title: 'Projector setup' }, { key: 'k', title: '' })).toBe('Projector setup');
    expect(m.groupDisplayTitle({ title: 'Project: Plain group' }, null)).toBe('Project: Plain group');
    // Sections: order kept within each, empty groups dropped.
    const projects = new Map([['e1', { key: 'telegram:9', title: 'Tracked', status: { label: 'Moving', tone: 'ok' }, href: '#x' }]]);
    const groups = [
      { key: 'e0', title: 'Plain A', rows: [{}], count: 1, unread: 0 },
      { key: 'e1', title: 'Project: Tracked group', rows: [{}, {}], count: 2, unread: 0 },
      { key: 'e2', title: 'Untitled group', rows: [], count: 0, unread: 0 },
      { key: 'e3', title: 'Plain B', rows: [{}], count: 1, unread: 0 },
    ];
    const s = m.groupSections(groups, projects);
    expect(s.projects.map((g: any) => [g.key, g.displayTitle, g.project.status.label])).toEqual([['e1', 'Tracked', 'Moving']]);
    expect(s.groups.map((g: any) => [g.key, g.displayTitle, g.project])).toEqual([['e0', 'Plain A', null], ['e3', 'Plain B', null]]);
    // An empty project group is hidden too; no projects map → every group is plain.
    expect(m.groupSections([{ ...groups[1], rows: [], count: 0 }], projects)).toEqual({ projects: [], groups: [] });
    expect(m.groupSections(groups, null).projects).toEqual([]);
    expect(m.groupSections(null, projects)).toEqual({ projects: [], groups: [] });
  });
});

describe('quick-page payload diff (telegram-slack-change-feed)', () => {
  const h = (n: number) => n.toString(16).padStart(64, '0');
  const page = (hashes: string[], messages: unknown[]) => ({ messages, changeFeed: { rowHashes: hashes } });

  it('keeps late and future timestamps, and replaces the full row when delivery or origin changes', () => {
    const future = { messageId: 1, timestamp: '2099-01-01T00:00:00Z', text: 'future clock' };
    const pending = { messageId: 'app-2', timestamp: '2026-11-22T00:00:00Z', text: 'hello', deliveryState: 'pending' };
    const first = m.rebuildQuickPage(null, page([h(1), h(2)], [future, pending]));
    const late = { messageId: 3, timestamp: '2020-01-01T00:00:00Z', text: 'arrived late' };
    const delivered = { ...pending, deliveryState: 'delivered', originVerified: 'verified' };
    const next = m.rebuildQuickPage(first.cache, page([h(1), h(4), h(3)], [delivered, late]));
    expect(next.data.messages).toEqual([future, delivered, late]);
    expect([...next.cache.rows.values()]).toEqual(next.data.messages);
    expect(next.cache.hashes).toEqual([h(1), h(4), h(3)]);
  });

  it('an empty network delta becomes a full broadcast page for a new tab, reopened chat and new leader', () => {
    const rows = [{ messageId: 1, text: 'one' }, { messageId: 2, text: 'two' }];
    const original = m.rebuildQuickPage(null, page([h(1), h(2)], rows));
    const broadcast = m.rebuildQuickPage(original.cache, page([h(1), h(2)], []));
    expect(broadcast.data.messages).toEqual(rows);
    const newTab = m.rebuildQuickPage(null, structuredClone(broadcast.data));
    expect(newTab.data.messages).toEqual(rows);
    expect(newTab.cache.hashes).toEqual([h(1), h(2)]);
    const newLeader = m.rebuildQuickPage(newTab.cache, page([h(1), h(2)], []));
    expect(newLeader.data.messages).toEqual(rows);
    expect(m.rebuildQuickPage(null, newLeader.data).data.messages).toEqual(rows);
  });

  it('drops departed hashes and learns each new hash only alongside its actual row', () => {
    const old = m.rebuildQuickPage(null, page([h(1), h(2)], [{ messageId: 1 }, { messageId: 2 }]));
    const next = m.rebuildQuickPage(old.cache, page([h(2), h(3)], [{ messageId: 3 }]));
    expect(next.cache.hashes).toEqual([h(2), h(3)]);
    expect(next.cache.rows.has(h(1))).toBe(false);
    expect(next.data.messages).toEqual([{ messageId: 2 }, { messageId: 3 }]);
  });

  it('rejects missing/extra delta rows and malformed hash metadata instead of inheriting unseen hashes', () => {
    for (const data of [page([h(1)], []), page([], [{ messageId: 1 }]), page(['bad'], [{}]), page(Array.from({ length: 101 }, (_, i) => h(i)), Array.from({ length: 101 }, () => ({}))), { messages: [], changeFeed: {} }]) {
      expect(m.rebuildQuickPage(null, data)).toEqual({ data: null, cache: null });
    }
    expect(m.rebuildQuickPage(null, page([h(1)], [null]))).toEqual({ data: null, cache: null });
  });

  it('retains repeated identical rows and their positions when the next delta is empty', () => {
    const row = { messageId: 1, text: 'retried log row' };
    const initial = m.rebuildQuickPage(null, page([h(1), h(1)], [row, { ...row }]));
    expect(initial.data.messages).toEqual([row, row]);
    expect(initial.cache.hashes).toEqual([h(1), h(1)]);
    const unchanged = m.rebuildQuickPage(initial.cache, page([h(1), h(1)], []));
    expect(unchanged.data.messages).toEqual([row, row]);
    expect(m.rebuildQuickPage(null, unchanged.data).data.messages).toEqual([row, row]);
  });

  it('older agents return plain full pages and never create a hash baseline', () => {
    const data = { messages: [{ messageId: 1, text: 'legacy' }] };
    const previous = m.rebuildQuickPage(null, page([h(1)], [{}])).cache;
    expect(m.rebuildQuickPage(previous, data)).toEqual({ data, cache: null });
  });
});
