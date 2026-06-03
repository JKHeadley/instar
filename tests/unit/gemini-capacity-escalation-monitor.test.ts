import { describe, it, expect, vi } from 'vitest';
import { GeminiCapacityEscalationMonitor } from '../../src/monitoring/GeminiCapacityEscalationMonitor.js';
import type { GeminiCapacityGate } from '../../src/providers/adapters/gemini-cli/observability/geminiCapacityPolicy.js';

const NOW = 1_000_000;

function gate(partial: Partial<GeminiCapacityGate>): GeminiCapacityGate {
  return { allow: true, retryAfterMs: 0, deferredUntil: null, reason: null, ...partial };
}

function make(opts: {
  enabled?: boolean;
  escalateAfterMinutes?: number;
  gate: GeminiCapacityGate;
  raise?: ReturnType<typeof vi.fn>;
}) {
  return new GeminiCapacityEscalationMonitor({
    config: { enabled: opts.enabled ?? true, escalateAfterMinutes: opts.escalateAfterMinutes ?? 60 },
    now: () => NOW,
    gateReader: () => opts.gate,
    raiseAttention: opts.raise ?? vi.fn(),
  });
}

describe('GeminiCapacityEscalationMonitor', () => {
  it('disabled → no-op, never escalates', async () => {
    const raise = vi.fn();
    const m = new GeminiCapacityEscalationMonitor({
      config: { enabled: false },
      now: () => NOW,
      gateReader: () => gate({ allow: false, retryAfterMs: 13 * 3600_000, deferredUntil: NOW + 13 * 3600_000 }),
      raiseAttention: raise,
    });
    const r = await m.tick();
    expect(r.enabled).toBe(false);
    expect(raise).not.toHaveBeenCalled();
  });

  it('not blocked (gate allows) → no escalation', async () => {
    const raise = vi.fn();
    const m = make({ gate: gate({ allow: true }), raise });
    const r = await m.tick();
    expect(r.blocked).toBe(false);
    expect(r.escalated).toBe(false);
    expect(raise).not.toHaveBeenCalled();
  });

  it('blocked but SHORT (remaining < threshold) → no escalation', async () => {
    const raise = vi.fn();
    // 10 min remaining, threshold 60 min.
    const m = make({ gate: gate({ allow: false, retryAfterMs: 10 * 60_000, deferredUntil: NOW + 10 * 60_000 }), raise });
    const r = await m.tick();
    expect(r.blocked).toBe(true);
    expect(r.escalated).toBe(false);
    expect(raise).not.toHaveBeenCalled();
  });

  it('blocked + LONG (remaining >= threshold) → escalates once with HIGH for multi-hour', async () => {
    const raise = vi.fn();
    const m = make({ gate: gate({ allow: false, retryAfterMs: 13 * 3600_000, deferredUntil: NOW + 13 * 3600_000, reason: 'gemini capacity exhausted' }), raise });
    const r = await m.tick();
    expect(r.escalated).toBe(true);
    expect(raise).toHaveBeenCalledTimes(1);
    const item = raise.mock.calls[0][0];
    expect(item.sourceContext).toBe('gemini-capacity-escalation');
    expect(item.priority).toBe('HIGH'); // ~13h >= 120min
    expect(item.summary).toContain('13h');
    expect(item.id).toContain(String(NOW + 13 * 3600_000));
  });

  it('escalation between 1h and 2h is NORMAL priority', async () => {
    const raise = vi.fn();
    const m = make({ gate: gate({ allow: false, retryAfterMs: 90 * 60_000, deferredUntil: NOW + 90 * 60_000 }), raise });
    await m.tick();
    expect(raise.mock.calls[0][0].priority).toBe('NORMAL'); // 90min < 120min
  });

  it('dedups across ticks within the same deferral episode (escalates ONCE)', async () => {
    const raise = vi.fn();
    const g = gate({ allow: false, retryAfterMs: 5 * 3600_000, deferredUntil: NOW + 5 * 3600_000 });
    const m = make({ gate: g, raise });
    await m.tick();
    await m.tick();
    await m.tick();
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it('re-arms after the block clears, escalates again on a NEW episode', async () => {
    const raise = vi.fn();
    let current = gate({ allow: false, retryAfterMs: 4 * 3600_000, deferredUntil: NOW + 4 * 3600_000 });
    const m = new GeminiCapacityEscalationMonitor({
      config: { enabled: true, escalateAfterMinutes: 60 },
      now: () => NOW,
      gateReader: () => current,
      raiseAttention: raise,
    });
    await m.tick();                                   // episode A → escalate
    current = gate({ allow: true });                  // cleared
    await m.tick();                                   // re-arm
    current = gate({ allow: false, retryAfterMs: 4 * 3600_000, deferredUntil: NOW + 99 * 3600_000 }); // NEW episode
    await m.tick();                                   // episode B → escalate again
    expect(raise).toHaveBeenCalledTimes(2);
  });

  it('status() reports the live block + remaining without escalating', () => {
    const raise = vi.fn();
    const m = make({ gate: gate({ allow: false, retryAfterMs: 7 * 3600_000, deferredUntil: NOW + 7 * 3600_000, reason: 'r' }), raise });
    const s = m.status();
    expect(s.blocked).toBe(true);
    expect(s.remainingMs).toBe(7 * 3600_000);
    expect(raise).not.toHaveBeenCalled();
  });
});
