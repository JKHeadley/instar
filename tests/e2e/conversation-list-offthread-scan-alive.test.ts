/**
 * Feature-is-alive proof for docs/specs/conversation-list-offthread-scan.md: an AgentServer built
 * through its production constructor with a real TelegramAdapter over a large (~25 MB, 180-topic)
 * Telegram log answers a COLD conversation list, and a cold chat opened before any list, with every
 * topic's real newest message, while the main thread stays responsive: the longest event-loop stall
 * measured in-test stays under one second (the old code read the whole log once per topic).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { startOffthreadScanServer, type OffthreadScanServer } from '../helpers/offthreadScanServer.js';

const TOPICS = 180; // the list answers at most 200 rows a page
const PER_TOPIC = 340;
let s: OffthreadScanServer;
beforeAll(async () => { s = await startOffthreadScanServer({ topics: TOPICS, perTopic: PER_TOPIC, padBytes: 300, label: 'clist-offthread-e2e' }); }, 120_000);
afterAll(async () => { await s.close(); });

/** The longest event-loop stall, in ms, while `work` runs: a 5 ms heartbeat's longest gap, and the
 *  event-loop delay histogram's maximum, whichever is larger. */
async function longestStall<T>(work: () => Promise<T>): Promise<{ result: T; stallMs: number }> {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  let last = performance.now(); let gap = 0;
  const beat = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; }, 5);
  try {
    const result = await work();
    await new Promise((r) => setTimeout(r, 50)); // let the timers record a block that ended the work
    return { result, stallMs: Math.max(gap, h.max / 1e6) };
  } finally { clearInterval(beat); h.disable(); }
}

describe('conversation list off the main thread — production wiring, large log', () => {
  it('the fixture is large enough to have frozen the old code', () => {
    expect(fs.statSync(s.logPath).size).toBeGreaterThan(20 * 1024 * 1024);
  });

  it('a cold list answers every topic with the main thread never stalled for a second', async () => {
    s.coldCache();
    const { result: r, stallMs } = await longestStall(() => s.list());
    expect(r.status).toBe(200);
    const tg = r.body.conversations.filter((c: { platform: string }) => c.platform === 'telegram');
    expect(tg).toHaveLength(TOPICS);
    expect(tg.find((c: { id: number }) => c.id === 7000 + TOPICS)).toMatchObject({ lastPreview: expect.stringContaining(`note ${PER_TOPIC - 1} for ${TOPICS}`) });
    expect(stallMs).toBeLessThan(1_000);
  }, 120_000);

  it('a cold chat opened before any list (a notification tapped after a restart) does not stall the main thread for a second', async () => {
    s.coldCache();
    const { result: r, stallMs } = await longestStall(() => s.chat(7000 + 17));
    expect(r.status).toBe(200);
    expect(r.body.messages).toHaveLength(50);
    expect(r.body.messages[r.body.messages.length - 1].text).toContain(`note ${PER_TOPIC - 1} for 17`);
    expect(stallMs).toBeLessThan(1_000);
  }, 120_000);
});
