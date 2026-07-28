/**
 * Unit tests — SpendAlertEmitters (routing-control-room-spend Increment C,
 * §Surface 2 Alerts — Triggers).
 *
 * Pins: cap-approach 50/80 on BOTH cap kinds with per-window dedupe keys;
 * cap-hit only on cap-exceeded refusals (money-critical); door-dark P19 brakes
 * (episode budget = chain length, widening backoff, flapping wording, bucket
 * re-arm); fallback-spike fires exactly at the hourly ceiling crossing;
 * holder-dead's stable pool-wide dedupe key; observer isolation (a throwing
 * dispatcher never propagates into the gate/router path).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SpendAlertEmitters,
  FALLBACK_SPIKE_PER_HOUR_CEILING,
  DOOR_DARK_FLAP_THRESHOLD,
  DOOR_DARK_BACKOFF_BASE_MS,
  DOOR_DARK_EPISODE_BUCKET_MS,
} from '../../src/core/SpendAlertEmitters.js';
import type { SpendAlert, SpendAlertDispatcher } from '../../src/core/SpendAlertDispatcher.js';

let clock: number;
const now = () => clock;
let dispatched: SpendAlert[];

function mkEmitters(throwOnDispatch = false): SpendAlertEmitters {
  const dispatcher = {
    dispatch: async (a: SpendAlert) => {
      if (throwOnDispatch) throw new Error('dispatcher down');
      dispatched.push(a);
      return { decision: 'sent', lane: 'informational' };
    },
  } as unknown as SpendAlertDispatcher;
  return new SpendAlertEmitters({ dispatcher, machineId: 'm-test', now });
}

beforeEach(() => {
  clock = Date.parse('2026-07-08T12:00:00Z');
  dispatched = [];
});

const ADMIT = (over: Partial<{ committedDayUsd: number; committedLifetimeUsd: number }> = {}) => ({
  type: 'admit' as const,
  keyRef: 'k1',
  door: 'openrouter-api',
  committedLifetimeUsd: 10,
  committedDayUsd: 1,
  lifetimeCapUsd: 60,
  dailyCapUsd: 25,
  ...over,
});

describe('cap-approach (G4)', () => {
  it('fires at 50% and 80% on the DAILY cap with per-window dedupe keys', () => {
    const e = mkEmitters();
    e.onGateEvent(ADMIT({ committedDayUsd: 12.5 })); // 50%
    e.onGateEvent(ADMIT({ committedDayUsd: 20.0 })); // 80% (and ≥50%)
    const keys = dispatched.map((d) => d.dedupeKey);
    expect(keys).toContain('spend-approach:k1:daily:0.5:2026-07-08');
    expect(keys).toContain('spend-approach:k1:daily:0.8:2026-07-08');
  });

  it('fires on the LIFETIME cap too (both kinds — G4)', () => {
    const e = mkEmitters();
    e.onGateEvent(ADMIT({ committedLifetimeUsd: 48 })); // 80% of 60
    const keys = dispatched.map((d) => d.dedupeKey);
    expect(keys).toContain('spend-approach:k1:lifetime:0.5:lifetime');
    expect(keys).toContain('spend-approach:k1:lifetime:0.8:lifetime');
  });

  it('below 50% stays silent', () => {
    const e = mkEmitters();
    e.onGateEvent(ADMIT({ committedDayUsd: 5, committedLifetimeUsd: 10 }));
    expect(dispatched.filter((d) => d.kind === 'cap-approach')).toHaveLength(0);
  });
});

describe('cap-hit', () => {
  it('a cap-exceeded refusal emits ONE money-critical cap-hit with the honest detail', () => {
    const e = mkEmitters();
    e.onGateEvent({ type: 'refusal', reason: 'cap-exceeded', keyRef: 'k1', door: 'openrouter-api', detail: 'daily: committed 24.5 + reserve 8 > cap 25' });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].kind).toBe('cap-hit');
    expect(dispatched[0].text).toContain('daily: committed 24.5 + reserve 8 > cap 25');
  });

  it('non-cap refusal reasons emit nothing (frozen/not-live are not cap alarms)', () => {
    const e = mkEmitters();
    e.onGateEvent({ type: 'refusal', reason: 'frozen', keyRef: 'k1', detail: 'frozen' });
    e.onGateEvent({ type: 'refusal', reason: 'not-live', detail: 'deny-by-default' });
    expect(dispatched).toHaveLength(0);
  });
});

describe('door-dark — P19 brakes', () => {
  const EXHAUSTED = { dryRun: false, failClosed: true, resolution: { resolvedChain: 'JUDGE', swapTail: [{}, {}] } };

  it('episode budget: at most chain-length emissions per episode bucket, with widening backoff', () => {
    const e = mkEmitters();
    // chainLength = tail(2) + 1 = 3. Fire many exhaustions; only backoff-spaced ones emit.
    for (let i = 0; i < 40; i++) {
      e.onNatureRoutePlan(EXHAUSTED);
      clock += DOOR_DARK_BACKOFF_BASE_MS; // one base step per loop — enough for the first, not all
    }
    const emitted = dispatched.filter((d) => d.kind === 'door-dark');
    expect(emitted.length).toBeLessThanOrEqual(3); // the episode budget
    expect(emitted.length).toBeGreaterThanOrEqual(2); // brakes space them, not zero them
  });

  it('the episode bucket rolling re-arms the budget', () => {
    const e = mkEmitters();
    e.onNatureRoutePlan(EXHAUSTED);
    const before = dispatched.length;
    clock += DOOR_DARK_EPISODE_BUCKET_MS + 1;
    e.onNatureRoutePlan(EXHAUSTED);
    expect(dispatched.length).toBe(before + 1);
  });

  it('flapping (≥N exhaustions in the window) escalates the wording', () => {
    const e = mkEmitters();
    for (let i = 0; i < DOOR_DARK_FLAP_THRESHOLD; i++) {
      e.onNatureRoutePlan(EXHAUSTED);
      clock += 60_000;
    }
    // Advance past the backoff so the flapping-state emission can land.
    clock += 8 * DOOR_DARK_BACKOFF_BASE_MS;
    e.onNatureRoutePlan(EXHAUSTED);
    const texts = dispatched.map((d) => d.text);
    expect(texts.some((t) => t.includes('FLAPPING'))).toBe(true);
  });
});

describe('fallback-spike (Near-Silent)', () => {
  it('stays silent below the hourly ceiling, fires EXACTLY ONCE at the crossing', () => {
    const e = mkEmitters();
    for (let i = 0; i < FALLBACK_SPIKE_PER_HOUR_CEILING + 20; i++) {
      e.onNatureRoutePlan({ dryRun: false, servedFallback: true });
    }
    const spikes = dispatched.filter((d) => d.kind === 'fallback-spike');
    expect(spikes).toHaveLength(1); // edge exactly at the ceiling, once per hour bucket
  });

  it('a new hour bucket resets the counter', () => {
    const e = mkEmitters();
    for (let i = 0; i < FALLBACK_SPIKE_PER_HOUR_CEILING; i++) e.onNatureRoutePlan({ dryRun: false, servedFallback: true });
    clock += 3_600_000;
    for (let i = 0; i < FALLBACK_SPIKE_PER_HOUR_CEILING; i++) e.onNatureRoutePlan({ dryRun: false, servedFallback: true });
    expect(dispatched.filter((d) => d.kind === 'fallback-spike')).toHaveLength(2);
  });
});

describe('holder-dead (A2-2) + recon-drift', () => {
  it('holder-dead carries the stable pool-wide dedupe key', () => {
    const e = mkEmitters();
    e.onMeteredLeaseHolderDead('the mini', 7);
    expect(dispatched[0].kind).toBe('holder-dead');
    expect(dispatched[0].dedupeKey).toBe('spend-holder-dead:7');
    expect(dispatched[0].text).toContain('the mini');
  });

  it('recon-drift buckets the drift for its dedupe key (Amendment 1 wording)', () => {
    const e = mkEmitters();
    e.onReconciliationDrift('k1', 'openrouter-api', 12);
    expect(dispatched[0].dedupeKey).toBe('spend-recon-drift:k1:openrouter-api:1');
    expect(dispatched[0].text).toContain('12% more');
  });
});

describe('observer isolation', () => {
  it('a throwing dispatcher NEVER propagates into the gate/router path', () => {
    const e = mkEmitters(true);
    expect(() => e.onGateEvent(ADMIT({ committedDayUsd: 20 }))).not.toThrow();
    expect(() => e.onGateEvent({ type: 'refusal', reason: 'cap-exceeded', detail: 'x' })).not.toThrow();
    expect(() => e.onNatureRoutePlan({ dryRun: false, failClosed: true })).not.toThrow();
    expect(() => e.onMeteredLeaseHolderDead('m', 1)).not.toThrow();
    expect(() => e.onReconciliationDrift('k', 'd', 50)).not.toThrow();
  });
});
