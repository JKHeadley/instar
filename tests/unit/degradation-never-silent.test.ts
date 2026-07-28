/**
 * Resilient Degradation Ladder §4 — never-silent degradation tracking in
 * DegradationReporter. Designed to NOT repeat the 2026-06-21 event-loop wedge:
 * bounded, O(1), reentrancy-safe (sweep surfaces via telegramSender, never report()),
 * liveness-gated (run-once auto-closes, only a genuinely-stuck one escalates).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';

let now = 1_700_000_000_000;
let sent: Array<{ topic: number; text: string }>;

function setup(enabled = true, escalateMs = 1000, ttlMs = 5000, maxOpen = 500) {
  now = 1_700_000_000_000;
  sent = [];
  const r = DegradationReporter.getInstance();
  r.connectDownstream({ telegramSender: async (topic, text) => { sent.push({ topic, text }); }, alertTopicId: 42 });
  r.configureNeverSilent({ enabled, escalateMs, ttlMs, maxOpen, now: () => now });
  return r;
}

describe('DegradationReporter — never-silent lifecycle', () => {
  beforeEach(() => setup());

  it('open then resolve returns the degraded duration and clears the open count', () => {
    const r = setup();
    r.openDegradation('Sentinel', 'claude-code');
    expect(r.openDegradationCount()).toBe(1);
    now += 3000;
    expect(r.resolveDegradation('Sentinel', 'claude-code')).toBe(3000);
    expect(r.openDegradationCount()).toBe(0);
  });

  it('a run-once degradation (0 retries) AUTO-CLOSES at the TTL — never escalates (no false alarm)', () => {
    const r = setup(true, 1000, 5000);
    r.openDegradation('OneShot', 'claude-code'); // opened, never retried
    now += 2000; r.sweepOpenDegradations(); // past escalate window, but 0 retries → no escalation
    expect(sent.length).toBe(0);
    expect(r.openDegradationCount()).toBe(1);
    now += 4000; r.sweepOpenDegradations(); // now past the 5s TTL → auto-close
    expect(r.openDegradationCount()).toBe(0);
    expect(sent.length).toBe(0); // never alarmed
  });

  it('a genuinely-stuck degradation (≥1 retry) ESCALATES once past the window, deduped', () => {
    const r = setup(true, 1000, 30000);
    r.openDegradation('StuckGate', 'claude-code'); // open
    r.openDegradation('StuckGate', 'claude-code'); // retried + still failed → retryAttempts=1 (liveness)
    now += 1500; r.sweepOpenDegradations(); // past 1s escalate window + has a retry → escalate
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain('StuckGate');
    expect(sent[0].text).toContain('heuristic fallback');
    now += 500; r.sweepOpenDegradations(); // within the dedup window → NO re-escalate
    expect(sent.length).toBe(1);
    now += 1100; r.sweepOpenDegradations(); // another full window elapsed → re-escalate once
    expect(sent.length).toBe(2);
  });

  it('keys on (component, framework): a success for one does NOT resolve another', () => {
    const r = setup();
    r.openDegradation('Comp', 'claude-code');
    r.openDegradation('Comp', 'codex-cli'); // same component, different framework = distinct
    expect(r.openDegradationCount()).toBe(2);
    expect(r.resolveDegradation('Comp', 'claude-code')).not.toBeNull();
    expect(r.openDegradationCount()).toBe(1); // the codex-cli one is still open
  });

  it('bounded: opening past maxOpen evicts the oldest (no unbounded growth)', () => {
    const r = setup(true, 1000, 30000, 3);
    r.openDegradation('a', 'f'); r.openDegradation('b', 'f'); r.openDegradation('c', 'f');
    r.openDegradation('d', 'f'); // exceeds maxOpen=3 → evict oldest ('a')
    expect(r.openDegradationCount()).toBe(3);
    expect(r.resolveDegradation('a', 'f')).toBeNull(); // 'a' was evicted
    expect(r.resolveDegradation('d', 'f')).not.toBeNull();
  });

  it('disabled ⇒ every lifecycle call is a no-op', () => {
    const r = setup(false);
    r.openDegradation('X', 'f');
    expect(r.openDegradationCount()).toBe(0);
    expect(r.resolveDegradation('X', 'f')).toBeNull();
    r.sweepOpenDegradations();
    expect(sent.length).toBe(0);
  });
});
