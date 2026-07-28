/**
 * Tests for the POOL-AWARE quota throttle (QuotaTracker.shouldSpawnSession) — the
 * provider-based design.
 *
 * Root cause being fixed: the throttle read ONE account's usage and stopped the
 * WHOLE agent at the shutdown threshold — blind to the pool's other accounts. So a
 * single maxed account stopped everything while fresh accounts (0%) sat idle.
 *
 * The fix: a live pool-placeability provider (wired in server.ts to placement's OWN
 * selectAccount) tells the throttle "is there a placeable account, and its
 * headroom?". The throttle shares placement's exact eligibility BY CONSTRUCTION, so
 * a throttle "allow" is always placeable — closing the band where the old design
 * could allow work placement couldn't land (the respawn-loop gap, F2). Solo agents
 * (no provider) keep the exact legacy single-account behavior.
 *
 * The last describe block uses the REAL selectAccount as the provider (mirroring the
 * server.ts wiring) to prove allowed ⟹ placeable across the 90–95% band.
 *
 * Spec: docs/specs/POOL-AWARE-QUOTA-THROTTLE-SPEC.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { QuotaTracker, type PoolQuota } from '../../src/monitoring/QuotaTracker.js';
import { selectAccount, poolHeadroom } from '../../src/core/QuotaAwareScheduler.js';
import type { JobSchedulerConfig } from '../../src/core/types.js';
import type { SubscriptionAccount } from '../../src/core/SubscriptionPool.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const thresholds: JobSchedulerConfig['quotaThresholds'] = {
  normal: 50, elevated: 70, critical: 85, shutdown: 95,
};

describe('QuotaTracker — pool-aware throttle (provider design)', () => {
  let tmpDir: string;
  let quotaFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-pool-test-'));
    quotaFile = path.join(tmpDir, 'quota-state.json');
    // A walled single-account file underneath — proves the PROVIDER overrides it.
    fs.writeFileSync(quotaFile, JSON.stringify({ usagePercent: 100, source: 'anthropic-oauth', lastUpdated: new Date().toISOString() }));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/quota-tracker-pool-aware.test.ts' });
  });

  function tracker(provider?: () => PoolQuota | null): QuotaTracker {
    const t = new QuotaTracker({ quotaFile, thresholds });
    if (provider) t.setPoolQuotaProvider(provider);
    return t;
  }

  // ── THE CORE FIX: a placeable account ⇒ ALLOWED even though the underlying file is 100% ──
  it('ALLOWS when the provider reports a placeable fresh account (file says 100%)', () => {
    const t = tracker(() => ({ placeable: true, weeklyPercent: 0, fiveHourPercent: 0 }));
    expect(t.canRunJob('medium')).toBe(true);
    expect(t.canRunJob('high')).toBe(true);
    expect(t.canRunJob('low')).toBe(true);
    const r = t.shouldSpawnSession('medium');
    expect(r.allowed).toBe(true);
    expect(r.reason).toMatch(/pool headroom/i);
  });

  // ── The other side: no placeable account ⇒ STOP ──
  it('STOPS when the provider reports no placeable account', () => {
    const t = tracker(() => ({ placeable: false }));
    const r = t.shouldSpawnSession('medium');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/no placeable account/i);
    expect(t.canRunJob('critical')).toBe(false);
  });

  it('still applies priority load-shedding on the best placeable account', () => {
    // best placeable account in the "elevated" band (>=70, <85): high+ only.
    const t = tracker(() => ({ placeable: true, weeklyPercent: 72, fiveHourPercent: 0 }));
    expect(t.canRunJob('high')).toBe(true);
    expect(t.canRunJob('low')).toBe(false);
    expect(t.canRunJob('medium')).toBe(false);
  });

  it('honors a 5-hour wall on the best placeable account', () => {
    const t = tracker(() => ({ placeable: true, weeklyPercent: 10, fiveHourPercent: 97 }));
    expect(t.shouldSpawnSession('medium').allowed).toBe(false);
  });

  it('treats a null weekly percent as unknown-but-placeable (⇒ allowed)', () => {
    const t = tracker(() => ({ placeable: true, weeklyPercent: null, fiveHourPercent: null }));
    expect(t.shouldSpawnSession('medium').allowed).toBe(true);
  });

  it('falls through to file-based logic when the provider throws', () => {
    const t = tracker(() => { throw new Error('pool unavailable'); });
    // underlying file is authoritative 100% ⇒ legacy path stops.
    expect(t.shouldSpawnSession('medium').allowed).toBe(false);
  });

  it('falls through when the provider returns null', () => {
    const t = tracker(() => null);
    expect(t.shouldSpawnSession('medium').allowed).toBe(false); // file = 100% authoritative
  });

  // ── Round-2 hardening: pool path with no trustworthy reading → BOUNDED, not phantom-0% ──
  it('applies the BOUNDED degraded cap when the provider signals degraded (no live reading)', () => {
    // placeable by status but no quota data (freshly enrolled / poller degraded).
    const t = tracker(() => ({ placeable: true, weeklyPercent: null, fiveHourPercent: null, degraded: true }));
    expect(t.canRunJob('low')).toBe(false);     // shed
    expect(t.canRunJob('medium')).toBe(true);   // bounded-allow
    expect(t.canRunJob('critical')).toBe(true);
    expect(t.shouldSpawnSession('medium').reason).toMatch(/degraded mode/i);
  });

  it('honors a 5h wall even in pool-degraded mode', () => {
    const t = tracker(() => ({ placeable: true, weeklyPercent: null, fiveHourPercent: 97, degraded: true }));
    expect(t.shouldSpawnSession('medium').allowed).toBe(false);
  });

  it('treats an implausible per-account weekly percent as untrustworthy → bounded (not phantom headroom)', () => {
    // A non-finite / out-of-range reading must NOT be trusted as headroom.
    for (const bad of [186, -5, NaN]) {
      const t = tracker(() => ({ placeable: true, weeklyPercent: bad as number, fiveHourPercent: 0 }));
      // low is shed (bounded), medium+ allowed — never silently treated as 0% fresh.
      expect(t.canRunJob('low')).toBe(false);
      expect(t.canRunJob('medium')).toBe(true);
    }
  });
});

// ── F2 PROOF: throttle-allowed ⟹ placeable, using the REAL selectAccount provider ──
describe('QuotaTracker — F2: shared eligibility with placement (real selectAccount)', () => {
  let tmpDir: string, quotaFile: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-f2-'));
    quotaFile = path.join(tmpDir, 'quota-state.json');
    fs.writeFileSync(quotaFile, JSON.stringify({ usagePercent: 100, source: 'anthropic-oauth', lastUpdated: new Date().toISOString() }));
  });
  afterEach(() => SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/quota-tracker-pool-aware.test.ts:f2' }));

  function acct(id: string, weeklyPct: number): SubscriptionAccount {
    return {
      id, nickname: id, provider: 'anthropic', framework: 'claude-code',
      configHome: `/tmp/${id}`, status: 'active',
      lastQuota: { sevenDay: { utilizationPct: weeklyPct, resetsAt: '2026-03-01T00:00:00Z' } },
      enrolledAt: '2026-01-01T00:00:00Z', version: 1,
    } as SubscriptionAccount;
  }

  // The server.ts wiring, verbatim, as the provider.
  function poolProvider(accounts: SubscriptionAccount[]): () => PoolQuota {
    return () => {
      const best = selectAccount(accounts, { nowMs: Date.parse('2026-02-01T00:00:00Z') });
      if (!best) return { placeable: false };
      return {
        placeable: true,
        weeklyPercent: best.lastQuota?.sevenDay?.utilizationPct ?? null,
        fiveHourPercent: best.lastQuota?.fiveHour?.utilizationPct ?? null,
      };
    };
  }

  it('one maxed (100%) + one fresh (0%) ⇒ ALLOWED (placeable)', () => {
    const t = new QuotaTracker({ quotaFile, thresholds });
    t.setPoolQuotaProvider(poolProvider([acct('walled', 100), acct('fresh', 0)]));
    expect(t.shouldSpawnSession('medium').allowed).toBe(true);
  });

  it('THE 90–95% BAND: every account at 92% ⇒ STOP (selectAccount returns null — no respawn loop)', () => {
    // The old design's bug: throttle (shutdown 95) said "allowed" at 92% but
    // placement (soft 90) could not place → respawn loop. Now the throttle ASKS
    // selectAccount, which excludes >90% → no placeable account → STOP. F2 closed.
    const t = new QuotaTracker({ quotaFile, thresholds });
    t.setPoolQuotaProvider(poolProvider([acct('a', 92), acct('b', 93), acct('c', 91)]));
    const r = t.shouldSpawnSession('medium');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/no placeable account/i);
  });

  it('all accounts rate-limited (by status) ⇒ STOP — placement can have nothing to land on', () => {
    // Decision boundary (round-2 finding C): selectAccount excludes non-active
    // statuses, so an all-rate-limited pool yields no placeable account → STOP.
    // The stop is NOT latched: it re-evaluates every call, so it self-clears the
    // moment an account's window resets and its status returns to active.
    const rl = { ...acct('a', 10), status: 'rate-limited' } as SubscriptionAccount;
    const t = new QuotaTracker({ quotaFile, thresholds });
    t.setPoolQuotaProvider(poolProvider([rl, { ...acct('b', 5), status: 'rate-limited' } as SubscriptionAccount]));
    expect(t.shouldSpawnSession('medium').allowed).toBe(false);
  });

  it('allowed ⟹ placeable invariant across a usage sweep', () => {
    for (let pct = 0; pct <= 100; pct += 5) {
      const accounts = [acct('x', pct)];
      const t = new QuotaTracker({ quotaFile, thresholds });
      t.setPoolQuotaProvider(poolProvider(accounts));
      const allowed = t.shouldSpawnSession('medium').allowed;
      const placeable = selectAccount(accounts, { nowMs: Date.parse('2026-02-01T00:00:00Z') }) !== null;
      // The invariant: the throttle never allows when there is no placeable account.
      if (allowed) expect(placeable).toBe(true);
    }
  });

  // ── poolHeadroom: the ACTUAL server wiring — gates on MOST-HEADROOM, not the
  //    use-it-or-lose-it drain-first winner (the live-proof fix). ──
  function withFiveHour(a: SubscriptionAccount, fiveHourPct: number): SubscriptionAccount {
    return { ...a, lastQuota: { ...a.lastQuota, fiveHour: { utilizationPct: fiveHourPct, resetsAt: '2026-02-27T00:00:00Z' } } } as SubscriptionAccount;
  }

  it('THE LIVE-PROOF FIX: a maxed/near-maxed pool + one fresh 0% reserve ⇒ allows ALL priorities', () => {
    // Justin\'s real pool shape: justin-gmail 86% (the drain-first winner) + adriana 0%.
    // selectAccount picks justin-gmail (use-it-or-lose-it), but the THROTTLE must gate
    // on the most-headroom account (adriana 0%) so non-critical work is NOT shed.
    const accounts = [acct('sagemind-justin', 100), acct('justin-gmail', 86), acct('adriana', 0), acct('sagemind-adriana', 0)];
    const t = new QuotaTracker({ quotaFile, thresholds });
    t.setPoolQuotaProvider(() => poolHeadroom(accounts, { nowMs: Date.parse('2026-02-01T00:00:00Z') }));
    for (const p of ['low', 'medium', 'high', 'critical'] as const) {
      expect(t.shouldSpawnSession(p).allowed).toBe(true);
    }
    // And placement still drains the soonest-to-reset account (not adriana) — that\'s
    // the use-it-or-lose-it half, unchanged. The throttle just no longer over-sheds.
  });

  it('poolHeadroom STOPS only when every account is over the soft threshold (no headroom)', () => {
    const accounts = [acct('a', 92), acct('b', 95), acct('c', 91)];
    const t = new QuotaTracker({ quotaFile, thresholds });
    t.setPoolQuotaProvider(() => poolHeadroom(accounts, { nowMs: Date.parse('2026-02-01T00:00:00Z') }));
    expect(t.shouldSpawnSession('critical').allowed).toBe(false);
    expect(t.shouldSpawnSession('low').allowed).toBe(false);
  });

  it('poolHeadroom honors a 5h wall on the most-headroom account', () => {
    // The most-headroom account by binding util (max of 7d,5h) is the one with the
    // genuinely lowest pressure; a 5h-walled account is high-pressure so it is not best.
    const accounts = [withFiveHour(acct('walled5h', 0), 99), acct('ok', 40)];
    const t = new QuotaTracker({ quotaFile, thresholds });
    t.setPoolQuotaProvider(() => poolHeadroom(accounts, { nowMs: Date.parse('2026-02-01T00:00:00Z') }));
    // 'ok' (40% weekly, 0 5h) is the most-headroom → allowed.
    expect(t.shouldSpawnSession('medium').allowed).toBe(true);
  });

  it('poolHeadroom signals degraded when the best account has no live reading ⇒ bounded', () => {
    const noQuota = { ...acct('fresh', 0), lastQuota: null } as SubscriptionAccount;
    const t = new QuotaTracker({ quotaFile, thresholds });
    t.setPoolQuotaProvider(() => poolHeadroom([noQuota], { nowMs: Date.parse('2026-02-01T00:00:00Z') }));
    expect(t.canRunJob('low')).toBe(false);      // bounded — shed low
    expect(t.canRunJob('medium')).toBe(true);
  });
});
