import { describe, it, expect } from 'vitest';
import {
  ISSUES_TOPIC_OFFSET,
  inboundTopicId,
  normalizeInboundThread,
  toWireParams,
  isIssuesTopicId,
  IssuesChatNotConfiguredError,
} from '../../src/messaging/telegramTopicSpace.js';

const MAIN = '-1003742343280';
const ISSUES = '-1004375010975';
const cfg = { mainChatId: MAIN, issuesChatId: ISSUES };

describe('telegramTopicSpace — inbound', () => {
  it('maps an issues-group thread into the offset range', () => {
    expect(inboundTopicId(Number(ISSUES), 5, cfg)).toBe(ISSUES_TOPIC_OFFSET + 5);
  });

  it('leaves main-group threads untouched', () => {
    expect(inboundTopicId(Number(MAIN), 5, cfg)).toBe(5);
    expect(inboundTopicId(Number(MAIN), undefined, cfg)).toBe(1);
  });

  it('sets the field for the issues General topic (Telegram omits it)', () => {
    const msg: { chat: { id: number }; message_thread_id?: number } = { chat: { id: Number(ISSUES) } };
    normalizeInboundThread(msg, cfg);
    expect(msg.message_thread_id).toBe(ISSUES_TOPIC_OFFSET + 1);
  });

  it('is idempotent — normalizing twice adds the offset once', () => {
    const msg = { chat: { id: Number(ISSUES) }, message_thread_id: 7 };
    normalizeInboundThread(msg, cfg);
    normalizeInboundThread(msg, cfg);
    expect(msg.message_thread_id).toBe(ISSUES_TOPIC_OFFSET + 7);
  });

  it('is a strict no-op when no issues chat is configured', () => {
    const msg = { chat: { id: Number(ISSUES) }, message_thread_id: 7 };
    normalizeInboundThread(msg, { mainChatId: MAIN });
    expect(msg.message_thread_id).toBe(7);
  });
});

describe('telegramTopicSpace — outbound', () => {
  it('routes an issues-range topic to the issues chat with the real thread', () => {
    const out = toWireParams({ chat_id: MAIN, message_thread_id: ISSUES_TOPIC_OFFSET + 5, text: 'hi' }, cfg);
    expect(out).toEqual({ chat_id: ISSUES, message_thread_id: 5, text: 'hi' });
  });

  it('omits the thread for the issues General topic', () => {
    const out = toWireParams({ chat_id: MAIN, message_thread_id: ISSUES_TOPIC_OFFSET + 1, text: 'hi' }, cfg);
    expect(out.chat_id).toBe(ISSUES);
    expect('message_thread_id' in out).toBe(false);
  });

  it('round-trips inbound → outbound', () => {
    const msg = { chat: { id: Number(ISSUES) }, message_thread_id: 42 };
    normalizeInboundThread(msg, cfg);
    const out = toWireParams({ chat_id: MAIN, message_thread_id: msg.message_thread_id }, cfg);
    expect(out).toEqual({ chat_id: ISSUES, message_thread_id: 42 });
  });

  it('maps a reply_to_message_id in the range (topic-name probe)', () => {
    const t = ISSUES_TOPIC_OFFSET + 12;
    const out = toWireParams({ chat_id: MAIN, message_thread_id: t, reply_to_message_id: t }, cfg);
    expect(out.reply_to_message_id).toBe(12);
  });

  it('leaves main-group sends byte-identical (same object)', () => {
    const p = { chat_id: MAIN, message_thread_id: 127831, text: 'x' };
    expect(toWireParams(p, cfg)).toBe(p);
  });

  it('is idempotent — translating twice equals once', () => {
    const once = toWireParams({ chat_id: MAIN, message_thread_id: ISSUES_TOPIC_OFFSET + 3 }, cfg);
    expect(toWireParams(once, cfg)).toBe(once);
  });

  it('never touches a request addressed to some other chat', () => {
    const p = { chat_id: '12345', message_thread_id: ISSUES_TOPIC_OFFSET + 3 };
    expect(toWireParams(p, cfg)).toBe(p);
  });

  it('refuses an issues-range id when no issues chat is configured', () => {
    expect(() => toWireParams({ chat_id: MAIN, message_thread_id: ISSUES_TOPIC_OFFSET + 3 }, { mainChatId: MAIN }))
      .toThrow(IssuesChatNotConfiguredError);
  });

  it('classifies ids', () => {
    expect(isIssuesTopicId(ISSUES_TOPIC_OFFSET + 1)).toBe(true);
    expect(isIssuesTopicId(String(ISSUES_TOPIC_OFFSET + 1))).toBe(true);
    expect(isIssuesTopicId(127831)).toBe(false);
    expect(isIssuesTopicId(-5)).toBe(false);
  });
});
