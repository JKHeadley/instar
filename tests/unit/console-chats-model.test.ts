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
