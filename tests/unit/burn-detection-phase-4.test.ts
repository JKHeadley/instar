/**
 * Unit tests — Burn-detection Phase 4 (BurnThrottleRunbook + stateful LlmRateGate).
 *
 * Covers the Phase 4 deliverables from docs/specs/token-burn-detection-and-self-heal.md:
 *   - Stateful LlmRateGate: install/decide/revoke/auto-expire
 *   - Capability-token verification when an HMAC key is configured
 *   - Self-attribution refused at the gate level
 *   - Self-attribution refused at the runbook level (defence-in-depth)
 *   - alert-only on unknown::* by default
 *   - alert-only when autoThrottle config is disabled
 *   - throttle-installed outcome for known keys
 *   - Telegram alert composed with ELI16 narrative tone
 *   - End-to-end: detector emits → runbook decides → gate refuses next call
 */

import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';

import { LlmRateGate } from '../../src/monitoring/LlmRateGate.js';
import {
  BurnThrottleRunbook,
  RUNBOOK_ISSUER,
  composeAlertText,
  extractAttributionKey,
  extractTrigger,
  isUnknownKey,
} from '../../src/monitoring/BurnThrottleRunbook.js';
import type { DegradationEvent } from '../../src/monitoring/DegradationReporter.js';

/** Synthesize a DegradationEvent the way the BurnDetector emits it. */
function makeBurnEvent(opts: { attributionKey: string; trigger: 'absolute-share' | 'baseline-divergence' }): DegradationEvent {
  const reason = opts.trigger === 'absolute-share'
    ? `${opts.attributionKey} consumed 73.0% of 24h spend (threshold 25%)`
    : `${opts.attributionKey} last-1h rate 50,000,000 tok/h, baseline 5,000,000 tok/h (multiplier 2x)`;
  return {
    feature: 'token-burn-detection',
    primary: `attribution_key ${opts.attributionKey} sustained spend within thresholds`,
    fallback: 'signal-only: detector flagged the key',
    reason,
    impact: 'Projected 3,000,000,000 tokens in next 24h at current rate.',
    timestamp: '2026-05-15T22:30:00Z',
    reported: false,
    alerted: false,
  };
}

// ── LlmRateGate stateful behavior ─────────────────────────────────────

describe('LlmRateGate — stateful Phase 4 behavior', () => {
  let gate: LlmRateGate;
  let now: number;

  beforeEach(() => {
    now = 1_000_000_000_000;
    gate = new LlmRateGate({ now: () => now });
  });

  it('installThrottle blocks subsequent shouldFire for the same key', () => {
    expect(gate.shouldFire('InputDetector::abc')).toBe(true);
    gate.installThrottle({
      attributionKey: 'InputDetector::abc',
      durationMs: 60_000,
      reason: 'test',
      issuer: RUNBOOK_ISSUER,
      signalId: 'sig-1',
    });
    expect(gate.shouldFire('InputDetector::abc')).toBe(false);
    const d = gate.decide('InputDetector::abc');
    expect(d.reason).toBe('throttle-active');
    expect(d.throttleExpiresAt).toBeDefined();
  });

  it('throttle auto-expires after duration elapses', () => {
    gate.installThrottle({ attributionKey: 'X::y', durationMs: 60_000, reason: '', issuer: RUNBOOK_ISSUER, signalId: 'sig-expire' });
    expect(gate.shouldFire('X::y')).toBe(false);
    now += 60_001;
    expect(gate.shouldFire('X::y')).toBe(true);
    expect(gate.decide('X::y').reason).toBe('no-throttle-installed');
  });

  it('runbook-self-exempt prefix bypasses any throttle (defence in depth at the gate)', () => {
    expect(() => gate.installThrottle({
      attributionKey: 'burn-throttle-runbook::compose-alert',
      durationMs: 60_000,
      reason: 'should be refused',
      issuer: RUNBOOK_ISSUER,
      signalId: 'sig-self',
    })).toThrow(/self-reinforcing-loop/);
  });

  it('rejects zero / negative duration', () => {
    expect(() => gate.installThrottle({ attributionKey: 'X::y', durationMs: 0, reason: '', issuer: '', signalId: 's' })).toThrow();
    expect(() => gate.installThrottle({ attributionKey: 'X::y', durationMs: -1, reason: '', issuer: '', signalId: 's' })).toThrow();
  });

  it('requires signalId (replay-prevention nonce)', () => {
    expect(() => gate.installThrottle({ attributionKey: 'X::y', durationMs: 60_000, reason: '', issuer: '', signalId: '' })).toThrow(/signalId/);
  });

  it('refuses a replayed signalId (Phase 4 second-pass review §1)', () => {
    gate.installThrottle({ attributionKey: 'X::y', durationMs: 60_000, reason: '', issuer: RUNBOOK_ISSUER, signalId: 'sig-replay' });
    gate.revokeThrottle('X::y'); // even after revoke, the signalId is consumed.
    expect(() => gate.installThrottle({
      attributionKey: 'X::y', durationMs: 60_000, reason: '', issuer: RUNBOOK_ISSUER, signalId: 'sig-replay',
    })).toThrow(/replay/i);
  });

  it('revokeThrottle releases the throttle (used by Phase 5 inline button)', () => {
    gate.installThrottle({ attributionKey: 'X::y', durationMs: 60_000, reason: '', issuer: RUNBOOK_ISSUER, signalId: 'sig-rev' });
    expect(gate.shouldFire('X::y')).toBe(false);
    expect(gate.revokeThrottle('X::y')).toBe(true);
    expect(gate.shouldFire('X::y')).toBe(true);
    expect(gate.revokeThrottle('X::y')).toBe(false);
  });

  it('listActiveThrottles returns currently-installed throttles', () => {
    gate.installThrottle({ attributionKey: 'A::1', durationMs: 60_000, reason: '', issuer: RUNBOOK_ISSUER, signalId: 'sig-A' });
    gate.installThrottle({ attributionKey: 'B::2', durationMs: 60_000, reason: '', issuer: RUNBOOK_ISSUER, signalId: 'sig-B' });
    const active = gate.listActiveThrottles();
    expect(active.map((t) => t.attributionKey).sort()).toEqual(['A::1', 'B::2']);
  });

  it('capability-token verification — accepts valid token, rejects invalid', () => {
    const key = crypto.randomBytes(32);
    const signedGate = new LlmRateGate({ capabilityKey: key, now: () => now });
    const validToken = signedGate.computeCapabilityToken({
      attributionKey: 'X::y',
      durationMs: 60_000,
      issuer: RUNBOOK_ISSUER,
      signalId: 'sig-valid',
    })!;
    expect(() => signedGate.installThrottle({
      attributionKey: 'X::y',
      durationMs: 60_000,
      reason: '',
      issuer: RUNBOOK_ISSUER,
      signalId: 'sig-valid',
      capabilityToken: validToken,
    })).not.toThrow();
    expect(() => signedGate.installThrottle({
      attributionKey: 'X::y',
      durationMs: 60_000,
      reason: '',
      issuer: RUNBOOK_ISSUER,
      signalId: 'sig-other',
      capabilityToken: 'forged-token',
    })).toThrow(/capability token/);
  });
});

// ── BurnThrottleRunbook decision logic ─────────────────────────────────

describe('BurnThrottleRunbook — decision logic', () => {
  let gate: LlmRateGate;
  let sentMessages: Array<{ topic: number; text: string }>;
  let now: number;

  beforeEach(() => {
    now = 1_000_000_000_000;
    gate = new LlmRateGate({ now: () => now });
    sentMessages = [];
  });

  function makeRunbook(config: Partial<Parameters<typeof BurnThrottleRunbook>[0]['config']> = {}, _ignored?: any) {
    return new BurnThrottleRunbook({
      gate,
      config,
      sendTelegram: (t, msg) => { sentMessages.push({ topic: t, text: msg }); },
      now: () => now,
    });
  }

  it('throttle-installed for known component (the 2026-05-15 InputDetector case)', () => {
    const runbook = makeRunbook();
    const out = runbook.handle(makeBurnEvent({ attributionKey: 'InputDetector::abcd1234', trigger: 'absolute-share' }));
    expect(out.kind).toBe('throttle-installed');
    expect(out.throttle).toBeDefined();
    expect(gate.shouldFire('InputDetector::abcd1234')).toBe(false);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toMatch(/InputDetector/i);
    expect(sentMessages[0].text).toMatch(/slowed/i);
  });

  it('alert-only-unknown for unknown::* keys by default (no auto-throttle on unknown)', () => {
    const runbook = makeRunbook();
    const out = runbook.handle(makeBurnEvent({ attributionKey: 'unknown::sess-xyz', trigger: 'absolute-share' }));
    expect(out.kind).toBe('alert-only-unknown');
    expect(gate.shouldFire('unknown::sess-xyz')).toBe(true); // not throttled
    expect(sentMessages).toHaveLength(1); // alert still sent
  });

  it('throttle-installed for unknown::* when autoThrottleOnUnknown opt-in is set', () => {
    const runbook = makeRunbook({ autoThrottleOnUnknown: true });
    const out = runbook.handle(makeBurnEvent({ attributionKey: 'unknown::sess-xyz', trigger: 'absolute-share' }));
    expect(out.kind).toBe('throttle-installed');
    expect(gate.shouldFire('unknown::sess-xyz')).toBe(false);
  });

  it('alert-only-config-disabled when autoThrottle is false', () => {
    const runbook = makeRunbook({ autoThrottle: false });
    const out = runbook.handle(makeBurnEvent({ attributionKey: 'InputDetector::aa', trigger: 'absolute-share' }));
    expect(out.kind).toBe('alert-only-config-disabled');
    expect(gate.shouldFire('InputDetector::aa')).toBe(true);
    expect(sentMessages).toHaveLength(1);
  });

  it('alert-only-self-attribution refuses to throttle AND emits high-severity escalation (Phase 4 review §3)', () => {
    const runbook = makeRunbook();
    const out = runbook.handle(makeBurnEvent({ attributionKey: 'burn-throttle-runbook::compose-alert', trigger: 'absolute-share' }));
    expect(out.kind).toBe('alert-only-self-attribution');
    // The reviewer flagged that swallowing this case silently is wrong — if
    // the runbook itself is being attributed-to, it's the very case the user
    // needs to investigate. We now emit a URGENT escalation message.
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toMatch(/URGENT/);
    expect(sentMessages[0].text).toMatch(/burn-throttle runbook itself/);
  });

  it('throttle-failed outcome surfaces when the gate refuses (e.g. install error)', () => {
    // Build a gate-like stand-in whose installThrottle throws. The runbook
    // must catch the throw, surface a throttle-failed outcome, and still
    // send a Telegram alert (with the "I tried but it did not take effect"
    // narrative).
    const failingGate = new LlmRateGate({ now: () => now });
    (failingGate as unknown as { installThrottle: () => never }).installThrottle = () => {
      throw new Error('synthetic install failure');
    };
    const failRunbook = new BurnThrottleRunbook({
      gate: failingGate,
      sendTelegram: (t, m) => sentMessages.push({ topic: t, text: m }),
      now: () => now,
    });
    const out = failRunbook.handle(makeBurnEvent({ attributionKey: 'InputDetector::xx', trigger: 'absolute-share' }));
    expect(out.kind).toBe('throttle-failed');
    expect(out.reason).toMatch(/synthetic install failure/);
    expect(sentMessages.at(-1)!.text).toMatch(/did not take effect/i);
  });

  it('uses the configured throttle duration (60min default; overridable)', () => {
    const runbook = makeRunbook({ throttleDurationMs: 10_000 });
    const out = runbook.handle(makeBurnEvent({ attributionKey: 'X::y', trigger: 'absolute-share' }));
    expect(out.kind).toBe('throttle-installed');
    expect(gate.shouldFire('X::y')).toBe(false);
    now += 10_001;
    expect(gate.shouldFire('X::y')).toBe(true);
  });

  it('baseline-divergence trigger produces appropriate alert narrative', () => {
    const runbook = makeRunbook();
    const out = runbook.handle(makeBurnEvent({ attributionKey: 'Surge::aa', trigger: 'baseline-divergence' }));
    expect(out.kind).toBe('throttle-installed');
    expect(sentMessages[0].text).toMatch(/normal rate/i);
  });
});

// ── pure helpers ───────────────────────────────────────────────────────

describe('BurnThrottleRunbook — pure helpers', () => {
  it('extractAttributionKey parses the BurnDetector\'s primary field', () => {
    expect(extractAttributionKey(makeBurnEvent({ attributionKey: 'Foo::bar', trigger: 'absolute-share' }))).toBe('Foo::bar');
  });

  it('extractTrigger maps reason → trigger label', () => {
    expect(extractTrigger(makeBurnEvent({ attributionKey: 'X::y', trigger: 'absolute-share' }))).toBe('absolute-share');
    expect(extractTrigger(makeBurnEvent({ attributionKey: 'X::y', trigger: 'baseline-divergence' }))).toBe('baseline-divergence');
  });

  it('isUnknownKey detects the unknown::* prefix', () => {
    expect(isUnknownKey('unknown::sess-abc')).toBe(true);
    expect(isUnknownKey('InputDetector::abc')).toBe(false);
  });

  it('composeAlertText uses ELI16 narrative tone for known components', () => {
    const text = composeAlertText(
      makeBurnEvent({ attributionKey: 'InputDetector::aa', trigger: 'absolute-share' }),
      'InputDetector::aa',
      'absolute-share',
    );
    expect(text).toContain('InputDetector');
    expect(text).toMatch(/quarter|token budget/i);
  });

  it('composeAlertText handles user-job: prefix narratively', () => {
    const ev = makeBurnEvent({ attributionKey: 'user-job:daily-summary::xx', trigger: 'absolute-share' });
    const text = composeAlertText(ev, 'user-job:daily-summary::xx', 'absolute-share');
    expect(text).toMatch(/scheduled job "daily-summary"/i);
  });
});
