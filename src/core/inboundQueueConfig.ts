/**
 * Inbound-queue config types + the config-seam validation (Durable Inbound
 * Message Queue spec §Config, "Config-seam validation").
 *
 * Every cross-component timing invariant named in the spec is validated in
 * THIS one seam at construction (boot), not scattered. A violated invariant
 * does NOT boot the queue with broken timing: the queue stays OFF for that
 * boot, one loud config-error names the violated inequality (fail-safe — OFF
 * is byte-for-byte today's behavior, never a half-configured queue).
 */

export interface InboundQueueConfig {
  enabled: boolean;
  dryRun: boolean;
  maxPerSession: number;
  maxTotal: number;
  hardMaxTotal: number;
  maxHeldTotal: number;
  maxPayloadBytes: number;
  entryTtlMs: number;
  staleCustodyTtlMs: number;
  maxNapDeliveryAgeMs: number;
  deliveredRetentionMs: number;
  drainTickMs: number;
  drainBatchSize: number;
  drainConcurrency: number;
  minInterPassMs: number;
  passDeadlineMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  maxAttempts: number;
  claimStaleMs: number;
  refusalNegativeCacheMs: number;
  maxFailoverRespawns: number;
  maxFailoverReleasesPerTick: number;
  dispatchDeadlineMs: number;
  pauseMaxMs: number;
}

export interface HoldForStabilityConfig {
  enabled: boolean;
  holdMaxMs: number;
  holdRecheckMs: number;
  flapThresholdPerHour: number;
}

export const DEFAULT_INBOUND_QUEUE_CONFIG: InboundQueueConfig = {
  enabled: false,
  dryRun: true,
  maxPerSession: 50,
  maxTotal: 500,
  hardMaxTotal: 1000,
  maxHeldTotal: 150,
  maxPayloadBytes: 65536,
  entryTtlMs: 1800000,
  staleCustodyTtlMs: 120000,
  maxNapDeliveryAgeMs: 600000,
  deliveredRetentionMs: 86400000,
  drainTickMs: 15000,
  drainBatchSize: 25,
  drainConcurrency: 3,
  minInterPassMs: 500,
  passDeadlineMs: 60000,
  baseBackoffMs: 5000,
  maxBackoffMs: 300000,
  maxAttempts: 10,
  claimStaleMs: 120000,
  refusalNegativeCacheMs: 60000,
  maxFailoverRespawns: 5,
  maxFailoverReleasesPerTick: 5,
  dispatchDeadlineMs: 60000,
  pauseMaxMs: 14400000,
};

export const DEFAULT_HOLD_FOR_STABILITY_CONFIG: HoldForStabilityConfig = {
  enabled: false,
  holdMaxMs: 90000,
  holdRecheckMs: 10000,
  flapThresholdPerHour: 6,
};

/**
 * Cross-machine protocol anchor (spec §5 duplicate window 3, round-8): a CODE
 * CONSTANT, deliberately not operator-tunable. Every machine's seam validates
 * BOTH that its own redispatch horizon ≤ this AND its `deliveredRetentionMs`
 * ≥ this — so any two legally-tuned machines compose safely under ANY tuning.
 */
export const PROTOCOL_REDISPATCH_HORIZON_MAX_MS = 12 * 60 * 60 * 1000; // 12h

/**
 * The "boot-sweep window" term of invariant 3 — a conservative constant for
 * how long after a boot the sweep may still redispatch a recovered claimed
 * row (builder-pinned per the decision-completeness review; the seam fails
 * safe to queue-OFF on violation, so a generous constant only tightens).
 */
export const BOOT_SWEEP_WINDOW_MS = 5 * 60 * 1000; // 5 min

/**
 * Resolve the Multi-Machine Session Pool rollout STAGE from a config block.
 * Returns the configured `stage` string only when the pool is BOTH enabled AND
 * carries a `stage`; otherwise 'dark' (the inert default). This is the single
 * source of truth for "is the session pool active, and at what stage?" — both
 * the boot-time inbound-queue construction gate AND the live `_sessionPoolStage`
 * getter in server.ts resolve through this one pure function, so the two can
 * never drift (the original divergence is exactly what let the construction gate
 * read a stale stub and keep the inbound queue dark forever — boot-order bug).
 *
 * @param cfg the resolved `multiMachine.sessionPool` block (liveConfig override
 *   merged over the static config block, or just the static block at boot).
 */
export function resolveSessionPoolStage(
  cfg: { enabled?: boolean; stage?: string } | null | undefined,
): string {
  return cfg?.enabled && cfg?.stage ? String(cfg.stage) : 'dark';
}

/** Σbackoff: total worst-case backoff across maxAttempts (capped curve). */
export function sumBackoffMs(cfg: Pick<InboundQueueConfig, 'baseBackoffMs' | 'maxBackoffMs' | 'maxAttempts'>): number {
  let sum = 0;
  for (let attempt = 0; attempt < cfg.maxAttempts; attempt++) {
    sum += Math.min(cfg.baseBackoffMs * 2 ** attempt, cfg.maxBackoffMs);
  }
  return sum;
}

/** The full redispatch horizon a receipt must outlive (§3.4 receipt floor). */
export function redispatchHorizonMs(cfg: InboundQueueConfig): number {
  return cfg.entryTtlMs + sumBackoffMs(cfg) + cfg.claimStaleMs + cfg.pauseMaxMs + BOOT_SWEEP_WINDOW_MS;
}

export interface InvariantViolation {
  invariant: number;
  name: string;
  message: string;
}

/**
 * The six config-seam invariants (spec §Config). Returns every violation —
 * the caller logs each by name, raises ONE attention item, and keeps the
 * queue OFF for the boot.
 */
export function validateInboundQueueInvariants(
  q: InboundQueueConfig,
  h: HoldForStabilityConfig,
): { ok: boolean; violations: InvariantViolation[] } {
  const v: InvariantViolation[] = [];

  // (1) Drain-rate invariant (§3.2): budget-overrun entries' only exits are a
  // capped release or TTL — the anti-herd cap must never become the loss path.
  const drainRate = h.holdMaxMs + Math.ceil(q.maxHeldTotal / q.maxFailoverReleasesPerTick) * h.holdRecheckMs;
  if (!(drainRate < q.entryTtlMs)) {
    v.push({
      invariant: 1,
      name: 'drain-rate',
      message: `holdMaxMs + ceil(maxHeldTotal/maxFailoverReleasesPerTick)×holdRecheckMs (${drainRate}) must be < entryTtlMs (${q.entryTtlMs})`,
    });
  }

  // (2) dispatchDeadlineMs < claimStaleMs (§3.4 — a claimed row's dispatch
  // must settle before stale-claim recovery can double-dispatch it).
  if (!(q.dispatchDeadlineMs < q.claimStaleMs)) {
    v.push({
      invariant: 2,
      name: 'dispatch-deadline',
      message: `dispatchDeadlineMs (${q.dispatchDeadlineMs}) must be < claimStaleMs (${q.claimStaleMs})`,
    });
  }

  // (3) Receipt-outlives-redispatch floor (§3.4, + pauseMaxMs per round-6/7).
  const horizon = redispatchHorizonMs(q);
  if (!(q.deliveredRetentionMs > horizon)) {
    v.push({
      invariant: 3,
      name: 'receipt-floor',
      message: `deliveredRetentionMs (${q.deliveredRetentionMs}) must be > entryTtlMs + Σbackoff + claimStaleMs + pauseMaxMs + bootSweepWindow (${horizon})`,
    });
  }

  // (4) holdMaxMs < entryTtlMs AND holdRecheckMs < holdMaxMs.
  if (!(h.holdMaxMs < q.entryTtlMs)) {
    v.push({ invariant: 4, name: 'hold-bounds', message: `holdMaxMs (${h.holdMaxMs}) must be < entryTtlMs (${q.entryTtlMs})` });
  }
  if (!(h.holdRecheckMs < h.holdMaxMs)) {
    v.push({ invariant: 4, name: 'hold-bounds', message: `holdRecheckMs (${h.holdRecheckMs}) must be < holdMaxMs (${h.holdMaxMs})` });
  }

  // (5) staleCustodyTtlMs ≤ entryTtlMs.
  if (!(q.staleCustodyTtlMs <= q.entryTtlMs)) {
    v.push({ invariant: 5, name: 'stale-custody', message: `staleCustodyTtlMs (${q.staleCustodyTtlMs}) must be ≤ entryTtlMs (${q.entryTtlMs})` });
  }

  // (6) Cross-machine protocol anchors (round-8): own horizon ≤ the protocol
  // constant AND retention ≥ the protocol constant — two locally-validated
  // machines compose safely under any legal tuning.
  if (!(horizon <= PROTOCOL_REDISPATCH_HORIZON_MAX_MS)) {
    v.push({
      invariant: 6,
      name: 'protocol-horizon',
      message: `redispatch horizon (${horizon}) must be ≤ PROTOCOL_REDISPATCH_HORIZON_MAX (${PROTOCOL_REDISPATCH_HORIZON_MAX_MS})`,
    });
  }
  if (!(q.deliveredRetentionMs >= PROTOCOL_REDISPATCH_HORIZON_MAX_MS)) {
    v.push({
      invariant: 6,
      name: 'protocol-retention',
      message: `deliveredRetentionMs (${q.deliveredRetentionMs}) must be ≥ PROTOCOL_REDISPATCH_HORIZON_MAX (${PROTOCOL_REDISPATCH_HORIZON_MAX_MS})`,
    });
  }

  return { ok: v.length === 0, violations: v };
}
