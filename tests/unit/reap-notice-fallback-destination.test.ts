/**
 * A notice about interrupted work must not be dropped for want of a Telegram
 * topic.
 *
 * `lifelineTopic` is Telegram-shaped. On an agent that talks on Slack it is
 * always null, so the unbound-session and cross-topic notices — the ones whose
 * entire job is to say "your work was interrupted" — were recorded as
 * `no-topic` and discarded. The indra agent's own records show that outcome
 * repeating with the detail "lifeline topic not configured": the layer existed,
 * ran, and spoke into a channel that did not exist.
 *
 * These tests pin all three branches: a lifeline topic is used as before, its
 * absence falls back to the gateway that knows the agent's real platforms, and
 * the total absence of any destination is reported rather than swallowed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReapNotifier } from '../../src/monitoring/ReapNotifier.js';
import type { Session } from '../../src/core/types.js';

function sess(name: string): Pick<Session, 'name' | 'tmuxSession'> {
  return { name, tmuxSession: name };
}

function makeNotifier(opts: { lifeline: number | null; fallbackDelivers?: boolean | 'throws' }) {
  const sends: Array<{ topicId: number; text: string }> = [];
  const fallbacks: string[] = [];
  const records: Array<{ topicId: number | null; outcome: string; detail?: string }> = [];
  const gaps: string[] = [];
  const n = new ReapNotifier(
    {
      // Unbound sessions: no topic resolves, so the notice is lifeline-bound —
      // exactly the class that was being dropped.
      resolveTopic: () => null,
      lifelineTopic: () => opts.lifeline,
      send: (topicId, text) => { sends.push({ topicId, text }); },
      recordNotify: (e) => { records.push({ topicId: e.topicId, outcome: e.outcome, detail: e.detail }); },
      ...(opts.fallbackDelivers === undefined ? {} : {
        fallbackNotify: (text: string) => {
          if (opts.fallbackDelivers === 'throws') throw new Error('gateway exploded');
          fallbacks.push(text);
          return opts.fallbackDelivers === true;
        },
      }),
      raiseNoDestination: (detail: string) => { gaps.push(detail); },
    },
    { enabled: true, coalesceWindowMs: 60_000, maxBuffer: 100, perTopic: true, drainEnabled: false },
  );
  return { n, sends, fallbacks, records, gaps };
}

describe('reap notices reach a destination on any platform', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('uses the lifeline topic when there is one (unchanged)', async () => {
    const { n, sends, fallbacks, gaps } = makeNotifier({ lifeline: 999, fallbackDelivers: true });
    n.onReaped({ session: sess('s1'), reason: 'resource-pressure', disposition: 'terminal', origin: 'autonomous' });
    await n.flush();
    expect(sends.some(s => s.topicId === 999)).toBe(true);
    expect(fallbacks).toHaveLength(0);
    expect(gaps).toHaveLength(0);
  });

  it('with no lifeline topic, falls back to the gateway and records it as SENT', async () => {
    const { n, fallbacks, records, gaps } = makeNotifier({ lifeline: null, fallbackDelivers: true });
    n.onReaped({ session: sess('s1'), reason: 'resource-pressure', disposition: 'terminal', origin: 'autonomous' });
    await n.flush();
    expect(fallbacks).toHaveLength(1);
    const rec = records.find(r => r.topicId === null);
    expect(rec?.outcome).toBe('sent');
    expect(rec?.detail).toContain('notification gateway');
    expect(gaps).toHaveLength(0);
  });

  it('with no destination at all, records no-topic AND reports the gap once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { n, records, gaps } = makeNotifier({ lifeline: null, fallbackDelivers: false });
    n.onReaped({ session: sess('s1'), reason: 'resource-pressure', disposition: 'terminal', origin: 'autonomous' });
    await n.flush();
    const rec = records.find(r => r.topicId === null);
    expect(rec?.outcome).toBe('no-topic');
    expect(rec?.detail).toContain('no fallback destination');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('nowhere to go');
    // Loud in the log too: on an agent with no Telegram adapter the attention
    // item cannot be raised either, so the log is the last trace.
    expect(warn).toHaveBeenCalled();
  });

  it('a throwing gateway still records the notice and reports the gap', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { n, records, gaps } = makeNotifier({ lifeline: null, fallbackDelivers: 'throws' });
    n.onReaped({ session: sess('s1'), reason: 'resource-pressure', disposition: 'terminal', origin: 'autonomous' });
    await expect(n.flush()).resolves.not.toThrow();
    expect(records.find(r => r.topicId === null)?.outcome).toBe('no-topic');
    expect(gaps).toHaveLength(1);
  });

  it('an install with no fallback wired behaves exactly as before', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { n, records } = makeNotifier({ lifeline: null });
    n.onReaped({ session: sess('s1'), reason: 'resource-pressure', disposition: 'terminal', origin: 'autonomous' });
    await n.flush();
    expect(records.find(r => r.topicId === null)?.outcome).toBe('no-topic');
  });
});
