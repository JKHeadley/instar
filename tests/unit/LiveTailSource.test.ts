/**
 * Tier-1 tests for LiveTailSource — the holder-side delta flush producer (§8 G3b).
 * Covers: first flush sends full content, subsequent flushes send only the new
 * suffix, no-new-content is a no-op (no seq inflation), divergence resends full,
 * a failed broadcast does NOT advance state (retry-safe), and — the key
 * correctness proof — deltas fed into a real LiveTailBuffer reconstruct the
 * original conversation exactly (source delta model == buffer append model).
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

  it('a failed broadcast does NOT advance state — the same delta retries next tick', async () => {
    const content: Record<string, string> = { t: 'data' };
    let ok = false;
    const sent: any[] = [];
    const src = makeSource(content, async (f: any) => { sent.push(f); return ok; });

    const r1 = await src.flushTopic('t');
    expect(r1.flushed).toBe(false);
    expect(src.currentSeq('t')).toBe(0); // not advanced

    ok = true;
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
});
