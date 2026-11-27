import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { forwardedDeliveryHistoryTopic, forwardedDeliveryRow, originMessageHistoryText } from '../../../src/messaging/telegram-origin/ForwardedDeliveryHistory.js';
import type { OriginPreparedBotOperation } from '../../../src/messaging/telegram-origin/TelegramOriginService.js';
import { lateRecoveredReplyNotice } from '../../../src/messaging/telegram-origin/SessionDeliveryNotice.js';

describe('authored history text shared by direct and forwarded recovery', () => {
  it('preserves exact Markdown and literal HTML-shaped code without decoding it', () => {
    const text = '**Approve** *read*. Keep `<i>literal code</i>` and &amp; unchanged.';
    expect(originMessageHistoryText({ policy: { text }, body: JSON.stringify({ text: '<b>wire</b>' }) })).toBe(text);
    expect(originMessageHistoryText({ policy: { text: '' }, body: JSON.stringify({ text: 'wire' }) })).toBe('');
  });
  it('retains the existing wire-only fallback without guessing lost authored bytes', () => {
    expect(originMessageHistoryText({ body: JSON.stringify({ text: 'plain legacy body' }) })).toBe('plain legacy body');
    for (const body of [undefined, 'null', '{broken', '{}']) expect(originMessageHistoryText({ body })).toBeNull();
  });
  it('preserves the late line at its stored marking age, without adding it twice to wire fallback', () => {
    const firstPreparedAt = 1_000, lateMarkedAt = firstPreparedAt + 7 * 60_000;
    const line = lateRecoveredReplyNotice(firstPreparedAt, lateMarkedAt)!;
    const text = '**The earlier reply.**';
    expect(originMessageHistoryText({ policy: { text } }, { firstPreparedAt, lateMarkedAt })).toBe(`${line}\n\n${text}`);
    const wire = `${line}\n\nThe earlier reply.`;
    expect(originMessageHistoryText({ body: JSON.stringify({ text: wire }) }, { firstPreparedAt, lateMarkedAt })).toBe(wire);
    expect(originMessageHistoryText({ policy: { text } }, { firstPreparedAt, lateMarkedAt: null })).toBe(text);
  });
  it('does not double an old sealed late line or strip a matching line from actual authored prose', () => {
    const firstPreparedAt = 1_000, lateMarkedAt = firstPreparedAt + 7 * 60_000;
    const line = lateRecoveredReplyNotice(firstPreparedAt, lateMarkedAt)!;
    const text = `${line}\n\nThe earlier answer.`;
    const timing = { firstPreparedAt, lateMarkedAt, footer: 'Echo' };
    expect(originMessageHistoryText({ policy: { text },
      body: JSON.stringify({ text: `${text}\n\nEcho`, parse_mode: 'HTML' }) }, timing)).toBe(text);
    expect(originMessageHistoryText({ policy: { text },
      body: JSON.stringify({ text: `${line}\n\n${text}\n\nEcho`, parse_mode: 'HTML' }) }, timing)).toBe(`${line}\n\n${text}`);
  });
});

function operation(input: { method?: string; policyText?: string; bodyText?: string; topicId?: string | null; chatId?: string | null; producerKind?: string } = {}): OriginPreparedBotOperation {
  const request: Record<string, unknown> = { method: input.method ?? 'sendMessage',
    body: JSON.stringify({ chat_id: '-100123', text: input.bodyText ?? '<b>formatted</b>' }) };
  if (input.policyText !== undefined) request.policy = { text: input.policyText };
  return {
    record: { destination: { chatId: input.chatId === undefined ? '-100123' : input.chatId, topicId: input.topicId === undefined ? '141868' : input.topicId },
      producerKind: input.producerKind ?? 'session' },
    admission: { children: [{ materializations: [{ requestJson: JSON.stringify(request) }] }] },
  } as unknown as OriginPreparedBotOperation;
}

describe('forwardedDeliveryRow', () => {
  it('uses the pre-format policy text so history matches what the sender would have recorded', () => {
    expect(forwardedDeliveryRow(operation({ policyText: '**Decide A or B**' }), 141952))
      .toEqual({ chatId: '-100123', threadId: 141868, text: '**Decide A or B**', messageId: 141952, producerKind: 'session' });
  });
  it('falls back to the wire text when no policy text was sealed', () => {
    expect(forwardedDeliveryRow(operation({ bodyText: 'plain body' }), 7)?.text).toBe('plain body');
  });
  it('records nothing without a concrete Telegram receipt', () => {
    for (const id of [undefined, 0, -1, 1.5, '141952', Number.NaN]) expect(forwardedDeliveryRow(operation({ policyText: 'x' }), id)).toBeNull();
  });
  it('records nothing for non-text methods, General (no thread), or a missing chat', () => {
    expect(forwardedDeliveryRow(operation({ method: 'editMessageText', policyText: 'x' }), 5)).toBeNull();
    expect(forwardedDeliveryRow(operation({ topicId: null, policyText: 'x' }), 5)).toBeNull();
    expect(forwardedDeliveryRow(operation({ chatId: null, policyText: 'x' }), 5)).toBeNull();
  });
  it('records nothing when the sealed request is unreadable', () => {
    const broken = operation({ policyText: 'x' });
    (broken.admission.children[0].materializations[0] as { requestJson: string }).requestJson = '{not json';
    expect(forwardedDeliveryRow(broken, 5)).toBeNull();
  });
});

describe('forwardedDeliveryHistoryTopic', () => {
  const row = { chatId: '-100123', threadId: 2578 };
  it('maps the main chat to the thread id and the issues chat to the offset topic', () => {
    expect(forwardedDeliveryHistoryTopic(row, { mainChatId: '-100123', issuesChatId: '-100999' })).toBe(2578);
    expect(forwardedDeliveryHistoryTopic({ ...row, chatId: '-100999' }, { mainChatId: '-100123', issuesChatId: -100999 })).toBe(10_000_002_578);
  });
  it('has no history topic for an unknown chat', () => {
    expect(forwardedDeliveryHistoryTopic({ ...row, chatId: '-100555' }, { mainChatId: '-100123' })).toBeNull();
    expect(forwardedDeliveryHistoryTopic(row, {})).toBeNull();
  });
});

describe('wiring', () => {
  it('server boot assigns the holder history recorder to the origin runtime', () => {
    const server = readFileSync(new URL('../../../src/commands/server.ts', import.meta.url), 'utf8');
    expect(server).toMatch(/telegramOriginBoot\.runtime\.options\.onForwardedDelivered = row =>/);
    expect(server).toMatch(/telegram\.recordRecoveredOutbound\(historyTopicId, row\.text, row\.messageId/);
  });
});
