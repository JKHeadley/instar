/**
 * Feature-is-alive proof for docs/specs/conversation-list-offthread-scan.md: an AgentServer built
 * through its production constructor with a real TelegramAdapter over a large (~25 MB, 180-topic)
 * Telegram log answers a COLD conversation list, and a cold chat opened before any list, with every
 * topic's real newest message and no synchronous read of the log (the old code read the whole log
 * once per topic, synchronously). The longest event-loop stall during each read is measured in-test
 * and logged as a diagnostic, not asserted: the scan runs off the request's turn in 64 KiB slices on
 * the main thread (there is no worker), and a saturated verifier stalls for reasons of its own, so a
 * stall bound here would fail without a code change. The switch-off path (the old read runs) is
 * asserted by tests/integration/conversation-list-offthread-scan.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { startOffthreadScanServer, type OffthreadScanServer } from '../helpers/offthreadScanServer.js';

const TOPICS = 180; // the list answers at most 200 rows a page
const PER_TOPIC = 340;
let s: OffthreadScanServer;
beforeAll(async () => { s = await startOffthreadScanServer({ topics: TOPICS, perTopic: PER_TOPIC, padBytes: 300, label: 'clist-offthread-e2e' }); }, 120_000);
afterAll(async () => { await s.close(); });
afterEach(() => { vi.restoreAllMocks(); });

/** Synchronous reads of the log file: the old code's path, which the scan must make unnecessary. */
function spySyncReads(): () => number {
  const reads = vi.spyOn(fs, 'readFileSync');
  return () => reads.mock.calls.filter((c) => String(c[0]) === s.logPath).length;
}

/** The longest event-loop stall, in ms, while `work` runs: a 5 ms heartbeat's longest gap, and the
 *  event-loop delay histogram's maximum, whichever is larger. Reported, not asserted (see the header). */
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

const timing = (label: string, ms: number): void => { console.info(`[conversation-list-offthread-scan e2e] ${label}: ${Math.round(ms)} ms (diagnostic, not asserted)`); };

describe('conversation list scanned off the request\'s turn — production wiring, large log', () => {
  it('the fixture is large enough to have frozen the old code', () => {
    expect(fs.statSync(s.logPath).size).toBeGreaterThan(20 * 1024 * 1024);
  });

  it('a cold list answers every topic with no synchronous read of the log', async () => {
    s.coldCache();
    const syncReads = spySyncReads();
    const { result: r, stallMs } = await longestStall(() => s.list());
    timing('cold list, longest event-loop stall', stallMs);
    expect(r.status).toBe(200);
    const tg = r.body.conversations.filter((c: { platform: string }) => c.platform === 'telegram');
    expect(tg).toHaveLength(TOPICS);
    expect(tg.find((c: { id: number }) => c.id === 7000 + TOPICS)).toMatchObject({ lastPreview: expect.stringContaining(`note ${PER_TOPIC - 1} for ${TOPICS}`) });
    expect(syncReads()).toBe(0);
  }, 120_000);

  it('a cold chat opened before any list (a notification tapped after a restart) answers with no synchronous read of the log', async () => {
    s.coldCache();
    const syncReads = spySyncReads();
    const { result: r, stallMs } = await longestStall(() => s.chat(7000 + 17));
    timing('cold chat, longest event-loop stall', stallMs);
    expect(r.status).toBe(200);
    expect(r.body.messages).toHaveLength(50);
    expect(r.body.messages[r.body.messages.length - 1].text).toContain(`note ${PER_TOPIC - 1} for 17`);
    expect(syncReads()).toBe(0);
  }, 120_000);
});
