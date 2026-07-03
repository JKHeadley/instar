/**
 * Unit tests for SwapAntiThrashEngine — the brake pipeline at the proactive
 * account-swap decision chokepoint (docs/specs/swap-continuity-antithrash.md §3).
 *
 * Fully hermetic: a real SwapLedger against a tmp dir (the ledger IS a
 * dependency of the restart-proof brakes, so tests use the real one), injected
 * clock, injected accounts. Covers BOTH SIDES of every brake boundary:
 *   - all-hot brake: engages when every alternate is validly hot; stands down
 *     when a genuinely (materially) better destination exists
 *   - bound 0 (validity gate): an absent/stale reading is NEVER "0% cool" —
 *     it refuses `target-unmeasured`; fresh-at-boundary readings are eligible
 *   - dwell: blocks inside the window (proactive AND reactive clock-start),
 *     expires after it; restart-safe via ledger hydration
 *   - improvement bound: exactly-at-threshold executes, below refuses
 *   - reversal refusal (same-session, windowed) + T1/T2 breaker open/close
 *   - ledger-lost pause (I12): unwritable ledger refuses `ledger-lost`,
 *     reactive stays index-primed; level-triggered resume
 *   - re-intent backoff after a ceiling drop; intra-tick per-target cap
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SwapAntiThrashEngine,
  resolveAntiThrashKnobs,
  retentionBoundMs,
  readingValidity,
  crossKnobWarnings,
  type AntiThrashKnobs,
} from '../../src/core/SwapAntiThrash.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SwapLedger, type SwapLedgerRow } from '../../src/core/SwapLedger.js';
import type { SubscriptionAccount, AccountQuotaSnapshot } from '../../src/core/SubscriptionPool.js';

const NOW = Date.parse('2026-07-02T15:00:00Z');
// Module-level mutable clock: acct() stamps measuredAt relative to the LIVE
// test clock so advancing time never silently staleness-invalidates a freshly
// built reading (bound 0 would otherwise mask the brake under test).
let now = NOW;

function acct(
  id: string,
  util: number | null,
  opts: { measuredAt?: string | null; status?: SubscriptionAccount['status']; resetsAt?: string } = {},
): SubscriptionAccount {
  const measuredAt = opts.measuredAt === undefined ? new Date(now - 60_000).toISOString() : opts.measuredAt;
  const lastQuota: AccountQuotaSnapshot | null =
    util === null
      ? null
      : {
          sevenDay: { utilizationPct: util, resetsAt: opts.resetsAt ?? '2026-07-03T00:00:00Z' },
          source: 'oauth-usage-endpoint-fallback',
          ...(measuredAt !== null ? { measuredAt } : {}),
        };
  return {
    id,
    nickname: id,
    provider: 'anthropic',
    framework: 'claude-code',
    configHome: `/h/.claude-${id}`,
    status: opts.status ?? 'active',
    lastQuota,
    enrolledAt: '2026-06-01T00:00:00Z',
    version: 1,
  };
}

describe('SwapAntiThrashEngine (brake pipeline)', () => {
  let dir: string;
  let knobs: Partial<import('../../src/core/SwapAntiThrash.js').AntiThrashConfigBlock>;
  let attention: Array<{ id: string; title: string }>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-at-'));
    now = NOW;
    knobs = {};
    attention = [];
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/swap-antithrash-engine.test.ts:cleanup' });
  });

  function resolvedKnobs(): AntiThrashKnobs {
    return resolveAntiThrashKnobs({ enabled: true, dryRun: false, ...knobs }, { thresholdPct: 80, tickMs: 180_000 });
  }

  function makeEngine(ledgerPath = path.join(dir, 'state', 'swap-ledger.jsonl')) {
    const ledger = new SwapLedger({
      filePath: ledgerPath,
      windowMs: () => retentionBoundMs(resolvedKnobs()),
      now: () => now,
    });
    const engine = new SwapAntiThrashEngine({
      ledger,
      getKnobs: resolvedKnobs,
      now: () => now,
      raiseAttention: (id, title) => attention.push({ id, title }),
    });
    engine.hydrate();
    return { engine, ledger };
  }

  function intent(
    engine: SwapAntiThrashEngine,
    accounts: SubscriptionAccount[],
    over: { session?: string; from?: string; targetsUsed?: Set<string> } = {},
  ) {
    return engine.evaluateIntent({
      session: over.session ?? 'sess-1',
      fromAccountId: over.from ?? 'hot',
      accounts,
      nowMs: now,
      targetsUsedThisTick: over.targetsUsed ?? new Set(),
    });
  }

  function readRows(): SwapLedgerRow[] {
    const p = path.join(dir, 'state', 'swap-ledger.jsonl');
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as SwapLedgerRow);
  }

  // ── Brake (a): all-hot ────────────────────────────────────────────────────

  describe('all-hot brake (§3.1)', () => {
    it('REFUSES all-hot when every alternate carries a VALID reading at/above the ceiling', () => {
      // ceiling = 80 - 15 = 65; both alternates validly hot.
      const v = intent(makeEngine().engine, [acct('hot', 85), acct('b', 70), acct('c', 65)]);
      expect(v).toEqual({ action: 'refuse', reason: 'all-hot' });
      const rows = readRows();
      expect(rows.some((r) => r.reason === 'all-hot' && r.transition === 'enter')).toBe(true);
    });

    it('does NOT engage when a genuinely, materially better destination exists', () => {
      const v = intent(makeEngine().engine, [acct('hot', 85), acct('b', 70), acct('cool', 30)]);
      expect(v).toEqual({ action: 'execute', targetAccountId: 'cool', fromUtilPct: 85, toUtilPct: 30 });
    });

    it('boundary: a target exactly AT the ceiling (65) counts hot; one point under it can execute', () => {
      const at = intent(makeEngine().engine, [acct('hot', 85), acct('b', 65)]);
      expect(at).toEqual({ action: 'refuse', reason: 'all-hot' });
      const under = intent(makeEngine().engine, [acct('hot', 85), acct('b', 64)]);
      expect(under.action).toBe('execute');
    });

    it('a pool with NO alternates refuses all-hot (nothing to move to)', () => {
      const v = intent(makeEngine().engine, [acct('hot', 85)]);
      expect(v).toEqual({ action: 'refuse', reason: 'all-hot' });
    });

    it('all-hot rows are state-transition rows: sustained state does not write per-tick rows', () => {
      const { engine } = makeEngine();
      const accounts = [acct('hot', 85), acct('b', 70)];
      intent(engine, accounts);
      intent(engine, accounts); // second tick, same state
      const rows = readRows().filter((r) => r.reason === 'all-hot');
      expect(rows).toHaveLength(1); // one ENTER row, no per-tick repeats
      expect(rows[0]!.transition).toBe('enter');
    });
  });

  // ── Bound 0: the quota-reading validity gate (§3.3, R4-M1) ───────────────

  describe('validity gate — bound 0 (R4-M1)', () => {
    it('an ABSENT reading is never "0% cool": refuses target-unmeasured, not an execute', () => {
      // bindingUtilization(null) === 0 — without bound 0 this account would
      // be the coolest target in the pool (the quota-blind pile-on attack).
      const v = intent(makeEngine().engine, [acct('hot', 85), acct('blind', null)]);
      expect(v).toEqual({ action: 'refuse', reason: 'target-unmeasured' });
      const rows = readRows();
      expect(rows.some((r) => r.reason === 'target-unmeasured' && (r.unmeasuredAlternates ?? 0) >= 1)).toBe(true);
    });

    it('a STALE reading (older than quotaFreshnessMs) is not a measurement', () => {
      const stale = acct('stale-cool', 10, { measuredAt: new Date(now - 1_800_001).toISOString() });
      const v = intent(makeEngine().engine, [acct('hot', 85), stale]);
      expect(v).toEqual({ action: 'refuse', reason: 'target-unmeasured' });
    });

    it('a reading fresh-at-the-boundary is eligible', () => {
      const fresh = acct('cool', 10, { measuredAt: new Date(now - 1_799_999).toISOString() });
      const v = intent(makeEngine().engine, [acct('hot', 85), fresh]);
      expect(v.action).toBe('execute');
    });

    it('one-rule classification: ANY unmeasured alternate ⇒ target-unmeasured even when the others are validly hot (R5-L2)', () => {
      const v = intent(makeEngine().engine, [acct('hot', 85), acct('validhot', 70), acct('blind', null)]);
      expect(v).toEqual({ action: 'refuse', reason: 'target-unmeasured' });
    });

    it('scope guard (R6-L2): a mixed pool holding ONE valid under-ceiling target is NOT refused — it executes', () => {
      const v = intent(makeEngine().engine, [acct('hot', 85), acct('blind', null), acct('cool', 20)]);
      expect(v).toEqual({ action: 'execute', targetAccountId: 'cool', fromUtilPct: 85, toUtilPct: 20 });
    });

    it('source leg: a stale-hot source is not acted on proactively (sourceEligible false)', () => {
      const { engine } = makeEngine();
      const staleHot = acct('hot', 90, { measuredAt: new Date(now - 3_600_000).toISOString() });
      expect(engine.sourceEligible(staleHot, now)).toBe(false);
      // Both sides: a FRESH hot source IS eligible; a fresh cool one is not.
      expect(engine.sourceEligible(acct('hot', 85), now)).toBe(true);
      expect(engine.sourceEligible(acct('coolish', 79), now)).toBe(false);
      expect(engine.sourceEligible(acct('edge', 80), now)).toBe(true);
    });
  });

  // ── Brake (b): dwell ─────────────────────────────────────────────────────

  describe('dwell (§3.2) — cooldown blocks / expires', () => {
    const accounts = () => [acct('hot', 85), acct('cool', 20)];

    it('blocks a re-swap inside the dwell window (proactive clock-start)', () => {
      const { engine } = makeEngine();
      engine.recordProactiveExecuted({ session: 'sess-1', from: 'a', to: 'hot', nowMs: now });
      now += 2_700_000 - 1; // dwellMs - 1
      const v = intent(engine, accounts());
      expect(v).toEqual({ action: 'refuse', reason: 'dwell' });
      const dwellRow = readRows().find((r) => r.reason === 'dwell');
      expect(dwellRow?.dwellRemainingMs).toBe(1);
    });

    it('expires: the same intent executes one ms past the dwell window', () => {
      const { engine } = makeEngine();
      engine.recordProactiveExecuted({ session: 'sess-1', from: 'a', to: 'hot', nowMs: now });
      now += 2_700_000 + 1;
      expect(intent(engine, accounts()).action).toBe('execute');
    });

    it('a REACTIVE swap also starts the dwell clock (a just-rescued session is not re-optimized)…', () => {
      const { engine } = makeEngine();
      engine.recordReactiveExecuted({ session: 'sess-1', from: 'a', to: 'hot', nowMs: now });
      now += 60_000;
      expect(intent(engine, accounts())).toEqual({ action: 'refuse', reason: 'dwell' });
    });

    it('…and dwell is RESTART-SAFE: a fresh engine hydrated from the same ledger still refuses (§2.4 closed)', () => {
      const { engine } = makeEngine();
      engine.recordProactiveExecuted({ session: 'sess-1', from: 'a', to: 'hot', nowMs: now });
      now += 60_000;
      const { engine: rebooted } = makeEngine(); // hydrates from the same file
      expect(intent(rebooted, accounts())).toEqual({ action: 'refuse', reason: 'dwell' });
      now += 2_700_000;
      expect(intent(rebooted, accounts()).action).toBe('execute');
    });
  });

  // ── Brake (c): target-materially-better ──────────────────────────────────

  describe('improvement bound (§3.3 bound 2)', () => {
    it('exactly at minImprovementPct executes; one point under refuses no-material-target', () => {
      // Widen the ceiling so bound 2 binds independently of bound 1.
      knobs = { targetHeadroomPct: 5 }; // ceiling = 75
      const at = intent(makeEngine().engine, [acct('hot', 80), acct('t', 65)]); // improvement 15
      expect(at.action).toBe('execute');
      const under = intent(makeEngine().engine, [acct('hot', 80), acct('t', 66)]); // improvement 14
      expect(under).toEqual({ action: 'refuse', reason: 'no-material-target' });
    });

    it('intra-tick per-target pile-on cap: an already-used target leaves the set for the rest of the tick', () => {
      const { engine } = makeEngine();
      const accounts = [acct('hot', 85), acct('cool', 20)];
      const v = intent(engine, accounts, { session: 'sess-2', targetsUsed: new Set(['cool']) });
      expect(v).toEqual({ action: 'refuse', reason: 'no-material-target' });
    });
  });

  // ── Reversal + breaker (§3.5) ─────────────────────────────────────────────

  describe('reversal refusal + thrash breaker', () => {
    it('refuses the same-session inverse swap inside reversalWindowMs; allows it outside', () => {
      const { engine } = makeEngine();
      // sess-1 executed cool→hot 10 min ago; the intent hot→cool is its inverse.
      engine.recordProactiveExecuted({ session: 'sess-1', from: 'cool', to: 'hot', nowMs: now - 600_000 });
      // dwell would also bind — put the execution before now-dwell but inside
      // the reversal window? dwell (45m) > reversal window (30m), so use a
      // widened reversal window instead to isolate the reversal brake.
      knobs = { dwellMs: 300_000, reversalWindowMs: 1_800_000 };
      const v = intent(engine, [acct('hot', 85), acct('cool', 20)]);
      expect(v).toEqual({ action: 'refuse', reason: 'reversal' });
      // Outside the window: same shape executes.
      now += 1_800_001 - 600_000;
      const v2 = intent(engine, [acct('hot', 85), acct('cool', 20)]);
      expect(v2.action).toBe('execute');
    });

    it('T1: two inversion-class increments open the breaker; ONE deduped attention item; suppresses; half-opens after backoff', () => {
      knobs = { dwellMs: 1, reversalWindowMs: 1_800_000 };
      const { engine } = makeEngine();
      // Two same-session reversal refusals = two T1 increments.
      engine.recordProactiveExecuted({ session: 's1', from: 'cool', to: 'hot', nowMs: now - 10_000 });
      engine.recordProactiveExecuted({ session: 's2', from: 'cool', to: 'hot', nowMs: now - 10_000 });
      expect(intent(engine, [acct('hot', 85), acct('cool', 20)], { session: 's1' })).toEqual({
        action: 'refuse',
        reason: 'reversal',
      });
      expect(engine.isBreakerOpen()).toBe(false); // threshold is 2 — not yet
      expect(intent(engine, [acct('hot', 85), acct('cool', 20)], { session: 's2' })).toEqual({
        action: 'refuse',
        reason: 'reversal',
      });
      expect(engine.isBreakerOpen()).toBe(true);
      expect(attention.filter((a) => a.title.includes('thrashing'))).toHaveLength(1);
      // While open: every proactive intent refuses thrash-breaker (even a fresh session).
      expect(intent(engine, [acct('hot', 85), acct('cool', 20)], { session: 's3' })).toEqual({
        action: 'refuse',
        reason: 'thrash-breaker',
      });
      // Half-open after the backoff: beginTick at/after the deadline closes it.
      now += 3_600_000 + 1;
      engine.beginTick([acct('hot', 85), acct('cool', 20)], now, true);
      expect(engine.isBreakerOpen()).toBe(false);
      expect(intent(engine, [acct('hot', 85), acct('cool', 20)], { session: 's3' }).action).toBe('execute');
      // Still ONE attention item for the whole episode.
      expect(attention.filter((a) => a.title.includes('thrashing'))).toHaveLength(1);
    });

    it('T2: the frequency crossing opens the breaker directly (A→B/B→C/C→A at the dwell floor, R3-M2)', () => {
      const { engine } = makeEngine();
      engine.recordProactiveExecuted({ session: 's1', from: 'a', to: 'b', nowMs: now });
      now += 2_700_000;
      engine.recordProactiveExecuted({ session: 's1', from: 'b', to: 'c', nowMs: now });
      expect(engine.isBreakerOpen()).toBe(false); // threshold−1 must NOT fire
      now += 2_700_000;
      engine.recordProactiveExecuted({ session: 's1', from: 'c', to: 'a', nowMs: now });
      expect(engine.isBreakerOpen()).toBe(true); // the 3rd execution crosses at t=90m
    });

    it('T2 restart-proof: the rotation still opens with a restart between the 2nd and 3rd executions', () => {
      const { engine } = makeEngine();
      engine.recordProactiveExecuted({ session: 's1', from: 'a', to: 'b', nowMs: now });
      now += 2_700_000;
      engine.recordProactiveExecuted({ session: 's1', from: 'b', to: 'c', nowMs: now });
      now += 2_700_000;
      const { engine: rebooted } = makeEngine(); // hydration re-primes the count
      rebooted.recordProactiveExecuted({ session: 's1', from: 'c', to: 'a', nowMs: now });
      expect(rebooted.isBreakerOpen()).toBe(true);
    });

    it('breaker boots OPEN with the original deadline after a mid-backoff restart, and does not re-alert (I8)', () => {
      knobs = { dwellMs: 1, reversalWindowMs: 1_800_000 };
      const { engine } = makeEngine();
      engine.recordProactiveExecuted({ session: 's1', from: 'cool', to: 'hot', nowMs: now - 10_000 });
      engine.recordProactiveExecuted({ session: 's2', from: 'cool', to: 'hot', nowMs: now - 10_000 });
      intent(engine, [acct('hot', 85), acct('cool', 20)], { session: 's1' });
      intent(engine, [acct('hot', 85), acct('cool', 20)], { session: 's2' });
      expect(engine.isBreakerOpen()).toBe(true);
      const itemsBefore = attention.length;
      // Restart in the SECOND half of the backoff (the R2-M2 regression case).
      now += 3_000_000; // 50 min into the 60-min backoff
      const { engine: rebooted } = makeEngine();
      expect(rebooted.isBreakerOpen()).toBe(true);
      expect(attention.length).toBe(itemsBefore); // episodeId-deduped — no re-alert
      // The ORIGINAL deadline still governs: 10+ min later it half-opens.
      now += 600_001;
      rebooted.beginTick([acct('hot', 85)], now, true);
      expect(rebooted.isBreakerOpen()).toBe(false);
    });
  });

  // ── Ledger-lost pause (I12) ───────────────────────────────────────────────

  describe('ledger-lost pause (§3.5, R3-M3)', () => {
    it('an unwritable ledger pauses proactive optimization (refuse ledger-lost) and resumes level-triggered', () => {
      // Parent path is a FILE → mkdir/append both fail → unwritable.
      const blocker = path.join(dir, 'blocker');
      fs.writeFileSync(blocker, 'not a dir');
      const ledgerPath = path.join(blocker, 'swap-ledger.jsonl');
      let engineRef: SwapAntiThrashEngine | null = null;
      const ledger = new SwapLedger({
        filePath: ledgerPath,
        windowMs: () => retentionBoundMs(resolvedKnobs()),
        now: () => now,
        outageRefusalCount: () => engineRef?.ledgerLostRefusalCount() ?? 0,
      });
      const engine = new SwapAntiThrashEngine({
        ledger,
        getKnobs: resolvedKnobs,
        now: () => now,
        raiseAttention: (id, title) => attention.push({ id, title }),
      });
      engineRef = engine;
      engine.hydrate();
      // Force the ledger into its unwritable state with a first failed append.
      engine.recordProactiveExecuted({ session: 'other', from: 'x', to: 'y', nowMs: now - 3_000_000 });
      expect(ledger.isWritable()).toBe(false);
      const v = intent(engine, [acct('hot', 85), acct('cool', 20)]);
      expect(v).toEqual({ action: 'refuse', reason: 'ledger-lost' });
      expect(engine.ledgerLostRefusalCount()).toBe(1);
      // REACTIVE decisions during the outage still prime the in-memory index (R4-m1).
      engine.recordReactiveExecuted({ session: 'sess-1', from: 'a', to: 'hot', nowMs: now });
      // Level-triggered resume: make the path writable again → next intent
      // resumes (and the rescued session is dwell-covered from the outage).
      SafeFsExecutor.safeRmSync(blocker, { operation: 'tests/unit/swap-antithrash-engine.test.ts:unblock-ledger' });
      const v2 = intent(engine, [acct('hot', 85), acct('cool', 20)]);
      expect(v2).toEqual({ action: 'refuse', reason: 'dwell' }); // resumed AND index-primed
      expect(ledger.isWritable()).toBe(true);
      // The resume wrote the ONE outage-summary breadcrumb (R5-m3).
      const rows = fs
        .readFileSync(ledgerPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as SwapLedgerRow);
      const summaries = rows.filter((r) => r.decision === 'outage-summary');
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.ledgerLostRefusals).toBe(1);
      expect(summaries[0]!.session).toBeUndefined(); // no session/account fields
    });
  });

  // ── Re-intent backoff (§4.2) ─────────────────────────────────────────────

  describe('re-intent backoff after a ceiling drop', () => {
    it('skips the session for dwellMs after a dropped intent; regenerates after', () => {
      const { engine } = makeEngine();
      engine.recordDropped({
        session: 'sess-1',
        from: 'hot',
        to: 'cool',
        nowMs: now,
        deferralAgeMs: 1_800_000,
        deferCount: 9,
        inFlight: { turn: true, subagents: 0 },
        subagentLeg: 'ok',
      });
      now += 60_000;
      expect(intent(engine, [acct('hot', 85), acct('cool', 20)])).toEqual({ action: 'skip', why: 'reintent-backoff' });
      now += 2_700_000;
      expect(intent(engine, [acct('hot', 85), acct('cool', 20)]).action).toBe('execute');
    });
  });

  // ── Knob helpers ─────────────────────────────────────────────────────────

  describe('knob resolution + retention formula', () => {
    it('an ABSENT antiThrash block resolves enabled:true, dryRun:true (the migration default-direction pin)', () => {
      const k = resolveAntiThrashKnobs(undefined, { thresholdPct: 80, tickMs: 180_000 });
      expect(k.enabled).toBe(true);
      expect(k.dryRun).toBe(true);
      expect(k.dwellMs).toBe(2_700_000);
    });

    it('retentionBoundMs covers every detection window AND the continuation term (R3-M1 + R5-m2)', () => {
      const k = resolveAntiThrashKnobs({}, {});
      // 4h at shipped defaults — the continuation term dominates.
      expect(retentionBoundMs(k)).toBe(3_600_000 + 10_800_000);
      // A wider frequency window raises the bound (no hand-tuned second bound).
      const wide = resolveAntiThrashKnobs({ swapFrequencyWindowMs: 20_000_000 }, {});
      expect(retentionBoundMs(wide)).toBe(3_600_000 + 20_000_000);
    });

    it('cross-knob warnings fire on the two §7 combinations and stay silent on defaults (R4-L2)', () => {
      const ok = crossKnobWarnings(resolveAntiThrashKnobs({}, {}), 15 * 60_000);
      expect(ok).toHaveLength(0);
      const t2Disarmed = crossKnobWarnings(resolveAntiThrashKnobs({ dwellMs: 6_000_000 }, {}), 15 * 60_000);
      expect(t2Disarmed.some((w) => w.includes('T2'))).toBe(true);
      const staleAll = crossKnobWarnings(resolveAntiThrashKnobs({ quotaFreshnessMs: 60_000 }, {}), 15 * 60_000);
      expect(staleAll.some((w) => w.includes('quotaFreshnessMs'))).toBe(true);
    });

    it('readingValidity distinguishes absent vs stale vs fresh', () => {
      expect(readingValidity(acct('a', null), NOW, 1_800_000)).toMatchObject({ valid: false, invalidReason: 'absent' });
      expect(
        readingValidity(acct('a', 50, { measuredAt: null }), NOW, 1_800_000),
      ).toMatchObject({ valid: false, invalidReason: 'absent' });
      expect(
        readingValidity(acct('a', 50, { measuredAt: new Date(NOW - 1_800_001).toISOString() }), NOW, 1_800_000),
      ).toMatchObject({ valid: false, invalidReason: 'stale' });
      expect(readingValidity(acct('a', 50), NOW, 1_800_000)).toMatchObject({ valid: true, utilPct: 50 });
    });
  });

  // ── Measurement-blind (I13, R5-m1) ───────────────────────────────────────

  describe('pool-level measurement-blind trigger', () => {
    it('fires ONE item after allHotHeartbeatMs of whole-pool blindness — candidacy-independent', () => {
      const { engine } = makeEngine();
      const blindPool = [acct('a', null), acct('b', 40, { measuredAt: new Date(now - 7_200_000).toISOString() })];
      engine.beginTick(blindPool, now, true);
      engine.endTick(now);
      now += 1_800_001;
      engine.beginTick(blindPool, now, true);
      engine.endTick(now);
      const items = attention.filter((a) => a.title.includes('measurement-blind'));
      expect(items).toHaveLength(1);
      // Sustained blindness does not re-alert (episode-deduped).
      now += 1_800_000;
      engine.beginTick(blindPool, now, true);
      expect(attention.filter((a) => a.title.includes('measurement-blind'))).toHaveLength(1);
    });

    it('does NOT fire on a 0-1 account pool (R6-L4) nor when any account is fresh', () => {
      const { engine } = makeEngine();
      engine.beginTick([acct('a', null)], now, true);
      now += 1_800_001;
      engine.beginTick([acct('a', null)], now, true);
      expect(attention.filter((a) => a.title.includes('measurement-blind'))).toHaveLength(0);
      const { engine: e2 } = makeEngine();
      const mixed = [acct('a', null), acct('b', 40)];
      e2.beginTick(mixed, now, true);
      now += 1_800_001;
      e2.beginTick(mixed, now, true);
      expect(attention.filter((a) => a.title.includes('measurement-blind'))).toHaveLength(0);
    });
  });
});
