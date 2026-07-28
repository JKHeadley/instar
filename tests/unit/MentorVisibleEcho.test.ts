import { describe, expect, it, vi } from 'vitest';
import {
  MENTOR_ECHO_SHORTENED,
  TELEGRAM_TEXT_LIMIT,
  planMentorVisibleEcho,
  sendMentorVisibleEcho,
} from '../../src/core/MentorVisibleEcho.js';

describe('mentor visible echo', () => {
  it.each([4096, 4097, 9000])('chunks %i body characters safely and reassembles exactly', (length) => {
    const body = `${'line payload\n'.repeat(Math.ceil(length / 13))}`.slice(0, length);
    const plan = planMentorVisibleEcho(body, '[mentor]');
    expect(plan.shortened).toBe(false);
    expect(plan.messages.length).toBeLessThanOrEqual(3);
    expect(plan.messages.every((message) => message.length <= TELEGRAM_TEXT_LIMIT)).toBe(true);
    expect(plan.bodyChunks.join('')).toBe(body);
    plan.messages.forEach((message, i) => expect(message).toContain(`[mentor] (${i + 1}/${plan.messages.length})`));
  });

  it('caps pathological prompts at three messages with an honest shortened tail', () => {
    const plan = planMentorVisibleEcho('x'.repeat(30_000), '[mentor]');
    expect(plan.messages).toHaveLength(3);
    expect(plan.shortened).toBe(true);
    expect(plan.messages[2]).toContain(MENTOR_ECHO_SHORTENED);
    expect(plan.messages.every((message) => message.length <= TELEGRAM_TEXT_LIMIT)).toBe(true);
  });

  it('posts tagged chunks to the configured topic in order', async () => {
    const sent: Array<{ topic: number; text: string }> = [];
    await sendMentorVisibleEcho('x'.repeat(9000), {
      enabled: true,
      topicId: 458,
      roleTag: '[mentor]',
      bot: { sendToTopic: async (topic, text) => { sent.push({ topic, text }); } },
    });
    expect(sent).toHaveLength(3);
    expect(sent.every((row) => row.topic === 458)).toBe(true);
    expect(sent.map((row) => row.text.replace(/^\[mentor\] \(\d\/\d\)\n/, '')).join('')).toBe('x'.repeat(9000));
  });

  it('reports one honest partial failure and never retries', async () => {
    const send = vi.fn(async () => {
      if (send.mock.calls.length === 2) throw new Error('telegram down');
    });
    const report = vi.fn();
    await sendMentorVisibleEcho('x'.repeat(9000), {
      enabled: true, topicId: 458, roleTag: '[mentor]', bot: { sendToTopic: send }, reportFailure: report,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toContain('chunk 2/3 failed after 1 landed');
  });

  it('skips honestly when unconfigured or opted out', async () => {
    const log = vi.fn();
    const send = vi.fn();
    await sendMentorVisibleEcho('prompt', { enabled: true, roleTag: '[mentor]', log });
    await sendMentorVisibleEcho('prompt', {
      enabled: false, topicId: 458, roleTag: '[mentor]', bot: { sendToTopic: send }, log,
    });
    expect(send).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).toContain('unconfigured');
    expect(log.mock.calls.flat().join(' ')).toContain('disabled');
  });
});
