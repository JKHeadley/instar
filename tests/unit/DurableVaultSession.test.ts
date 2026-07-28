/**
 * Unit tests for DurableVaultSession — the flag-gated, TTL+idle-bounded,
 * in-flight-only warm org-Bitwarden session (self-unblock-before-escalating §5.3).
 *
 * Coverage:
 *  - derives a session via the injected deriver and reuses it within TTL
 *  - re-derives after TTL expiry
 *  - drops the session after idle expiry (outside an in-flight run)
 *  - keeps the session warm WHILE a run is in flight (no mid-run drop)
 *  - coalesces concurrent derivations (no double unlock)
 *  - withSession returns null (without running fn) when no session can be derived
 *  - the SECURITY contract: the session value is never returned through any
 *    surface other than the direct fn argument; hasWarmSession leaks no value
 */

import { describe, it, expect } from 'vitest';
import util from 'node:util';
import { DurableVaultSession } from '../../src/monitoring/DurableVaultSession.js';

describe('DurableVaultSession — TTL + idle + in-flight bounds', () => {
  it('derives once and reuses within TTL', async () => {
    let derives = 0;
    let t = 0;
    const s = new DurableVaultSession({
      deriveSession: () => {
        derives += 1;
        return 'SESSION-VALUE';
      },
      ttlMs: 1000,
      idleMs: 1000,
      now: () => t,
    });

    const a = await s.withSession((sess) => sess);
    const b = await s.withSession((sess) => sess);
    expect(a).toBe('SESSION-VALUE');
    expect(b).toBe('SESSION-VALUE');
    expect(derives).toBe(1); // reused, not re-derived
  });

  it('re-derives after the TTL expires', async () => {
    let derives = 0;
    let t = 0;
    const s = new DurableVaultSession({
      deriveSession: () => {
        derives += 1;
        return `SESSION-${derives}`;
      },
      ttlMs: 100,
      idleMs: 10_000,
      now: () => t,
    });
    await s.withSession((x) => x);
    expect(derives).toBe(1);
    t = 200; // past TTL
    const second = await s.withSession((x) => x);
    expect(derives).toBe(2);
    expect(second).toBe('SESSION-2');
  });

  it('drops the session after idle expiry (outside an in-flight run)', async () => {
    let t = 0;
    const s = new DurableVaultSession({
      deriveSession: () => 'V',
      ttlMs: 10_000,
      idleMs: 100,
      now: () => t,
    });
    await s.withSession((x) => x);
    expect(s.hasWarmSession()).toBe(true);
    t = 50;
    expect(s.hasWarmSession()).toBe(true); // not idle yet
    t = 200; // past idle window
    expect(s.hasWarmSession()).toBe(false); // dropped
  });

  it('keeps the session warm WHILE a run is in flight (no mid-run drop on idle)', async () => {
    let t = 0;
    let derives = 0;
    const s = new DurableVaultSession({
      deriveSession: () => {
        derives += 1;
        return 'V';
      },
      ttlMs: 10_000,
      idleMs: 10, // tiny idle window
      now: () => t,
    });
    // Inside the run, advance the clock well past the idle window and re-enter —
    // the in-flight guard must keep the session valid, not re-derive.
    const result = await s.withSession(async (sess) => {
      t = 1000; // far past idle, but we are in flight
      const nested = await s.withSession((s2) => s2); // re-entrant use
      expect(nested).toBe(sess);
      return derives;
    });
    expect(result).toBe(1); // derived exactly once despite the idle-window jump
  });

  it('coalesces concurrent derivations (a single unlock under parallel callers)', async () => {
    let derives = 0;
    const s = new DurableVaultSession({
      deriveSession: async () => {
        derives += 1;
        await new Promise((r) => setTimeout(r, 5));
        return 'V';
      },
      ttlMs: 10_000,
      idleMs: 10_000,
    });
    const [a, b, c] = await Promise.all([
      s.withSession((x) => x),
      s.withSession((x) => x),
      s.withSession((x) => x),
    ]);
    expect([a, b, c]).toEqual(['V', 'V', 'V']);
    expect(derives).toBe(1); // one derivation served all three
  });

  it('returns null (without running fn) when the vault cannot be unlocked', async () => {
    let ran = false;
    const s = new DurableVaultSession({ deriveSession: () => null });
    const result = await s.withSession(() => {
      ran = true;
      return 'should-not-run';
    });
    expect(result).toBeNull();
    expect(ran).toBe(false);
  });

  it('clear() drops the in-memory session (zero standing privilege)', async () => {
    const s = new DurableVaultSession({ deriveSession: () => 'V', ttlMs: 10_000, idleMs: 10_000 });
    await s.withSession((x) => x);
    expect(s.hasWarmSession()).toBe(true);
    s.clear();
    expect(s.hasWarmSession()).toBe(false);
  });

  it('SECURITY: hasWarmSession reports presence only, never the value', async () => {
    const SECRET = 'BW-SESSION-SECRET-abc123';
    const s = new DurableVaultSession({ deriveSession: () => SECRET, ttlMs: 10_000, idleMs: 10_000 });
    await s.withSession((x) => x);
    // hasWarmSession is a boolean — there is no surface that returns the value
    // other than the fn argument.
    expect(s.hasWarmSession()).toBe(true);
    // The §5.3 no-leak contract: neither JSON serialization nor util.inspect
    // (console.log) may spill the value.
    expect(JSON.stringify(s)).not.toContain(SECRET);
    expect(util.inspect(s)).not.toContain(SECRET);
    expect(util.inspect(s)).toContain('redacted');
  });
});
