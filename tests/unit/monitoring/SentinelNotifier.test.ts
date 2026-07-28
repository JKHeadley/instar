// safe-git-allow: test file — no git calls.
// safe-fs-allow: test file — no fs mutations.

/**
 * Unit tests for SentinelNotifier — the delivery policy introduced to fix the
 * 2026-05-22 topic-spam flood. Asserts both sides of every decision boundary:
 *
 *   - record() is always log-only — never reaches Telegram.
 *   - escalate() is always logged. When telegramEscalation is OFF (default),
 *     it stays log-only ('escalation-suppressed'); the user sees nothing.
 *   - When ON, escalations within the coalesce window flush as ONE consolidated
 *     message to ONE reused system topic. Never one-message-per-session.
 *   - When a single session escalates, the message preserves its original text;
 *     when multiple coalesce, composeMessage produces a single CTA-bearing
 *     listing.
 *   - Send failures land in the audit trail as 'notify-error' (not silent).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SentinelNotifier, type SentinelLogEntry } from '../../../src/monitoring/SentinelNotifier.js';

function makeLog(): { log: (e: SentinelLogEntry) => void; entries: SentinelLogEntry[] } {
  const entries: SentinelLogEntry[] = [];
  return { log: (e) => entries.push(e), entries };
}

describe('SentinelNotifier — record() is always log-only', () => {
  it('writes a structured entry to the audit log on every routine transition', () => {
    const sink = makeLog();
    const n = new SentinelNotifier({ log: sink.log });
    n.record('detected', 'silence', 'agent-1', 'idleMs=900000');
    n.record('nudged', 'silence', 'agent-1');
    n.record('recovered', 'silence', 'agent-1');
    expect(sink.entries.map(e => e.kind)).toEqual(['detected', 'nudged', 'recovered']);
    expect(sink.entries[0].sentinel).toBe('silence');
    expect(sink.entries[0].sessionName).toBe('agent-1');
    expect(sink.entries[0].detail).toBe('idleMs=900000');
  });

  it('never invokes sendConsolidated, even with escalation enabled', async () => {
    const sink = makeLog();
    const sent: string[] = [];
    const n = new SentinelNotifier(
      { log: sink.log, sendConsolidated: async (t) => { sent.push(t); return true; } },
      { telegramEscalation: true, coalesceWindowMs: 1 },
    );
    n.record('detected', 'silence', 'agent-1');
    await n.flushNow();
    expect(sent).toEqual([]);
  });
});

describe('SentinelNotifier — escalate() with telegramEscalation OFF (default)', () => {
  it('records the escalation and logs that it was suppressed, sending nothing', async () => {
    const sink = makeLog();
    const sent: string[] = [];
    const n = new SentinelNotifier({
      log: sink.log,
      sendConsolidated: async (t) => { sent.push(t); return true; },
    });
    expect(n.telegramEnabled).toBe(false);
    n.escalate('silence', 'agent-1', 'something went quiet');
    await n.flushNow();
    expect(sink.entries.map(e => e.kind)).toEqual(['escalated', 'escalation-suppressed']);
    expect(sent).toEqual([]);
  });

  it('stays log-only even when sendConsolidated is absent and the flag is on (no callback wired)', async () => {
    const sink = makeLog();
    const n = new SentinelNotifier({ log: sink.log }, { telegramEscalation: true });
    expect(n.telegramEnabled).toBe(false); // flag on, but no callback → still disabled
    n.escalate('silence', 'agent-1', 'something went quiet');
    await n.flushNow();
    expect(sink.entries.map(e => e.kind)).toEqual(['escalated', 'escalation-suppressed']);
  });
});

describe('SentinelNotifier — escalate() with telegramEscalation ON, coalescing', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a single escalation sends the original message verbatim', async () => {
    const sink = makeLog();
    const sent: string[] = [];
    const n = new SentinelNotifier(
      { log: sink.log, sendConsolidated: async (t) => { sent.push(t); return true; } },
      { telegramEscalation: true, coalesceWindowMs: 100 },
    );
    n.escalate('silence', 'agent-1', 'agent-1 was working and went quiet. Want me to dig in?');
    await vi.advanceTimersByTimeAsync(150);
    expect(sent).toEqual(['agent-1 was working and went quiet. Want me to dig in?']);
  });

  it('three escalations within the coalesce window flush as ONE consolidated message (never three messages)', async () => {
    const sink = makeLog();
    const sent: string[] = [];
    const n = new SentinelNotifier(
      { log: sink.log, sendConsolidated: async (t) => { sent.push(t); return true; } },
      { telegramEscalation: true, coalesceWindowMs: 100 },
    );
    n.escalate('silence', 'agent-1', 'one quiet');
    await vi.advanceTimersByTimeAsync(30);
    n.escalate('silence', 'agent-2', 'two quiet');
    await vi.advanceTimersByTimeAsync(30);
    n.escalate('socket-disconnect', 'agent-3', 'three quiet');
    await vi.advanceTimersByTimeAsync(100);
    // ONE send, listing all three.
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatch(/3 background sessions/);
    expect(sent[0]).toMatch(/agent-1/);
    expect(sent[0]).toMatch(/agent-2/);
    expect(sent[0]).toMatch(/agent-3/);
    expect(sent[0]).toMatch(/dig into them/i); // CTA
  });

  it('deduplicates by sessionName — a session that re-escalates within the window only contributes ONE pending entry', async () => {
    const sink = makeLog();
    const sent: string[] = [];
    const n = new SentinelNotifier(
      { log: sink.log, sendConsolidated: async (t) => { sent.push(t); return true; } },
      { telegramEscalation: true, coalesceWindowMs: 100 },
    );
    n.escalate('silence', 'agent-1', 'first');
    n.escalate('silence', 'agent-1', 'second');
    n.escalate('silence', 'agent-2', 'another');
    await vi.advanceTimersByTimeAsync(150);
    expect(sent.length).toBe(1);
    // Multi-session listing: each session listed exactly once (no duplicate agent-1).
    expect(sent[0]).toMatch(/2 background sessions/);
    expect((sent[0].match(/agent-1/g) || []).length).toBe(1);
    expect((sent[0].match(/agent-2/g) || []).length).toBe(1);
  });

  it('records escalation-sent on success and notify-error on failure', async () => {
    const sink = makeLog();
    let returnValue = true;
    const n = new SentinelNotifier(
      { log: sink.log, sendConsolidated: async () => returnValue },
      { telegramEscalation: true, coalesceWindowMs: 50 },
    );
    n.escalate('silence', 'agent-1', 'one');
    await vi.advanceTimersByTimeAsync(80);
    expect(sink.entries.some(e => e.kind === 'escalation-sent')).toBe(true);

    sink.entries.length = 0;
    returnValue = false;
    n.escalate('silence', 'agent-2', 'two');
    await vi.advanceTimersByTimeAsync(80);
    expect(sink.entries.some(e => e.kind === 'notify-error')).toBe(true);
  });

  it('flushNow forces an immediate flush without waiting for the debounce', async () => {
    const sink = makeLog();
    const sent: string[] = [];
    const n = new SentinelNotifier(
      { log: sink.log, sendConsolidated: async (t) => { sent.push(t); return true; } },
      { telegramEscalation: true, coalesceWindowMs: 60_000 },
    );
    n.escalate('silence', 'agent-1', 'go');
    await n.flushNow();
    expect(sent.length).toBe(1);
  });

  it('stop() cancels any pending flush — nothing leaks after shutdown', async () => {
    const sink = makeLog();
    const sent: string[] = [];
    const n = new SentinelNotifier(
      { log: sink.log, sendConsolidated: async (t) => { sent.push(t); return true; } },
      { telegramEscalation: true, coalesceWindowMs: 100 },
    );
    n.escalate('silence', 'agent-1', 'go');
    n.stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(sent.length).toBe(0);
  });
});

describe('SentinelNotifier — robustness', () => {
  it('a throwing log sink never crashes the monitoring path', () => {
    const n = new SentinelNotifier({ log: () => { throw new Error('disk full'); } });
    expect(() => n.record('detected', 'silence', 'agent-1')).not.toThrow();
    expect(() => n.escalate('silence', 'agent-1', 'x')).not.toThrow();
  });
});
