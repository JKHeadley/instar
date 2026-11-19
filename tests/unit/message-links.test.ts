/**
 * messageLinks (docs/specs/waiting-on-you-links.md §1): every builder returns a link that opens,
 * or says why it cannot. Both sides of each shape boundary.
 */
import { describe, it, expect } from 'vitest';
import {
  telegramMessageLink,
  slackMessageLink,
  isSlackWorkspaceUrl,
  appConversationLink,
  workCardLink,
  classifyAskLinks,
} from '../../src/core/messageLinks.js';

describe('telegramMessageLink', () => {
  it('a supergroup forum topic gets the thread form', () => {
    expect(telegramMessageLink({ chatId: '-1001234567890', topicId: 141385, messageId: 145385 }))
      .toEqual({ ok: true, url: 'https://t.me/c/1234567890/141385/145385' });
  });
  it('the General topic (id 1) and no topic get the plain form', () => {
    expect(telegramMessageLink({ chatId: -1001234567890, topicId: 1, messageId: 7 })).toEqual({ ok: true, url: 'https://t.me/c/1234567890/7' });
    expect(telegramMessageLink({ chatId: '-1001234567890', messageId: '7' })).toEqual({ ok: true, url: 'https://t.me/c/1234567890/7' });
  });
  it('an Issues-group topic links into the Issues chat with its own thread id', () => {
    expect(telegramMessageLink({ chatId: '-1001234567890', issuesChatId: '-100555', topicId: 10_000_002_750, messageId: 9 }))
      .toEqual({ ok: true, url: 'https://t.me/c/555/2750/9' });
    // Issues-group General (stored as OFFSET + 1) has no thread segment.
    expect(telegramMessageLink({ chatId: '-1001234567890', issuesChatId: '-100555', topicId: 10_000_000_001, messageId: 9 }))
      .toEqual({ ok: true, url: 'https://t.me/c/555/9' });
  });
  it('an Issues-group topic with no Issues chat configured is refused, never linked into the main chat', () => {
    expect(telegramMessageLink({ chatId: '-1001234567890', topicId: 10_000_002_750, messageId: 9 })).toEqual({ ok: false, reason: 'chat-not-linkable' });
  });
  it('a private chat or basic group has no shareable link', () => {
    expect(telegramMessageLink({ chatId: '123456789', topicId: 5, messageId: 7 })).toEqual({ ok: false, reason: 'chat-not-linkable' });
    expect(telegramMessageLink({ chatId: '-4567', messageId: 7 })).toEqual({ ok: false, reason: 'chat-not-linkable' });
    expect(telegramMessageLink({ chatId: undefined, messageId: 7 })).toEqual({ ok: false, reason: 'chat-not-linkable' });
  });
  it('malformed ids are refused, never guessed', () => {
    for (const messageId of [0, -3, 1.5, 'abc', '12x', '']) {
      expect(telegramMessageLink({ chatId: '-1001', messageId: messageId as never })).toEqual({ ok: false, reason: 'invalid-input' });
    }
    expect(telegramMessageLink({ chatId: '-1001', topicId: 'x', messageId: 3 })).toEqual({ ok: false, reason: 'invalid-input' });
  });
});

describe('slackMessageLink', () => {
  const ws = 'https://acme.slack.com/';
  it('a top-level message gets the documented permalink', () => {
    expect(slackMessageLink({ workspaceUrl: ws, channel: 'C0123ABC', ts: '1731900000.123456' }))
      .toEqual({ ok: true, url: 'https://acme.slack.com/archives/C0123ABC/p1731900000123456' });
  });
  it('a thread reply carries thread_ts and cid', () => {
    expect(slackMessageLink({ workspaceUrl: ws, channel: 'C0123ABC', ts: '1731900100.000200', threadTs: '1731900000.123456' }))
      .toEqual({ ok: true, url: 'https://acme.slack.com/archives/C0123ABC/p1731900100000200?thread_ts=1731900000.123456&cid=C0123ABC' });
  });
  it('an Enterprise Grid address is accepted', () => {
    expect(slackMessageLink({ workspaceUrl: 'https://acme.enterprise.slack.com/', channel: 'C0123ABC', ts: '1731900000.123456' }).ok).toBe(true);
  });
  it('an unknown address is pending; a foreign or http one is unsupported', () => {
    expect(slackMessageLink({ workspaceUrl: null, channel: 'C0123ABC', ts: '1731900000.123456' })).toEqual({ ok: false, reason: 'workspace-pending' });
    expect(slackMessageLink({ workspaceUrl: 'https://evil.example.com/', channel: 'C0123ABC', ts: '1731900000.123456' })).toEqual({ ok: false, reason: 'workspace-unsupported' });
    expect(slackMessageLink({ workspaceUrl: 'http://acme.slack.com/', channel: 'C0123ABC', ts: '1731900000.123456' })).toEqual({ ok: false, reason: 'workspace-unsupported' });
  });
  it('malformed channel or ts is refused', () => {
    expect(slackMessageLink({ workspaceUrl: ws, channel: 'general', ts: '1731900000.123456' })).toEqual({ ok: false, reason: 'invalid-input' });
    expect(slackMessageLink({ workspaceUrl: ws, channel: 'C0123ABC', ts: '1731900000' })).toEqual({ ok: false, reason: 'invalid-input' });
  });
  it('isSlackWorkspaceUrl accepts only https team addresses', () => {
    expect(isSlackWorkspaceUrl('https://acme.slack.com/')).toBe(true);
    expect(isSlackWorkspaceUrl('https://acme.slack.com/archives/x')).toBe(false);
    expect(isSlackWorkspaceUrl('https://slack.com.evil.io/')).toBe(false);
  });
});

describe('console links', () => {
  const origin = 'https://agent.example-tunnel.dev';
  const uuid = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  it('an app conversation opens on its chats route', () => {
    const r = appConversationLink(origin, `app:${uuid}`);
    expect(r).toEqual({ ok: true, url: `${origin}/dashboard/console/#/work/chats?c=${encodeURIComponent(`app:${uuid}`)}` });
    expect(appConversationLink(origin, uuid)).toEqual(r);
  });
  it('a non-uuid conversation key is refused', () => {
    expect(appConversationLink(origin, 'app:../etc')).toEqual({ ok: false, reason: 'invalid-input' });
  });
  it('a card opens on the board route', () => {
    expect(workCardLink(origin, 'wc_0123456789abcdef')).toEqual({ ok: true, url: `${origin}/dashboard/console/#/work/board?card=wc_0123456789abcdef` });
    expect(workCardLink(origin, 'not-a-card')).toEqual({ ok: false, reason: 'invalid-input' });
  });
});

describe('classifyAskLinks', () => {
  const chat = '-1001234567890';
  const none = { message: 0, card: 0, conversation: 0, localOnly: 0, other: 0 };
  it('a bare reminder has no links of any kind', () => {
    expect(classifyAskLinks('Still waiting on you: the screen-lock question I sent at 2:46.', { telegramChatId: chat }))
      .toEqual({ counts: none, telegramRefs: [], cardRefs: [] });
  });
  it('counts each kind by its literal shape and returns this chat\'s message refs', () => {
    const text = [
      'ask: https://t.me/c/1234567890/141385/145385',
      'general: https://t.me/c/1234567890/77',
      'slack: https://acme.slack.com/archives/C0123ABC/p1731900000123456',
      'card: https://x.example-tunnel.dev/dashboard/console/#/work/board?card=wc_0123456789abcdef',
      'chat: https://x.example-tunnel.dev/dashboard/console/#/work/chats?c=app%3A3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      'local: http://localhost:4042/dashboard/console/#/work/board?card=wc_0123456789abcdef',
      'pr: https://github.com/o/r/pull/1',
    ].join('\n');
    expect(classifyAskLinks(text, { telegramChatId: chat })).toEqual({
      counts: { message: 3, card: 1, conversation: 1, localOnly: 1, other: 1 },
      telegramRefs: [{ topicId: 141385, messageId: 145385 }, { topicId: null, messageId: 77 }],
      cardRefs: [{ cardId: 'wc_0123456789abcdef', origin: 'https://x.example-tunnel.dev' }],
    });
  });
  it('a link into the Issues group reports the internal topic id; a repeated link is listed once', () => {
    const r = classifyAskLinks('https://t.me/c/555/2750/9 and again https://t.me/c/555/2750/9', { telegramChatId: chat, telegramIssuesChatId: '-100555' });
    expect(r.counts.message).toBe(2);
    expect(r.telegramRefs).toEqual([{ topicId: 10_000_002_750, messageId: 9, issues: true }]);
    // a General-form link into the Issues group names its group, since it carries no topic
    expect(classifyAskLinks('https://t.me/c/555/9', { telegramChatId: chat, telegramIssuesChatId: '-100555' }).telegramRefs).toEqual([{ topicId: null, messageId: 9, issues: true }]);
  });
  it("another chat's t.me link, or one with no chat known, is other", () => {
    expect(classifyAskLinks('https://t.me/c/999/5/6', { telegramChatId: chat }).counts).toEqual({ ...none, other: 1 });
    expect(classifyAskLinks('https://t.me/c/1234567890/5/6').counts).toEqual({ ...none, other: 1 });
  });
});
