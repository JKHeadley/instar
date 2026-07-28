/**
 * Unit tests for sendConsolidatedWithSelfHeal — the self-healing sentinel
 * escalation delivery.
 *
 * Incident 2026-06-09: the lifeline/system topic was deleted on Telegram; every
 * `sendToTopic(lifelineTopicId)` returned `400: message thread not found`, and
 * the old `catch { return false }` swallowed it — 41 stall escalations black-holed
 * in one day. This helper de-swallows the error and self-heals via
 * ensureLifelineTopic() + one retry. Both sides of every boundary below.
 */
import { describe, it, expect, vi } from 'vitest';
import { sendConsolidatedWithSelfHeal } from '../../src/monitoring/sentinelConsolidatedSend.js';

function makeTg(opts: {
  lifelineTopicId?: number | null;
  sendToTopic: (topicId: number, text: string) => Promise<unknown>;
  ensureLifelineTopic?: () => Promise<number | null>;
}) {
  return {
    getLifelineTopicId: () => opts.lifelineTopicId ?? null,
    sendToTopic: vi.fn(opts.sendToTopic),
    ensureLifelineTopic: vi.fn(opts.ensureLifelineTopic ?? (async () => null)),
  };
}

const THREAD_GONE = new Error('Telegram API error (400): Bad Request: message thread not found');

describe('sendConsolidatedWithSelfHeal', () => {
  it('happy path: sends to the configured lifeline topic, never touches ensureLifelineTopic', async () => {
    const tg = makeTg({ lifelineTopicId: 2, sendToTopic: async () => ({ message_id: 1 }) });
    const logs: string[] = [];
    const ok = await sendConsolidatedWithSelfHeal(tg, 'hi', (l) => logs.push(l));
    expect(ok).toBe(true);
    expect(tg.sendToTopic).toHaveBeenCalledWith(2, 'hi');
    expect(tg.ensureLifelineTopic).not.toHaveBeenCalled();
    expect(logs).toHaveLength(0);
  });

  it('THE FIX: dead lifeline topic → self-heals (recreate) and retries on the new id', async () => {
    let calls = 0;
    const tg = makeTg({
      lifelineTopicId: 2,
      sendToTopic: async (id) => {
        calls++;
        if (id === 2) throw THREAD_GONE; // dead topic
        return { message_id: 7 }; // succeeds on the recreated id
      },
      ensureLifelineTopic: async () => 99,
    });
    const logs: string[] = [];
    const ok = await sendConsolidatedWithSelfHeal(tg, 'session X went quiet', (l) => logs.push(l));
    expect(ok).toBe(true);
    expect(tg.ensureLifelineTopic).toHaveBeenCalledOnce();
    expect(tg.sendToTopic).toHaveBeenNthCalledWith(1, 2, 'session X went quiet');
    expect(tg.sendToTopic).toHaveBeenNthCalledWith(2, 99, 'session X went quiet');
    // De-swallow: the original failure was logged, not silently dropped.
    expect(logs.join('\n')).toMatch(/lifeline topic 2 failed.*message thread not found/i);
  });

  it('transient (non-topic-gone) send error → does NOT retry (avoids duplicate), returns false, logs, never recreates', async () => {
    const tg = makeTg({
      lifelineTopicId: 2,
      sendToTopic: async () => { throw new Error('Telegram API error (429): Too Many Requests'); },
      ensureLifelineTopic: async () => 99,
    });
    const logs: string[] = [];
    const ok = await sendConsolidatedWithSelfHeal(tg, 'x', (l) => logs.push(l));
    expect(ok).toBe(false);
    expect(tg.sendToTopic).toHaveBeenCalledOnce(); // exactly one attempt — no double-post
    expect(tg.ensureLifelineTopic).not.toHaveBeenCalled(); // not a dead topic → no recreate
    expect(logs.join('\n')).toMatch(/transient.*not retrying/i);
  });

  it('no lifeline topic configured → establishes one via ensureLifelineTopic, then sends', async () => {
    const tg = makeTg({
      lifelineTopicId: null,
      sendToTopic: async () => ({ message_id: 3 }),
      ensureLifelineTopic: async () => 55,
    });
    const ok = await sendConsolidatedWithSelfHeal(tg, 'x', () => {});
    expect(ok).toBe(true);
    expect(tg.ensureLifelineTopic).toHaveBeenCalledOnce();
    expect(tg.sendToTopic).toHaveBeenCalledWith(55, 'x');
  });

  it('cannot establish a lifeline topic (ensureLifelineTopic returns null) → returns false, logs', async () => {
    const tg = makeTg({ lifelineTopicId: 2, sendToTopic: async () => { throw THREAD_GONE; }, ensureLifelineTopic: async () => null });
    const logs: string[] = [];
    const ok = await sendConsolidatedWithSelfHeal(tg, 'x', (l) => logs.push(l));
    expect(ok).toBe(false);
    expect(logs.join('\n')).toMatch(/could not establish a lifeline topic/i);
  });

  it('ensureLifelineTopic throws → returns false, logs (never throws to caller)', async () => {
    const tg = makeTg({ lifelineTopicId: 2, sendToTopic: async () => { throw THREAD_GONE; }, ensureLifelineTopic: async () => { throw new Error('telegram down'); } });
    const logs: string[] = [];
    const ok = await sendConsolidatedWithSelfHeal(tg, 'x', (l) => logs.push(l));
    expect(ok).toBe(false);
    expect(logs.join('\n')).toMatch(/self-heal \(ensureLifelineTopic\) threw/i);
  });

  it('retry to the healed topic also fails → returns false, logs (no silent swallow)', async () => {
    const tg = makeTg({ lifelineTopicId: 2, sendToTopic: async () => { throw THREAD_GONE; }, ensureLifelineTopic: async () => 99 });
    const logs: string[] = [];
    const ok = await sendConsolidatedWithSelfHeal(tg, 'x', (l) => logs.push(l));
    expect(ok).toBe(false);
    expect(logs.join('\n')).toMatch(/retry to healed lifeline topic 99 failed/i);
  });
});
