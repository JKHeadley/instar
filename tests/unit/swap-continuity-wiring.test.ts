/**
 * Wiring-integrity tests — swap-continuity-antithrash (§12).
 *
 * The Testing Integrity Standard requires proving the dependency-injected
 * pieces are ACTUALLY consulted (not null, not no-ops) and delegate to real
 * implementations:
 *   - ProactiveSwapMonitor consults the REAL SwapAntiThrashEngine (a refusal
 *     it produces stops the swap; its counters move) — not a stub;
 *   - the monitor→scheduler funnel contract (§3.3, I1): the executed swap
 *     carries the engine's checked targetAccountId + callerClass, and the
 *     scheduler REVALIDATES (refuses, never re-selects) at execute time;
 *   - the monitor's work-gate arm defers (busy) / releases (idle) and drops
 *     at the deferral ceiling into re-intent backoff;
 *   - ModelSwapService consults the subagentLegProbe ONLY behind its dark
 *     micro-flag (Q5) and refuses retryably on a non-idle leg.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProactiveSwapMonitor } from '../../src/core/ProactiveSwapMonitor.js';
import { QuotaAwareScheduler, scoreAccount } from '../../src/core/QuotaAwareScheduler.js';
import {
  SwapAntiThrashEngine,
  resolveAntiThrashKnobs,
  retentionBoundMs,
  readingValidity,
  type AntiThrashKnobs,
} from '../../src/core/SwapAntiThrash.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SwapLedger } from '../../src/core/SwapLedger.js';
import type { WorkProbeResult } from '../../src/core/SwapWorkGate.js';
import {
  ModelSwapService,
  type SwapSessionFacade,
} from '../../src/core/ModelSwapService.js';
import {
  DEFAULT_TIER_ESCALATION_CONFIG,
  normalizeTierEscalationConfig,
} from '../../src/core/ModelTierEscalation.js';
import type { Session } from '../../src/core/types.js';
import type { SubscriptionAccount, AccountQuotaSnapshot } from '../../src/core/SubscriptionPool.js';

const T0 = Date.parse('2026-07-02T15:00:00Z');
let now = T0;

function acct(id: string, util: number | null): SubscriptionAccount {
  const lastQuota: AccountQuotaSnapshot | null =
    util === null
      ? null
      : {
          sevenDay: { utilizationPct: util, resetsAt: '2026-07-03T00:00:00Z' },
          source: 'oauth-usage-endpoint-fallback',
          measuredAt: new Date(now - 60_000).toISOString(),
        };
  return {
    id,
    nickname: id,
    provider: 'anthropic',
    framework: 'claude-code',
    configHome: `/h/.claude-${id}`,
    status: 'active',
    lastQuota,
    enrolledAt: '2026-06-01T00:00:00Z',
    version: 1,
  };
}

describe('swap-continuity wiring integrity', () => {
  let dir: string;
  let knobOver: Partial<import('../../src/core/SwapAntiThrash.js').AntiThrashConfigBlock>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-wire-'));
    now = T0;
    knobOver = {};
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/swap-continuity-wiring.test.ts:cleanup' }));

  function knobs(): AntiThrashKnobs {
    return resolveAntiThrashKnobs({ enabled: true, dryRun: false, ...knobOver }, { thresholdPct: 80, tickMs: 180_000 });
  }

  function makeEngine() {
    const ledger = new SwapLedger({
      filePath: path.join(dir, 'state', 'swap-ledger.jsonl'),
      windowMs: () => retentionBoundMs(knobs()),
      now: () => now,
    });
    const engine = new SwapAntiThrashEngine({ ledger, getKnobs: knobs, now: () => now });
    engine.hydrate();
    return engine;
  }

  function makeMonitor(over: {
    engine: SwapAntiThrashEngine | null;
    accounts: SubscriptionAccount[];
    sessions: Array<{ sessionName: string; accountId: string | null; startedAt?: string; refreshable?: boolean }>;
    defaultAccountId?: string | null;
    probe?: (s: string) => Promise<WorkProbeResult>;
    continuity?: Partial<{ enabled: boolean; dryRun: boolean; deferralCeilingMs: number }>;
    swapImpl?: (a: { sessionName: string; exhaustedAccountId: string; targetAccountId?: string }) => Promise<{ swapped: boolean; toAccountId: string | null; reason?: string }>;
  }) {
    const swap = vi.fn(
      over.swapImpl ??
        (async (a: { targetAccountId?: string }) => ({ swapped: true, toAccountId: a.targetAccountId ?? 'cool' })),
    );
    const monitor = new ProactiveSwapMonitor({
      listAccounts: () => over.accounts,
      listRunningSessions: () =>
        over.sessions.map((s) => ({
          sessionName: s.sessionName,
          accountId: s.accountId,
          startedAt: s.startedAt ?? '2026-07-02T14:00:00Z',
          ...(s.refreshable !== undefined ? { refreshable: s.refreshable } : {}),
        })),
      resolveDefaultAccountId: async () => over.defaultAccountId ?? null,
      swap,
      now: () => now,
      ...(over.engine ? { antiThrash: { engine: over.engine, getKnobs: knobs } } : {}),
      ...(over.probe
        ? {
            workGate: {
              probe: over.probe,
              getContinuity: () => ({
                enabled: true,
                dryRun: false,
                deferralCeilingMs: 1_800_000,
                reactiveGraceMs: 120_000,
                recheckMs: 10_000,
                ...over.continuity,
              }),
            },
          }
        : {}),
    });
    return { monitor, swap };
  }

  const idle: WorkProbeResult = { busy: false, turnLeg: 'idle', subagentLeg: 'ok', turnInFlight: false, subagents: [], reason: null };
  const busy: WorkProbeResult = {
    busy: true,
    turnLeg: 'working',
    subagentLeg: 'ok',
    turnInFlight: true,
    subagents: [{ agentType: 'general-purpose', ageMinutes: 5 }],
    reason: 'busy-turn',
  };

  describe('ProactiveSwapMonitor ⇄ SwapAntiThrashEngine (the brakes are consulted, not decorative)', () => {
    it('funnel contract (I1): the executed swap carries the engine-checked targetAccountId + callerClass', async () => {
      const engine = makeEngine();
      const { monitor, swap } = makeMonitor({
        engine,
        accounts: [acct('hot', 85), acct('cool', 20)],
        sessions: [{ sessionName: 's1', accountId: 'hot' }],
        probe: async () => idle,
      });
      const r = await monitor.evaluate();
      expect(r.swapped).toEqual(['s1']);
      expect(swap).toHaveBeenCalledOnce();
      expect(swap.mock.calls[0]![0]).toMatchObject({
        sessionName: 's1',
        exhaustedAccountId: 'hot',
        targetAccountId: 'cool', // the checked target IS the executed target
        callerClass: 'proactive-swap',
      });
    });

    it('an all-hot pool executes ZERO swaps and the REAL engine records the refusal (delegation proven)', async () => {
      const engine = makeEngine();
      const { monitor, swap } = makeMonitor({
        engine,
        accounts: [acct('hot', 85), acct('warm', 70)],
        sessions: [{ sessionName: 's1', accountId: 'hot' }],
        probe: async () => idle,
      });
      const r = await monitor.evaluate();
      expect(r.swapped).toEqual([]);
      expect(swap).not.toHaveBeenCalled();
      const status = engine.status(now) as { refusals: { byReason: Record<string, number> } };
      expect(status.refusals.byReason['all-hot']).toBe(1);
      // …and the monitor's own status surfaces the engine's brakes block.
      const mStatus = monitor.status();
      expect(mStatus.brakes).toBeDefined();
      expect((mStatus.brakes as { refusals: { byReason: Record<string, number> } }).refusals.byReason['all-hot']).toBe(1);
    });

    it('dwell binds through the wiring: a just-swapped session is not re-swapped next tick', async () => {
      const engine = makeEngine();
      const mk = () =>
        makeMonitor({
          engine,
          accounts: [acct('hot', 85), acct('cool', 20)],
          sessions: [{ sessionName: 's1', accountId: 'hot' }],
          probe: async () => idle,
        });
      const first = mk();
      await first.monitor.evaluate();
      expect(first.swap).toHaveBeenCalledOnce();
      now += 180_000; // one tick later — deep inside dwell
      const second = mk();
      const r2 = await second.monitor.evaluate();
      expect(r2.swapped).toEqual([]);
      expect(second.swap).not.toHaveBeenCalled();
    });

    it('bound untagged session swaps from the resolved default onto the freshest eligible account', async () => {
      const engine = makeEngine();
      const soonReset = acct('soon-reset', 35);
      const freshest = acct('freshest', 7);
      if (soonReset.lastQuota?.sevenDay) soonReset.lastQuota.sevenDay.resetsAt = new Date(now + 60_000).toISOString();
      if (freshest.lastQuota?.sevenDay) freshest.lastQuota.sevenDay.resetsAt = new Date(now + 7 * 24 * 60 * 60_000).toISOString();
      expect(scoreAccount(soonReset, now)).toBeGreaterThan(scoreAccount(freshest, now));
      const { monitor, swap } = makeMonitor({
        engine,
        accounts: [acct('hot', 88), soonReset, freshest],
        sessions: [{ sessionName: 'untagged', accountId: null, refreshable: true }],
        defaultAccountId: 'hot',
        probe: async () => idle,
      });
      const r = await monitor.evaluate();
      expect(r.swapped).toEqual(['untagged']);
      expect(swap).toHaveBeenCalledWith(expect.objectContaining({
        exhaustedAccountId: 'hot',
        targetAccountId: 'freshest',
        sourceWasUntagged: true,
      }));
    });

    it('untagged session holds when no fresher eligible target survives the existing floors', async () => {
      const engine = makeEngine();
      const { monitor, swap } = makeMonitor({
        engine,
        accounts: [acct('hot', 88), acct('also-hot', 70)],
        sessions: [{ sessionName: 'untagged', accountId: null, refreshable: true }],
        defaultAccountId: 'hot',
        probe: async () => idle,
      });
      const r = await monitor.evaluate();
      expect(r.swapped).toEqual([]);
      expect(r.considered).toBe(1);
      expect(swap).not.toHaveBeenCalled();
    });

    it('known-unrefreshable background session is excluded before execution', async () => {
      const engine = makeEngine();
      const { monitor, swap } = makeMonitor({
        engine,
        accounts: [acct('hot', 88), acct('fresh', 7)],
        sessions: [{ sessionName: 'headless', accountId: 'hot', refreshable: false }],
        probe: async () => idle,
      });
      const r = await monitor.evaluate();
      expect(r).toEqual({ swapped: [], considered: 0 });
      expect(swap).not.toHaveBeenCalled();
    });

    it('dryRun keeps the LEGACY decision path (no targetAccountId funnel) while the engine shadows', async () => {
      knobOver = { dryRun: true };
      const engine = makeEngine();
      const { monitor, swap } = makeMonitor({
        engine,
        accounts: [acct('hot', 85), acct('cool', 20)],
        sessions: [{ sessionName: 's1', accountId: 'hot' }],
      });
      await monitor.evaluate();
      expect(swap).toHaveBeenCalledOnce();
      // Legacy call shape: no explicit target (reactive semantics at the funnel).
      expect((swap.mock.calls[0] as unknown[])[0]).not.toHaveProperty('targetAccountId');
    });
  });

  describe('ProactiveSwapMonitor work-gate arm (defer / release / ceiling-drop)', () => {
    it('defers while busy (nothing killed), releases and executes when the work lands', async () => {
      const engine = makeEngine();
      let probeResult = busy;
      const { monitor, swap } = makeMonitor({
        engine,
        accounts: [acct('hot', 85), acct('cool', 20)],
        sessions: [{ sessionName: 's1', accountId: 'hot' }],
        probe: async () => probeResult,
      });
      await monitor.evaluate();
      expect(swap).not.toHaveBeenCalled();
      expect(monitor.status().deferrals).toMatchObject({ active: 1, sessions: ['s1'] });
      // The work lands → the deferred intent re-runs the pipeline and fires.
      probeResult = idle;
      now += 180_000;
      const r = await monitor.evaluate();
      expect(r.swapped).toEqual(['s1']);
      expect(swap).toHaveBeenCalledOnce();
      expect(monitor.status().deferrals).toMatchObject({ active: 0 });
    });

    it('drops the intent at the deferral ceiling (the wall wins) and enters re-intent backoff', async () => {
      const engine = makeEngine();
      const { monitor, swap } = makeMonitor({
        engine,
        accounts: [acct('hot', 85), acct('cool', 20)],
        sessions: [{ sessionName: 's1', accountId: 'hot' }],
        probe: async () => busy,
        continuity: { deferralCeilingMs: 300_000 },
      });
      await monitor.evaluate(); // defer (t=0)
      now += 300_001;
      await monitor.evaluate(); // past the ceiling → DROP
      expect(swap).not.toHaveBeenCalled();
      expect(monitor.status().deferrals).toMatchObject({ active: 0 });
      expect(engine.inReIntentBackoff('s1', now)).toBe(true);
      // Both sides: backoff expires after dwellMs → the session may regenerate.
      now += 2_700_000;
      expect(engine.inReIntentBackoff('s1', now)).toBe(false);
    });
  });

  describe('QuotaAwareScheduler funnel — execute-time revalidation (§3.3, R4-m4)', () => {
    function makeScheduler(over: {
      accounts: SubscriptionAccount[];
      currentAccountId?: string | null;
      refreshImpl?: () => Promise<boolean | { ok: boolean; code?: string }>;
      hooks?: Partial<import('../../src/core/QuotaAwareScheduler.js').QuotaSwapAntiThrashHooks>;
    }) {
      const refreshFn = vi.fn(over.refreshImpl ?? (async () => ({ ok: true })));
      const reactiveFailed = vi.fn();
      const rateCap = vi.fn();
      const reactiveExecuted = vi.fn();
      const scheduler = new QuotaAwareScheduler({
        listAccounts: () => over.accounts,
        refreshFn,
        antiThrash: {
          readingValid: (a, nowMs) => readingValidity(a, nowMs, knobs().quotaFreshnessMs).valid,
          getKnobs: () => ({ thresholdPct: 80, targetHeadroomPct: 15, minImprovementPct: 15 }),
          resolveEffectiveAccountId: async () => (over.currentAccountId === undefined ? 'hot' : over.currentAccountId),
          onReactiveExecuted: reactiveExecuted,
          onReactiveFailed: reactiveFailed,
          onReactiveRateCapRefusal: rateCap,
          ...over.hooks,
        },
      });
      return { scheduler, refreshFn, reactiveFailed, rateCap, reactiveExecuted };
    }

    it('a valid explicit target executes onto EXACTLY that target with the caller class threaded', async () => {
      const { scheduler, refreshFn } = makeScheduler({ accounts: [acct('hot', 85), acct('cool', 20)] });
      const r = await scheduler.onQuotaPressure({
        sessionName: 's1',
        exhaustedAccountId: 'hot',
        nowMs: now,
        targetAccountId: 'cool',
        callerClass: 'proactive-swap',
      });
      expect(r.swapped).toBe(true);
      expect(r.toAccountId).toBe('cool');
      expect(refreshFn).toHaveBeenCalledOnce();
      expect(refreshFn.mock.calls[0]![0]).toMatchObject({ accountId: 'cool', callerClass: 'proactive-swap' });
    });

    it('REFUSES (never re-selects) when the explicit target went hot at execute time', async () => {
      const { scheduler, refreshFn } = makeScheduler({
        accounts: [acct('hot', 85), acct('cool', 70), acct('other', 10)],
      });
      const r = await scheduler.onQuotaPressure({
        sessionName: 's1',
        exhaustedAccountId: 'hot',
        nowMs: now,
        targetAccountId: 'cool',
      });
      expect(r).toMatchObject({ swapped: false, reason: 'target-revalidation-failed' });
      expect(refreshFn).not.toHaveBeenCalled(); // NEVER a silent re-selection onto 'other'
    });

    it('invalidates the intent when a reactive swap moved the session sub-tick (intent-stale, R3-m3)', async () => {
      const { scheduler, refreshFn } = makeScheduler({
        accounts: [acct('hot', 85), acct('cool', 20)],
        currentAccountId: 'already-moved',
      });
      const r = await scheduler.onQuotaPressure({
        sessionName: 's1',
        exhaustedAccountId: 'hot',
        nowMs: now,
        targetAccountId: 'cool',
      });
      expect(r).toMatchObject({ swapped: false, reason: 'intent-stale' });
      expect(refreshFn).not.toHaveBeenCalled();
    });

    it('re-resolves an untagged default source at execution and refuses A→B drift before refresh', async () => {
      const resolveEffectiveAccountId = vi.fn(async (_session: string, sourceWasUntagged: boolean) =>
        sourceWasUntagged ? 'new-default' : 'hot');
      const { scheduler, refreshFn } = makeScheduler({
        accounts: [acct('hot', 88), acct('cool', 7)],
        hooks: { resolveEffectiveAccountId },
      });
      const r = await scheduler.onQuotaPressure({
        sessionName: 'untagged',
        exhaustedAccountId: 'hot',
        nowMs: now,
        targetAccountId: 'cool',
        callerClass: 'proactive-swap',
        sourceWasUntagged: true,
      });
      expect(r).toMatchObject({ swapped: false, reason: 'intent-stale' });
      expect(resolveEffectiveAccountId).toHaveBeenCalledWith('untagged', true);
      expect(refreshFn).not.toHaveBeenCalled();
    });

    it('fails closed when an untagged default source becomes unresolved before execution', async () => {
      const { scheduler, refreshFn } = makeScheduler({
        accounts: [acct('hot', 88), acct('cool', 7)],
        hooks: { resolveEffectiveAccountId: async () => null },
      });
      const r = await scheduler.onQuotaPressure({
        sessionName: 'untagged',
        exhaustedAccountId: 'hot',
        nowMs: now,
        targetAccountId: 'cool',
        callerClass: 'proactive-swap',
        sourceWasUntagged: true,
      });
      expect(r).toMatchObject({ swapped: false, reason: 'intent-stale' });
      expect(refreshFn).not.toHaveBeenCalled();
    });

    it('preserves a concrete proactive refresh refusal code for ledger classification', async () => {
      const { scheduler } = makeScheduler({
        accounts: [acct('hot', 88), acct('cool', 7)],
        refreshImpl: async () => ({ ok: false, code: 'not_telegram_bound' }),
      });
      const r = await scheduler.onQuotaPressure({
        sessionName: 'binding-raced-away',
        exhaustedAccountId: 'hot',
        nowMs: now,
        targetAccountId: 'cool',
        callerClass: 'proactive-swap',
      });
      expect(r).toEqual({ swapped: false, toAccountId: 'cool', reason: 'not_telegram_bound' });
    });

    it('invalidates when the source pressure subsided sub-tick (fresh source check, R4-m4)', async () => {
      const { scheduler, refreshFn } = makeScheduler({ accounts: [acct('hot', 60), acct('cool', 20)] });
      const r = await scheduler.onQuotaPressure({
        sessionName: 's1',
        exhaustedAccountId: 'hot',
        nowMs: now,
        targetAccountId: 'cool',
      });
      expect(r).toMatchObject({ swapped: false, reason: 'intent-stale' });
      expect(refreshFn).not.toHaveBeenCalled();
    });

    it('REACTIVE semantics (no explicit target) keep today\'s re-selection and observe execution', async () => {
      const { scheduler, refreshFn, reactiveExecuted } = makeScheduler({
        accounts: [acct('hot', 95), acct('cool', 20)],
      });
      const r = await scheduler.onQuotaPressure({ sessionName: 's1', exhaustedAccountId: 'hot', nowMs: now });
      expect(r.swapped).toBe(true);
      expect(refreshFn).toHaveBeenCalledOnce();
      expect(reactiveExecuted).toHaveBeenCalledWith({ session: 's1', from: 'hot', to: 'cool', nowMs: now });
    });

    it('a rate-capped REACTIVE refusal reaches the strand-alert hook (§3.1 trigger 2) + the failed observer', async () => {
      const { scheduler, rateCap, reactiveFailed } = makeScheduler({
        accounts: [acct('hot', 95), acct('cool', 20)],
        refreshImpl: async () => ({ ok: false, code: 'rate_limited' }),
      });
      const r = await scheduler.onQuotaPressure({ sessionName: 's1', exhaustedAccountId: 'hot', nowMs: now });
      expect(r.swapped).toBe(false);
      expect(rateCap).toHaveBeenCalledWith('s1', now);
      expect(reactiveFailed).toHaveBeenCalledOnce();
    });
  });

  describe('ModelSwapService subagent idle leg (Q5 — dark micro-flag)', () => {
    const IDLE_TAIL = [
      '╭──────────────────────────────╮',
      '│ >                            │',
      '╰──────────────────────────────╯',
      '  bypass permissions on (shift+tab to cycle)',
    ].join('\n');

    function makeService(over: { subagentIdleLeg: boolean; leg: 'active' | 'idle' | 'absent' | 'indeterminate' }) {
      const stateDir = fs.mkdtempSync(path.join(dir, 'msw-'));
      const session: Session = {
        id: 'inst-1',
        name: 'topic-chat',
        status: 'running',
        tmuxSession: 'proj-topic-chat',
        startedAt: new Date().toISOString(),
        framework: 'claude-code',
        model: 'claude-opus-4-8',
        claudeSessionId: 'claude-1',
      };
      let injected = 0;
      const facade: SwapSessionFacade = {
        listRunningSessions: () => [session],
        captureMeaningfulTail: () =>
          injected > 0 ? `${IDLE_TAIL}\n  ⎿  Set model to Fable 5 and saved as your default for new sessions\n` : IDLE_TAIL,
        sendInput: () => {
          injected += 1;
          return true;
        },
      };
      const probe = vi.fn(() => over.leg);
      const service = new ModelSwapService({
        stateDir,
        sessions: facade,
        saveSession: () => {},
        protectedSessions: () => [],
        getConfig: () =>
          normalizeTierEscalationConfig({
            ...DEFAULT_TIER_ESCALATION_CONFIG,
            enabled: true,
            dryRun: false,
            subagentIdleLeg: over.subagentIdleLeg,
          }),
        governor: {
          admitEscalation: () => ({ allow: true }),
          recordInjection: () => true,
        } as never,
        subagentLegProbe: probe,
        canaryAttempts: 3,
        canaryIntervalMs: 1,
        wait: () => Promise.resolve(),
      });
      return { service, probe };
    }

    it('flag OFF (the shipped default): the probe is NEVER consulted — a live surface never changes on deploy', async () => {
      const { service, probe } = makeService({ subagentIdleLeg: false, leg: 'active' });
      const r = await service.swap('topic-chat', 'escalated');
      expect(probe).not.toHaveBeenCalled();
      expect(r.status).toBe('swapped'); // pane-only semantics, byte-identical
    });

    it('flag ON + live subagents: refuses retryably (not-idle-subagents:active) — the F3 footer blind spot closed', async () => {
      const { service, probe } = makeService({ subagentIdleLeg: true, leg: 'active' });
      const r = await service.swap('topic-chat', 'escalated');
      expect(probe).toHaveBeenCalledOnce();
      expect(r).toMatchObject({ status: 'refused', reason: 'not-idle-subagents:active' });
    });

    it('flag ON + absent/indeterminate leg: refuses (R5-M1 — unreadable is never a license to swap)', async () => {
      const abs = await makeService({ subagentIdleLeg: true, leg: 'absent' }).service.swap('topic-chat', 'escalated');
      expect(abs).toMatchObject({ status: 'refused', reason: 'not-idle-subagents:absent' });
      const ind = await makeService({ subagentIdleLeg: true, leg: 'indeterminate' }).service.swap('topic-chat', 'escalated');
      expect(ind).toMatchObject({ status: 'refused', reason: 'not-idle-subagents:indeterminate' });
    });

    it('flag ON + affirmatively idle leg: the swap proceeds', async () => {
      const { service, probe } = makeService({ subagentIdleLeg: true, leg: 'idle' });
      const r = await service.swap('topic-chat', 'escalated');
      expect(probe).toHaveBeenCalledOnce();
      expect(r.status).toBe('swapped');
    });
  });
});
