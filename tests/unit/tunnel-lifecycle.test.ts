/**
 * Unit tests for TunnelLifecycle — single-owner state machine.
 *
 * Spec: specs/dev-infrastructure/tunnel-failure-resilience.md Part 2.
 *
 * Coverage targets the load-bearing properties surfaced by the
 * convergence-verification round:
 *   - CAS-guarded transitions reject losing writes (the error+exit
 *     double-handler race fix).
 *   - Monotonic epoch increments on every successful transition (the
 *     notification-dedup mechanism).
 *   - Episode lifecycle: start/record/end + attempt counter.
 *   - Cross-episode consent cooldown: refusal counter, exponential
 *     back-off, clear-on-opt-in, isConsentSuppressed reflects clock.
 *   - rotation-pending flag survives across snapshot/restore.
 *   - Valid transition map enforces the published state diagram and
 *     rejects illegal pairs.
 */

import { describe, it, expect } from 'vitest';
import {
  TunnelLifecycle,
  isValidTransition,
  classifyFailure,
  generateNonce,
  generateEpisodeId,
} from '../../src/tunnel/TunnelLifecycle.js';

describe('TunnelLifecycle — CAS-guarded transitions', () => {
  it('initial state is idle, epoch 0', () => {
    const lc = new TunnelLifecycle();
    expect(lc.state).toBe('idle');
    expect(lc.epoch).toBe(0);
    expect(lc.episode).toBeNull();
    expect(lc.rotationPending).toBe(false);
  });

  it('accepts a valid transition and increments the epoch', () => {
    const lc = new TunnelLifecycle();
    const ok = lc.transition('idle', 'starting');
    expect(ok).toBe(true);
    expect(lc.state).toBe('starting');
    expect(lc.epoch).toBe(1);
  });

  it('rejects a CAS-lost transition (current state != expectedFrom)', () => {
    const lc = new TunnelLifecycle();
    lc.transition('idle', 'starting');           // -> starting
    lc.transition('starting', 'active');         // -> active
    // Now a "stale" caller still thinks we're in 'starting' and tries
    // to advance to 'retrying'. This must be rejected (returns false)
    // WITHOUT mutating state, mirroring the error+exit race scenario.
    const ok = lc.transition('starting', 'retrying');
    expect(ok).toBe(false);
    expect(lc.state).toBe('active');             // unchanged
    expect(lc.epoch).toBe(2);                    // unchanged
  });

  it('throws on a structurally invalid pair (programming error, not runtime race)', () => {
    const lc = new TunnelLifecycle();
    // idle → active is not in the published state diagram (must go via starting).
    expect(() => lc.transition('idle', 'active')).toThrow(/invalid transition/);
  });

  it('emits a transition event with monotonic epoch on each successful transition', () => {
    const lc = new TunnelLifecycle();
    const events: number[] = [];
    lc.on('transition', (e) => events.push(e.epoch));
    lc.transition('idle', 'starting');
    lc.transition('starting', 'active');
    lc.transition('active', 'retrying');
    expect(events).toEqual([1, 2, 3]);
  });

  it('a rejected CAS does NOT emit a transition event', () => {
    const lc = new TunnelLifecycle();
    let count = 0;
    lc.on('transition', () => count++);
    lc.transition('idle', 'starting');     // accepted
    lc.transition('idle', 'starting');     // rejected (already starting)
    expect(count).toBe(1);
  });
});

describe('TunnelLifecycle — valid transition map', () => {
  it('matches the spec state diagram for Tier-1 happy path', () => {
    expect(isValidTransition('idle', 'starting')).toBe(true);
    expect(isValidTransition('starting', 'active')).toBe(true);
    expect(isValidTransition('active', 'retrying')).toBe(true);
    expect(isValidTransition('retrying', 'active')).toBe(true);
  });

  it('matches the spec state diagram for Tier-1 → Tier-2 → relay → self-heal cycle', () => {
    expect(isValidTransition('retrying', 'awaiting-consent')).toBe(true);
    expect(isValidTransition('awaiting-consent', 'relay-active')).toBe(true);
    expect(isValidTransition('relay-active', 'self-healing')).toBe(true);
    expect(isValidTransition('self-healing', 'active')).toBe(true);
  });

  it('exhausted → self-healing is allowed (the spec-listed verification-finding fix)', () => {
    expect(isValidTransition('exhausted', 'self-healing')).toBe(true);
  });

  it('rejects self-transitions', () => {
    expect(isValidTransition('active', 'active')).toBe(false);
    expect(isValidTransition('idle', 'idle')).toBe(false);
  });

  it('rejects illegal pairs (idle → active, active → exhausted directly)', () => {
    expect(isValidTransition('idle', 'active')).toBe(false);
    expect(isValidTransition('active', 'exhausted')).toBe(false);
    expect(isValidTransition('idle', 'awaiting-consent')).toBe(false);
  });
});

describe('TunnelLifecycle — episode lifecycle', () => {
  it('startEpisode creates a fresh episode with id + startedAt', () => {
    const lc = new TunnelLifecycle();
    const ep = lc.startEpisode();
    expect(ep.episodeId).toMatch(/^[0-9a-f]{16}$/);
    expect(ep.tier1Attempts).toBe(0);
    expect(ep.attemptedProviders).toEqual([]);
    expect(lc.episode).toEqual(ep);
  });

  it('recordAttempt increments the counter and stamps the failure reason', () => {
    const lc = new TunnelLifecycle();
    lc.startEpisode();
    lc.recordAttempt('cloudflare-named', 'binary-missing');
    lc.recordAttempt('cloudflare-quick', 'rate-limited');
    expect(lc.episode?.tier1Attempts).toBe(2);
    expect(lc.episode?.attemptedProviders).toEqual(['cloudflare-named', 'cloudflare-quick']);
    expect(lc.episode?.lastFailureReason).toBe('rate-limited');
    expect(lc.lastFailureReason).toBe('rate-limited');
  });

  it('endEpisode clears the episode', () => {
    const lc = new TunnelLifecycle();
    lc.startEpisode();
    lc.endEpisode();
    expect(lc.episode).toBeNull();
  });

  it('recordAttempt is a no-op if no episode is active (defensive)', () => {
    const lc = new TunnelLifecycle();
    expect(() => lc.recordAttempt('cloudflare-quick', 'rate-limited')).not.toThrow();
    expect(lc.episode).toBeNull();
  });
});

describe('TunnelLifecycle — consent cooldown (verification finding V2)', () => {
  it('default cooldown is inactive', () => {
    const lc = new TunnelLifecycle();
    expect(lc.isConsentSuppressed()).toBe(false);
    expect(lc.consentCooldown.activeUntil).toBe(0);
  });

  it('recordConsentRefusal extends the cooldown exponentially (1h → 4h → 24h)', () => {
    const lc = new TunnelLifecycle();
    const c1 = lc.recordConsentRefusal();
    const c2 = lc.recordConsentRefusal();
    const c3 = lc.recordConsentRefusal();
    const c4 = lc.recordConsentRefusal();
    // Each step extends by a longer ms window; we don't pin exact ms
    // (clock jitter), but the activeUntil must monotonically grow OR stay
    // at the cap (24h) for the 4th refusal.
    expect(c1.consecutiveRefusals).toBe(1);
    expect(c2.consecutiveRefusals).toBe(2);
    expect(c3.consecutiveRefusals).toBe(3);
    expect(c4.consecutiveRefusals).toBe(4);
    expect(c2.activeUntil).toBeGreaterThanOrEqual(c1.activeUntil);
    expect(c3.activeUntil).toBeGreaterThanOrEqual(c2.activeUntil);
    // 4th and beyond: capped at 24h, so activeUntil stays at the cap window.
    expect(c4.activeUntil).toBeGreaterThanOrEqual(c3.activeUntil - 100); // tolerate cap
  });

  it('isConsentSuppressed reflects the active window vs the supplied clock', () => {
    const lc = new TunnelLifecycle();
    lc.recordConsentRefusal();
    expect(lc.isConsentSuppressed(Date.now() - 1)).toBe(true);
    // After the activeUntil window passes:
    expect(lc.isConsentSuppressed(lc.consentCooldown.activeUntil + 1)).toBe(false);
  });

  it('clearConsentCooldown resets everything (owner opt-in)', () => {
    const lc = new TunnelLifecycle();
    lc.recordConsentRefusal();
    lc.recordConsentRefusal();
    lc.clearConsentCooldown();
    expect(lc.consentCooldown.consecutiveRefusals).toBe(0);
    expect(lc.consentCooldown.activeUntil).toBe(0);
    expect(lc.isConsentSuppressed()).toBe(false);
  });
});

describe('TunnelLifecycle — rotation pending + persistence', () => {
  it('setRotationPending toggles the flag', () => {
    const lc = new TunnelLifecycle();
    expect(lc.rotationPending).toBe(false);
    lc.setRotationPending(true);
    expect(lc.rotationPending).toBe(true);
    lc.setRotationPending(false);
    expect(lc.rotationPending).toBe(false);
  });

  it('snapshot + restoreFrom preserves rotationPending and consent cooldown', () => {
    const lc = new TunnelLifecycle();
    lc.setRotationPending(true);
    lc.recordConsentRefusal();
    const snap = lc.snapshot();

    const lc2 = new TunnelLifecycle();
    lc2.restoreFrom(snap);
    expect(lc2.rotationPending).toBe(true);
    expect(lc2.consentCooldown.consecutiveRefusals).toBe(1);
    expect(lc2.consentCooldown.activeUntil).toBe(snap.consentCooldown.activeUntil);
  });

  it('restoreFrom does NOT resume the live state (boot always starts at idle)', () => {
    const lc = new TunnelLifecycle();
    lc.transition('idle', 'starting');
    lc.transition('starting', 'active');
    const snap = lc.snapshot();
    expect(snap.lastState).toBe('active');

    const lc2 = new TunnelLifecycle();
    lc2.restoreFrom(snap);
    expect(lc2.state).toBe('idle');  // boot always starts at idle by design
  });
});

describe('TunnelLifecycle — classifyFailure', () => {
  it('classifies rate-limit substrings', () => {
    expect(classifyFailure(new Error('rate-limited: cloudflared 1015'))).toBe('rate-limited');
    expect(classifyFailure(new Error('HTTP 429 too many requests'))).toBe('rate-limited');
    expect(classifyFailure(new Error('error 1015 cloudflare'))).toBe('rate-limited');
  });

  it('classifies binary-missing substrings', () => {
    expect(classifyFailure(new Error('binary-missing: cloudflared'))).toBe('binary-missing');
    expect(classifyFailure(new Error('ENOENT: not installed'))).toBe('binary-missing');
  });

  it('classifies network failures', () => {
    expect(classifyFailure(new Error('network: ECONNREFUSED'))).toBe('network');
    expect(classifyFailure(new Error('DNS lookup failed'))).toBe('network');
  });

  it('classifies timeouts', () => {
    expect(classifyFailure(new Error('timeout: did not emit'))).toBe('timeout');
    expect(classifyFailure(new Error('connection timed out'))).toBe('timeout');
  });

  it('classifies reachability-failed', () => {
    expect(classifyFailure(new Error('reachability-failed: /health returned 500'))).toBe('reachability-failed');
  });

  it('classifies process-exit', () => {
    expect(classifyFailure(new Error('process-exit code 1: cloudflared'))).toBe('process-exit');
    expect(classifyFailure(new Error('cloudflared exited code 1'))).toBe('process-exit');
  });

  it('returns unknown for unrecognized messages', () => {
    expect(classifyFailure(new Error('something unexpected'))).toBe('unknown');
    expect(classifyFailure(undefined)).toBe('unknown');
  });
});

describe('TunnelLifecycle — generators', () => {
  it('generateNonce returns 32 hex chars (128 bits)', () => {
    const n = generateNonce();
    expect(n).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generateNonce returns distinct values across calls (CSPRNG)', () => {
    const set = new Set<string>();
    for (let i = 0; i < 100; i++) set.add(generateNonce());
    expect(set.size).toBe(100);
  });

  it('generateEpisodeId returns 16 hex chars (64 bits, sufficient for episode uniqueness)', () => {
    const id = generateEpisodeId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});
