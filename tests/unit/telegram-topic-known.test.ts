import { describe, it, expect } from 'vitest';
import { telegramTopicKnown } from '../../src/messaging/telegramTopicKnown.js';

describe('telegramTopicKnown', () => {
  const tg = (mapped: number[], history: Record<number, unknown[]> = {}, throws = false) => ({
    getAllTopicMappings: () => mapped.map((topicId) => ({ topicId })),
    getTopicHistory: (topicId: number) => { if (throws) throw new Error('log unreadable'); return history[topicId] ?? []; },
  });

  it('knows a named or session-bound topic', () => {
    expect(telegramTopicKnown(tg([42]), 42)).toBe(true);
  });

  it('knows a topic with history on this machine though it was named elsewhere', () => {
    expect(telegramTopicKnown(tg([42], { 534: [{ messageId: 1 }] }), 534)).toBe(true);
  });

  it('does not know a topic with no name, session or history', () => {
    expect(telegramTopicKnown(tg([42], { 534: [{ messageId: 1 }] }), 9999)).toBe(false);
  });

  it('refuses non-topic numbers', () => {
    expect(telegramTopicKnown(tg([0]), 0)).toBe(false);
    expect(telegramTopicKnown(tg([]), -5)).toBe(false);
    expect(telegramTopicKnown(tg([]), 1.5)).toBe(false);
  });

  it('falls back to names and sessions when the log cannot be read', () => {
    expect(telegramTopicKnown(tg([42], {}, true), 534)).toBe(false);
    expect(telegramTopicKnown(tg([42], {}, true), 42)).toBe(true);
  });

  it('works with a source that has no history reader', () => {
    expect(telegramTopicKnown({ getAllTopicMappings: () => [{ topicId: 7 }] }, 7)).toBe(true);
    expect(telegramTopicKnown({ getAllTopicMappings: () => [] }, 8)).toBe(false);
  });
});
