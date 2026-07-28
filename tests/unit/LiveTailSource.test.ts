/**
 * Tier-1 tests for LiveTailSource — the holder-side delta flush producer (§8 G3b).
 * Covers: first flush sends full content, subsequent flushes send only the new
 * suffix, no-new-content is a no-op (no seq inflation), divergence resends full,
 * a failed broadcast does NOT advance state (retry-safe), and — the key
 * correctness proof — deltas fed into a real LiveTailBuffer reconstruct the
 * original conversation exactly (source delta model == buffer append model).
 *
 * Also covers the 2026-06-05 event-loop guards: the version gate (unchanged
 * topics skip content serialization entirely), the failure backoff (a rejecting
 * peer is never hammered at tick rate), the content cap, and the handoff force
 * path that bypasses gate + backoff.
 */

import { describe, it, expect, vi } from 'vitest';
import { LiveTailSource } from '../../src/core/LiveTailSource.js';
import { LiveTailBuffer } from '../../src/core/LiveTailBuffer.js';

function makeSource(content: { [topic: string]: string }, broadcast: any) {
  return new LiveTailSource({
    getTopicContent: (t) => content[t] ?? '',
    activeTopics: () => Object.keys(content),
    transport: { broadcast },
  });
}

describe('LiveTailSource', () => {
  it('first flush sends the full content as seq 1; second sends only the new suffix', async () => {
    const content: Record<string, string> = { t: 'hello' };
    const sent: any[] = [];
    const src = makeSource(content, async (f: any) => { sent.push(f); return true; });

    expect((await src.flushTopic('t')).flushed).toBe(true);
    expect(sent[0]).toEqual({ topic: 't', seq: 1, content: 'hello' });

    content.t = 'hello world';
    expect((await src.flushTopic('t')).flushed).toBe(true);
    expect(sent[1]).toEqual({ topic: 't', seq: 2, content: ' world' });
  });

  it('no new content → no flush, no sequence bump', async () => {
    const broadcast = vi.fn(async () => true);
    const src = makeSource({ t: 'stable' }, broadcast);
    expect((await src.flushTopic('t')).flushed).toBe(true);
    const r = await src.flushTopic('t');
    expect(r.flushed).toBe(false);
    expect(r.seq).toBe(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('content divergence (rewrite) resends the full content', async () => {
    const content: Record<string, string> = { t: 'original text' };
    const sent: any[] = [];
    const src = makeSource(content, async (f: any) => { sent.push(f); return true; });
    await src.flushTopic('t');
    content.t = 'totally different'; // does not start with prior prefix
    await src.flushTopic('t');
    expect(sent[1].content).toBe('totally different');
    expect(sent[1].seq).toBe(2);
  });

  it('a failed broadcast does NOT advance state — the same delta retries after the backoff window', async () => {
    const content: Record<string, string> = { t: 'data' };
    let ok = false;
    const sent: any[] = [];
    let nowMs = 0;
    const src = new LiveTailSource({
      getTopicContent: (t) => content[t],
      activeTopics: () => Object.keys(content),
      transport: { broadcast: async (f: any) => { sent.push(f); return ok; } },
      failureBackoffBaseMs: 1_000,
      now: () => nowMs,
    });

    const r1 = await src.flushTopic('t');
    expect(r1.flushed).toBe(false);
    expect(src.currentSeq('t')).toBe(0); // not advanced

    ok = true;
    nowMs = 1_001; // past the failure-backoff window
    const r2 = await src.flushTopic('t');
    expect(r2.flushed).toBe(true);
    expect(r2.seq).toBe(1);
    // Both attempts carried the same content + seq (retry-safe; buffer dedups on seq).
    expect(sent[0]).toEqual({ topic: 't', seq: 1, content: 'data' });
    expect(sent[1]).toEqual({ topic: 't', seq: 1, content: 'data' });
  });

  it('CORRECTNESS: source deltas reconstruct the original tail through a real LiveTailBuffer', async () => {
    const content: Record<string, string> = { '13481': '' };
    const buffer = new LiveTailBuffer({ outOfOrderTimeoutMs: 60_000, maxBytesPerTopic: 256 * 1024 });
    // The transport delivers each delta straight into the standby buffer.
    const src = makeSource(content, async (f: any) => {
      buffer.applyFlush({ topic: f.topic, seq: f.seq, content: f.content });
      return true;
    });

    content['13481'] = 'user: hi\n';
    await src.flushTopic('13481');
    content['13481'] = 'user: hi\nagent: hello\n';
    await src.flushTopic('13481');
    content['13481'] = 'user: hi\nagent: hello\nuser: thanks\n';
    await src.flushTopic('13481');

    expect(buffer.getTail('13481').content).toBe(content['13481']);
    expect(buffer.getLastAppliedSeq('13481')).toBe(3);
  });

  it('flushAll covers every active topic', async () => {
    const sent: any[] = [];
    const src = makeSource({ a: 'A', b: 'B' }, async (f: any) => { sent.push(f); return true; });
    const outcomes = await src.flushAll();
    expect(outcomes.filter((o) => o.flushed)).toHaveLength(2);
    expect(sent.map((s) => s.topic).sort()).toEqual(['a', 'b']);
  });

  describe('version gate (event-loop guard 1)', () => {
    it('an unchanged version skips the topic WITHOUT building its content', async () => {
      const versions: Record<string, number> = { t: 1 };
      const getTopicContent = vi.fn(() => 'hello');
      const broadcast = vi.fn(async () => true);
      const src = new LiveTailSource({
        getTopicContent,
        activeTopics: () => ['t'],
        transport: { broadcast },
        getTopicVersion: (t) => versions[t],
      });

      // First flush: no version recorded yet → proceeds and sends.
      expect((await src.flushTopic('t')).flushed).toBe(true);
      expect(getTopicContent).toHaveBeenCalledTimes(1);

      // Unchanged version → skipped with ZERO content work (the core guard).
      expect((await src.flushTopic('t')).flushed).toBe(false);
      expect((await src.flushTopic('t')).flushed).toBe(false);
      expect(getTopicContent).toHaveBeenCalledTimes(1);
      expect(broadcast).toHaveBeenCalledTimes(1);
    });

    it('a version bump re-opens the topic and flushes the new delta', async () => {
      const versions: Record<string, number> = { t: 1 };
      const content: Record<string, string> = { t: 'hello' };
      const sent: any[] = [];
      const src = new LiveTailSource({
        getTopicContent: (t) => content[t],
        activeTopics: () => ['t'],
        transport: { broadcast: async (f) => { sent.push(f); return true; } },
        getTopicVersion: (t) => versions[t],
      });

      await src.flushTopic('t');
      content.t = 'hello world';
      versions.t = 2;
      expect((await src.flushTopic('t')).flushed).toBe(true);
      expect(sent[1]).toEqual({ topic: 't', seq: 2, content: ' world' });
    });

    it('an unchanged-content flush records the version so later ticks skip cheaply', async () => {
      // Version bumps but content is byte-identical (e.g. a non-content event
      // bumped the counter): the no-op must record the version, or every later
      // tick would rebuild the content to rediscover "nothing changed".
      const versions: Record<string, number> = { t: 1 };
      const getTopicContent = vi.fn(() => 'same');
      const src = new LiveTailSource({
        getTopicContent,
        activeTopics: () => ['t'],
        transport: { broadcast: async () => true },
        getTopicVersion: (t) => versions[t],
      });
      await src.flushTopic('t'); // sends 'same', records v1
      versions.t = 2;
      expect((await src.flushTopic('t')).flushed).toBe(false); // builds, finds identical, records v2
      expect((await src.flushTopic('t')).flushed).toBe(false); // now gated — no rebuild
      expect(getTopicContent).toHaveBeenCalledTimes(2);
    });

    it('a pending retry overrides the gate — a failed send retries despite an unchanged version', async () => {
      const versions: Record<string, number> = { t: 1 };
      let ok = false;
      const sent: any[] = [];
      let nowMs = 0;
      const src = new LiveTailSource({
        getTopicContent: () => 'data',
        activeTopics: () => ['t'],
        transport: { broadcast: async (f) => { sent.push(f); return ok; } },
        getTopicVersion: (t) => versions[t],
        failureBackoffBaseMs: 1_000,
        now: () => nowMs,
      });

      expect((await src.flushTopic('t')).flushed).toBe(false); // fails — version unchanged hereafter
      ok = true;
      nowMs = 1_001; // past the backoff window
      expect((await src.flushTopic('t')).flushed).toBe(true); // retried despite unchanged version
      expect(sent).toHaveLength(2);
    });
  });

  describe('failure backoff (event-loop guard 2)', () => {
    it('a failing topic is NOT retried every tick — attempts back off exponentially', async () => {
      const broadcast = vi.fn(async () => false);
      let nowMs = 0;
      const src = new LiveTailSource({
        getTopicContent: () => 'data',
        activeTopics: () => ['t'],
        transport: { broadcast },
        failureBackoffBaseMs: 1_000,
        now: () => nowMs,
      });

      await src.flushTopic('t'); // failure #1 → next attempt at 1s
      expect(broadcast).toHaveBeenCalledTimes(1);

      nowMs = 500; // inside the window — tick does nothing
      await src.flushTopic('t');
      expect(broadcast).toHaveBeenCalledTimes(1);

      nowMs = 1_001; // window open → failure #2 → next attempt 2s later (3s)
      await src.flushTopic('t');
      expect(broadcast).toHaveBeenCalledTimes(2);

      nowMs = 2_500; // inside the doubled window
      await src.flushTopic('t');
      expect(broadcast).toHaveBeenCalledTimes(2);

      nowMs = 3_100; // doubled window open
      await src.flushTopic('t');
      expect(broadcast).toHaveBeenCalledTimes(3);
    });

    it('the backoff is capped at failureBackoffMaxMs', async () => {
      const broadcast = vi.fn(async () => false);
      let nowMs = 0;
      const src = new LiveTailSource({
        getTopicContent: () => 'data',
        activeTopics: () => ['t'],
        transport: { broadcast },
        failureBackoffBaseMs: 1_000,
        failureBackoffMaxMs: 2_000,
        now: () => nowMs,
      });
      // failures at 0s (next 1s), 1s (next +2s=3s), 3s (next +2s capped=5s)…
      await src.flushTopic('t');
      nowMs = 1_000; await src.flushTopic('t');
      nowMs = 3_000; await src.flushTopic('t');
      expect(broadcast).toHaveBeenCalledTimes(3);
      nowMs = 4_900; // would be inside an uncapped 4s window anyway; capped window ends at 5s
      await src.flushTopic('t');
      expect(broadcast).toHaveBeenCalledTimes(3);
      nowMs = 5_001; // capped window open
      await src.flushTopic('t');
      expect(broadcast).toHaveBeenCalledTimes(4);
    });

    it('a success clears the backoff — the next new content flushes immediately', async () => {
      const content: Record<string, string> = { t: 'a' };
      let ok = false;
      const broadcast = vi.fn(async () => ok);
      let nowMs = 0;
      const src = new LiveTailSource({
        getTopicContent: () => content.t,
        activeTopics: () => ['t'],
        transport: { broadcast },
        failureBackoffBaseMs: 1_000,
        now: () => nowMs,
      });
      await src.flushTopic('t'); // fail
      ok = true;
      nowMs = 1_001;
      expect((await src.flushTopic('t')).flushed).toBe(true); // recovers
      content.t = 'ab';
      nowMs = 1_002; // immediately after — no residual backoff
      expect((await src.flushTopic('t')).flushed).toBe(true);
      expect(broadcast).toHaveBeenCalledTimes(3);
    });
  });

  describe('content cap (event-loop guard 3)', () => {
    it('an oversized delta sends only the freshest suffix and still advances state', async () => {
      const big = 'x'.repeat(100) + 'FRESHEST';
      const content: Record<string, string> = { t: big };
      const sent: any[] = [];
      const src = new LiveTailSource({
        getTopicContent: () => content.t,
        activeTopics: () => ['t'],
        transport: { broadcast: async (f) => { sent.push(f); return true; } },
        maxFlushBytes: 32,
      });
      expect((await src.flushTopic('t')).flushed).toBe(true);
      expect(sent[0].content).toBe(big.slice(-32));
      expect(sent[0].content.endsWith('FRESHEST')).toBe(true);
      // State advanced to the FULL content — the next tick is a clean no-op.
      expect((await src.flushTopic('t')).flushed).toBe(false);
    });
  });

  describe('force (the handoff path)', () => {
    it('force bypasses the backoff window and the version gate', async () => {
      const versions: Record<string, number> = { t: 1 };
      let ok = false;
      const broadcast = vi.fn(async () => ok);
      let nowMs = 0;
      const src = new LiveTailSource({
        getTopicContent: () => 'data',
        activeTopics: () => ['t'],
        transport: { broadcast },
        getTopicVersion: (t) => versions[t],
        failureBackoffBaseMs: 60_000,
        now: () => nowMs,
      });
      await src.flushTopic('t'); // fail → 60s backoff
      ok = true;
      nowMs = 1_000; // deep inside the window — cadence tick would skip
      expect((await src.flushTopic('t')).flushed).toBe(false);
      expect(broadcast).toHaveBeenCalledTimes(1);
      // The handoff must attempt NOW regardless.
      expect((await src.flushTopic('t', { force: true })).flushed).toBe(true);
      expect(broadcast).toHaveBeenCalledTimes(2);
    });

    it('force still sends nothing when content is genuinely unchanged', async () => {
      const broadcast = vi.fn(async () => true);
      const src = makeSource({ t: 'stable' }, broadcast);
      await src.flushTopic('t');
      expect((await src.flushTopic('t', { force: true })).flushed).toBe(false);
      expect(broadcast).toHaveBeenCalledTimes(1);
    });
  });
});

describe('stale-standby signal (Eternal Sentinel condition 4 / P19)', () => {
  function makeFailing(staleSignalAfterMs: number) {
    let nowMs = 0;
    let ok = false;
    const signals: any[] = [];
    const content: Record<string, string> = { t: 'data' };
    const src = new LiveTailSource({
      getTopicContent: (t) => content[t],
      activeTopics: () => Object.keys(content),
      transport: { broadcast: async () => ok },
      failureBackoffBaseMs: 1_000,
      failureBackoffMaxMs: 1_000, // fixed window so attempts land predictably
      staleSignalAfterMs,
      reportStaleStandby: (info) => signals.push(info),
      now: () => nowMs,
    });
    return { src, signals, content, setNow: (t: number) => { nowMs = t; }, setOk: (v: boolean) => { ok = v; } };
  }

  it('SUSTAINED-FAILURE BOUND: a never-recovering topic signals exactly ONCE across unlimited attempts', async () => {
    const { src, signals, setNow } = makeFailing(10_000);
    for (let t = 0; t <= 100_000; t += 1_001) { // ~100 attempt windows
      setNow(t);
      await src.flushTopic('t');
    }
    expect(signals).toHaveLength(1);
    expect(signals[0].topic).toBe('t');
    expect(signals[0].failingForMs).toBeGreaterThanOrEqual(10_000);
    expect(signals[0].consecutiveFailures).toBeGreaterThan(1);
  });

  it('does not signal before the threshold', async () => {
    const { src, signals, setNow } = makeFailing(60_000);
    for (let t = 0; t <= 30_000; t += 1_001) {
      setNow(t);
      await src.flushTopic('t');
    }
    expect(signals).toHaveLength(0);
  });

  it('recovery clears the episode; a NEW failure episode signals again', async () => {
    const { src, signals, content, setNow, setOk } = makeFailing(5_000);
    // Episode 1: fail past the threshold.
    for (let t = 0; t <= 7_000; t += 1_001) { setNow(t); await src.flushTopic('t'); }
    expect(signals).toHaveLength(1);
    // Recover.
    setOk(true);
    setNow(10_000);
    expect((await src.flushTopic('t')).flushed).toBe(true);
    // Episode 2: new content, fail past the threshold again.
    setOk(false);
    content.t = 'data more';
    for (let t = 11_000; t <= 18_000; t += 1_001) { setNow(t); await src.flushTopic('t'); }
    expect(signals).toHaveLength(2);
  });

  it('omitted reporter dep → no crash, behavior unchanged (signal is optional)', async () => {
    let nowMs = 0;
    const src = new LiveTailSource({
      getTopicContent: () => 'data',
      activeTopics: () => ['t'],
      transport: { broadcast: async () => false },
      failureBackoffBaseMs: 1_000,
      failureBackoffMaxMs: 1_000,
      staleSignalAfterMs: 2_000,
      now: () => nowMs,
    });
    for (let t = 0; t <= 5_000; t += 1_001) { nowMs = t; await src.flushTopic('t'); }
    expect(src.currentSeq('t')).toBe(0); // still correctly un-advanced
  });
});

describe('server-boot wiring: stale-standby signal (source-shape pin)', () => {
  it('server.ts wires reportStaleStandby to DegradationReporter inside the LiveTailSource construction', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');
    const idx = src.indexOf('new LiveTailSource({');
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 2500);
    expect(block).toContain('reportStaleStandby: ({ topic, failingForMs, consecutiveFailures })');
    expect(block).toContain("feature: 'LiveTail.standbyFreshness'");
  });
});
