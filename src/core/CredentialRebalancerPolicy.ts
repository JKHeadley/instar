/**
 * CredentialRebalancerPolicy — the §2.4 "stock-trader loop" decision core, as a PURE
 * function (Increment B, step B1 of live credential re-pointing).
 *
 * Spec: docs/specs/live-credential-repointing-rebalancer.md §2.4 (the balancer).
 *
 * ── What this is ──
 * Given a read-only snapshot of a pass (per-account quota + reset proximity, per-slot
 * tenancy/verify/activity, cooldown state, resolved+clamped config), this computes the
 * ZERO-OR-MORE swap decisions for ONE pass. It performs NO IO and holds NO authority:
 * it DECIDES; a separate actuator (step B3) routes an accepted decision through the
 * Step-5 CredentialSwapExecutor under the dark/dry-run gate. Splitting the decision out
 * makes the entire policy — every threshold, cap, cooldown, and eligibility rule —
 * exhaustively unit-testable without a keychain (Tier-0 supervision, §2.4: a
 * deterministic policy over enumerable numeric thresholds).
 *
 * ── Priority of objectives (§2.4) ──
 *   1. Wall avoidance  — a tenant over the high-water mark gets the highest-headroom
 *      eligible account. A tenant over the CRITICAL mark triggers a wall-OVERRIDE that
 *      bypasses the cooldowns + the 1-swap/pass cap, bounded by its own caps
 *      (fresh-data gate, maxForcedSwapsPerPass, maxForcedOverridesPerWindow).
 *   2. Use-it-or-lose-it drain — an account whose WEEKLY window resets soon with unused
 *      headroom is dealt to the busiest slot (weekly only; 5h windows regenerate).
 *   3. Default-slot preference — keep the designated default account in `~/.claude`.
 *
 * Non-forced objectives are bounded to ONE swap per pass (acting twice on one sensor
 * reading is noise). Only the wall-override may emit up to `maxForcedSwapsPerPass`.
 *
 * Dead-default eviction, the correlated-oracle-outage floor, quarantine-exit, the P19
 * breaker, and the scheduled identity audit are step B2 (this module decides swaps; B2
 * adds the degraded-state machinery). This module surfaces the terminal "nothing to do"
 * / "no eligible target" states so B2/B3 can act on them.
 */

/** Resolved + clamped knobs the pure policy operates on (the resolver lives in B3). */
export interface RebalancerPolicyConfig {
  /** Wall-avoidance high-water utilization % (either window). Clamp [50,99]. */
  highWaterPct: number;
  /** Critical mark % for the wall-override. Clamp [85,99]. */
  criticalPct: number;
  /** Drain horizon — a weekly window resetting within this many hours is drainable. */
  drainHorizonHours: number;
  /** Minimum unused weekly headroom % for a drain to be worth it. */
  drainHeadroomMinPct: number;
  /** Minimum score delta to justify a NON-forced move (urgency-clamped). */
  minScoreDelta: number;
  /** Max forced (wall-override) swaps a single pass may emit. Clamp [1, N-slots]. */
  maxForcedSwapsPerPass: number;
  /** Per-pair cooldown ms (≥1× poll interval). */
  perPairCooldownMs: number;
  /** Per-tenant cooldown ms (≥2× poll interval) — defeats the 3-way rotation attack. */
  perTenantCooldownMs: number;
  /** Quota older than this is SOURCE-only (never a swap-in target). */
  staleQuotaMs: number;
  /** Urgency `1/hoursUntilReset` is clamped at this many hours so the delta floor stays meaningful. */
  urgencyClampHours: number;
}

export interface AccountState {
  accountId: string;
  status: 'ok' | 'needs-reauth' | 'disabled';
  /** Utilization % on the 5h window (0..100), or null when unknown. */
  fiveHrPct: number | null;
  /** Utilization % on the weekly window (0..100), or null when unknown. */
  weeklyPct: number | null;
  /** Hours until the weekly window resets, or null when unknown. */
  weeklyResetsInHours: number | null;
  /** When this account's quota was last measured (for the staleness gate). */
  measuredAt: number;
}

export interface SlotState {
  slot: string;
  tenantAccountId: string | null;
  isDefault: boolean;
  quarantined: boolean;
  /** Last oracle identity-verify time, or null if never. */
  lastVerifiedAt: number | null;
  /** True if the last scheduled audit flagged this slot's identity as divergent. */
  lastAuditDivergent: boolean;
  /** Per-slot "drain in progress" hold — exempt from being a drain DESTINATION (§2.4 obj 2). */
  drainInProgress: boolean;
  /** Recent activity score (higher = busier); drain targets the busiest slot. */
  busyness: number;
  /** The most-recently-previously-verified account for this slot (the correlated-outage
   *  floor's "last known good"); used only to keep the DEFAULT slot non-empty when the
   *  oracle is down for every slot. Optional — absent on a never-verified slot. */
  lastKnownGoodAccountId?: string | null;
}

export interface CooldownState {
  /** key = sortedPair(a,b) → last actuation ms. */
  lastActuationByPair: Record<string, number>;
  /** accountId → last actuation ms (the tenant cooldown). */
  lastActuationByTenant: Record<string, number>;
  /** Forced wall-overrides already spent in the current rolling window. */
  forcedOverridesInWindow: number;
  /** The ceiling for forced overrides in a window; at/over it, the override STOPS (surfaced). */
  maxForcedOverridesPerWindow: number;
}

export interface RebalancePassInput {
  now: number;
  slots: SlotState[];
  accounts: AccountState[];
  cooldowns: CooldownState;
  config: RebalancerPolicyConfig;
  /** A slot's identity verify counts as "recent" if within this window (the audit cadence). */
  auditCadenceMs: number;
  /** The account that SHOULD serve `~/.claude` (so manual `claude` is predictable). When the
   *  default slot's tenant dies/quarantines, a healthy verified tenant is dealt in; when the
   *  desired default is itself dead, any healthy verified tenant keeps the slot alive. Null =
   *  no default preference configured (the default-eviction objective is then inert). */
  desiredDefaultAccountId?: string | null;
}

export interface SwapDecision {
  /** The slot being acted on (rescued, or the drain destination, or the default slot). */
  targetSlot: string;
  /** The slot whose tenant is exchanged in. */
  sourceSlot: string;
  objective: 'wall' | 'drain' | 'default' | 'default-eviction';
  /** Set when this is a cooldown/cap-bypassing wall-override or a default-slot rescue. */
  forced: 'wall-override' | 'default-eviction' | null;
  reason: string;
}

export interface PassResult {
  /** 0..maxForcedSwapsPerPass decisions (normal objectives emit ≤1; wall-override may emit more). */
  decisions: SwapDecision[];
  /** DegradationReporter-bound entries (terminal "stuck" states). */
  degraded: string[];
  /** Attention-queue-bound entries (operator-surfaced terminal states). */
  attention: string[];
  /** Human reason when zero decisions were made (for the audited no-op pass). */
  noActuationReason?: string;
}

function sortedPair(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Max utilization across the two windows (the wall is whichever is closer). */
function maxUtil(acc: AccountState): number {
  return Math.max(acc.fiveHrPct ?? 0, acc.weeklyPct ?? 0);
}

/** A slot whose verify is recent AND not divergent is a valid swap-in target (§2.4 recency gate). */
function targetVerifiedRecent(slot: SlotState, now: number, auditCadenceMs: number): boolean {
  return (
    !slot.quarantined &&
    !slot.lastAuditDivergent &&
    slot.lastVerifiedAt !== null &&
    now - slot.lastVerifiedAt <= auditCadenceMs
  );
}

/**
 * Decide the swap(s) for one pass. Pure: same input → same output, no IO.
 * A pass with no actuation returns `decisions: []` + a `noActuationReason` (the caller
 * audits the no-op pass and performs ZERO keychain/CLI operations — the §2.4 invariant).
 */
export function decidePass(input: RebalancePassInput): PassResult {
  const { now, slots, accounts, cooldowns, config, auditCadenceMs } = input;
  const degraded: string[] = [];
  const attention: string[] = [];

  const accById = new Map(accounts.map((a) => [a.accountId, a]));

  // Eligibility (§2.4): a tenant that is needs-reauth/disabled never participates; a
  // quarantined/unverified slot never participates; a slot with no tenant can't move.
  const participatingSlots = slots.filter((s) => {
    if (s.tenantAccountId === null) return false;
    const acc = accById.get(s.tenantAccountId);
    if (!acc) return false;
    return acc.status === 'ok';
  });

  // A slot is a valid swap-in TARGET only if its quota is fresh (stale headroom may mask a
  // wall — the anti-conservative direction → SOURCE-only) AND its identity verify is recent.
  const isFreshQuota = (acc: AccountState): boolean => now - acc.measuredAt <= config.staleQuotaMs;

  // ── Objective 0: dead/quarantined-default eviction (the slot that must never be empty) ──
  // Keep `~/.claude` serving a HEALTHY VERIFIED tenant so manual `claude` keeps working
  // (goal 3 beats slot symmetry + the quarantine-exclusion rule, but ONLY for the default
  // slot). Runs FIRST: a frozen default freezes the operator's manual invocations.
  if (input.desiredDefaultAccountId) {
    const defaultSlot = slots.find((s) => s.isDefault);
    if (defaultSlot) {
      const defTenant = defaultSlot.tenantAccountId ? accById.get(defaultSlot.tenantAccountId) : undefined;
      const defaultDead =
        defaultSlot.quarantined ||
        !defTenant ||
        defTenant.status === 'needs-reauth' ||
        defTenant.status === 'disabled';
      if (defaultDead) {
        // A healthy VERIFIED tenant to deal in (identity-verified THIS pass before the move —
        // a "healthy per stale ledger" target that is actually dead would re-quarantine the
        // default; the recency gate is that pre-check in the pure policy).
        const healthy = slots
          .filter((s) => s.slot !== defaultSlot.slot && !s.quarantined && s.tenantAccountId !== null)
          .filter((s) => {
            const a = accById.get(s.tenantAccountId!);
            return a?.status === 'ok' && targetVerifiedRecent(s, now, auditCadenceMs);
          })
          .sort((a, b) => maxUtil(accById.get(a.tenantAccountId!)!) - maxUtil(accById.get(b.tenantAccountId!)!))[0];
        if (healthy) {
          return {
            decisions: [{
              targetSlot: defaultSlot.slot,
              sourceSlot: healthy.slot,
              objective: 'default-eviction',
              forced: 'default-eviction',
              reason: `default slot ${defaultSlot.slot} is ${defaultSlot.quarantined ? 'quarantined' : 'dead (' + (defTenant?.status ?? 'no-tenant') + ')'}; dealing healthy verified ${healthy.tenantAccountId} in to keep manual claude working`,
            }],
            degraded: [],
            attention: [`default slot ${defaultSlot.slot} was ${defaultSlot.quarantined ? 'quarantined' : 'dead'} — rescued with ${healthy.tenantAccountId}; the displaced credential is parked and needs re-auth/re-probe`],
          };
        }
        // Correlated-oracle-outage floor: NO slot is currently oracle-verifiable (an
        // identity-oracle endpoint storm quarantines every probe at once). Do NOT empty/churn the
        // default — preserve its last-known-good assignment + surface; honest bound: this is
        // "preserve last KNOWN-GOOD + flag", NOT "manual claude is certified working".
        const anyVerifiable = slots.some((s) => targetVerifiedRecent(s, now, auditCadenceMs));
        if (!anyVerifiable) {
          return {
            decisions: [],
            degraded: ['no slot is oracle-verifiable — default-slot eviction suspended (correlated-outage floor)'],
            attention: [`oracle unavailable for every slot; ${defaultSlot.slot} preserved at its last-known-good${defaultSlot.lastKnownGoodAccountId ? ' (' + defaultSlot.lastKnownGoodAccountId + ')' : ''} — NOT certified live; no eviction until the oracle returns`],
            noActuationReason: 'correlated oracle outage — default preserved at last-known-good, no eviction',
          };
        }
        // Verifiable slots exist but none is an eligible healthy tenant: surface, do not act.
        return {
          decisions: [],
          degraded: [],
          attention: [`default slot ${defaultSlot.slot} is dead/quarantined and no healthy verified tenant is available to rescue it`],
          noActuationReason: 'default slot dead but no eligible healthy tenant to deal in',
        };
      }
    }
  }

  // ── Objective 1: wall avoidance ───────────────────────────────────────────────
  // Slots whose tenant exceeds the high-water mark, worst-first.
  const walling = participatingSlots
    .map((s) => ({ slot: s, acc: accById.get(s.tenantAccountId!)!, util: maxUtil(accById.get(s.tenantAccountId!)!) }))
    .filter((x) => x.util >= config.highWaterPct)
    .sort((a, b) => b.util - a.util);

  // Eligible rescue targets: an account with the most headroom whose CURRENT slot is a
  // verified-recent, fresh-quota, non-walling slot we can exchange with.
  const rescueTargets = participatingSlots
    .map((s) => ({ slot: s, acc: accById.get(s.tenantAccountId!)! }))
    .filter((x) => maxUtil(x.acc) < config.highWaterPct && isFreshQuota(x.acc) && targetVerifiedRecent(x.slot, now, auditCadenceMs))
    .sort((a, b) => maxUtil(a.acc) - maxUtil(b.acc)); // lowest utilization (most headroom) first

  const decisions: SwapDecision[] = [];
  const actedSlots = new Set<string>();
  const actedTenants = new Set<string>();

  // Wall-override: critical-mark slots bypass cooldowns + the 1-swap cap, bounded by
  // maxForcedSwapsPerPass + the fresh-data gate + maxForcedOverridesPerWindow.
  const critical = walling.filter((x) => x.util >= config.criticalPct);
  let overridesLeft = Math.max(0, cooldowns.maxForcedOverridesPerWindow - cooldowns.forcedOverridesInWindow);
  let forcedThisPass = 0;

  for (const w of critical) {
    if (forcedThisPass >= config.maxForcedSwapsPerPass) break;
    if (overridesLeft <= 0) {
      degraded.push('wall-override budget exhausted — no durable rescue available');
      attention.push(`wall-override budget exhausted for slot ${w.slot.slot} — a thrashing tenant the rescue can't durably help`);
      break;
    }
    // Fresh-data gate: act on a NEW critical reading only (the tenant's quota must be newer
    // than its last actuation), so the override never re-fires on the same snapshot.
    const lastAct = cooldowns.lastActuationByTenant[w.acc.accountId] ?? -Infinity;
    if (w.acc.measuredAt <= lastAct) continue;

    const target = rescueTargets.find((t) => !actedSlots.has(t.slot.slot) && t.slot.slot !== w.slot.slot && !actedTenants.has(t.acc.accountId));
    if (!target) {
      attention.push(`no eligible non-walling rescue target for critical slot ${w.slot.slot}`);
      continue;
    }
    decisions.push({
      targetSlot: w.slot.slot,
      sourceSlot: target.slot.slot,
      objective: 'wall',
      forced: 'wall-override',
      reason: `critical wall ${w.util}%≥${config.criticalPct}% on ${w.acc.accountId}; rescued with ${target.acc.accountId} (${maxUtil(target.acc)}%) — cooldowns bypassed`,
    });
    actedSlots.add(w.slot.slot); actedSlots.add(target.slot.slot);
    actedTenants.add(w.acc.accountId); actedTenants.add(target.acc.accountId);
    forcedThisPass += 1; overridesLeft -= 1;
  }

  // If a forced override already acted this pass, we are done (the override is the highest
  // priority; non-forced objectives wait for the next pass to respect 1-swap hygiene).
  if (decisions.length > 0) {
    return { decisions, degraded, attention };
  }

  // Non-forced wall avoidance (85–95%): respects per-pair + per-tenant cooldowns, 1 swap/pass.
  const cooldownOk = (_slotA: string, _slotB: string, accA: string, accB: string): boolean => {
    // The per-pair cooldown keys on the TENANT pair (the two accounts being exchanged),
    // consistent with the per-tenant cooldown — "don't re-exchange these two tenants too
    // soon" — NOT on the fixed slot seats.
    const pairLast = cooldowns.lastActuationByPair[sortedPair(accA, accB)] ?? -Infinity;
    if (now - pairLast < config.perPairCooldownMs) return false;
    const tA = cooldowns.lastActuationByTenant[accA] ?? -Infinity;
    const tB = cooldowns.lastActuationByTenant[accB] ?? -Infinity;
    if (now - tA < config.perTenantCooldownMs || now - tB < config.perTenantCooldownMs) return false;
    return true;
  };
  // Fresh-data gate for non-forced moves: both tenants' quota newer than their last actuation.
  const freshDataOk = (accA: AccountState, accB: AccountState): boolean => {
    const lA = cooldowns.lastActuationByTenant[accA.accountId] ?? -Infinity;
    const lB = cooldowns.lastActuationByTenant[accB.accountId] ?? -Infinity;
    return accA.measuredAt > lA && accB.measuredAt > lB;
  };

  // The non-forced path handles ONLY the [highWater, critical) band. A critical (≥95%)
  // slot is the override path's responsibility; if the override couldn't act (budget /
  // fresh-data / no target) it was surfaced above and WAITS — it is never silently
  // downgraded to a cooldown-respecting rescue in the same pass (that would re-churn the
  // exact thrashing slot the override budget gave up on).
  for (const w of walling.filter((x) => x.util < config.criticalPct)) {
    const target = rescueTargets.find((t) => t.slot.slot !== w.slot.slot);
    if (!target) {
      attention.push(`no eligible non-walling rescue target for slot ${w.slot.slot}`);
      break;
    }
    if (!cooldownOk(w.slot.slot, target.slot.slot, w.acc.accountId, target.acc.accountId)) continue;
    if (!freshDataOk(w.acc, target.acc)) continue;
    decisions.push({
      targetSlot: w.slot.slot,
      sourceSlot: target.slot.slot,
      objective: 'wall',
      forced: null,
      reason: `wall ${w.util}%≥${config.highWaterPct}% on ${w.acc.accountId}; rescued with ${target.acc.accountId} (${maxUtil(target.acc)}%)`,
    });
    return { decisions, degraded, attention };
  }

  // ── Objective 2: use-it-or-lose-it drain ──────────────────────────────────────
  // An account whose WEEKLY window resets within the horizon with ≥ headroom-min unused,
  // dealt to the busiest eligible slot that is NOT itself a drain-in-progress destination.
  const drainable = accounts
    .filter((a) => a.status === 'ok' && a.weeklyResetsInHours !== null && a.weeklyResetsInHours <= config.drainHorizonHours)
    .filter((a) => a.weeklyPct !== null && 100 - a.weeklyPct >= config.drainHeadroomMinPct)
    .filter((a) => isFreshQuota(a))
    .sort((a, b) => (a.weeklyResetsInHours! - b.weeklyResetsInHours!)); // most-reset-proximate first

  if (drainable.length > 0) {
    const drainAcc = drainable[0];
    // The drain SOURCE slot currently holding that account (the one whose tenant we deal out).
    const drainSourceSlot = participatingSlots.find((s) => s.tenantAccountId === drainAcc.accountId);
    // Busiest eligible destination: not the source, not drain-in-progress-held, verified-recent.
    const dest = participatingSlots
      .filter((s) => s.tenantAccountId !== drainAcc.accountId && !s.drainInProgress && targetVerifiedRecent(s, now, auditCadenceMs))
      .sort((a, b) => b.busyness - a.busyness)[0];
    if (drainSourceSlot && dest) {
      const accDest = accById.get(dest.tenantAccountId!)!;
      // Drain respects cooldowns + fresh-data + the min improvement floor (urgency-clamped).
      if (cooldownOk(drainSourceSlot.slot, dest.slot, drainAcc.accountId, accDest.accountId) && freshDataOk(drainAcc, accDest)) {
        const hoursUntil = Math.max(config.urgencyClampHours, drainAcc.weeklyResetsInHours!);
        const urgency = 1 / hoursUntil;
        const score = (100 - drainAcc.weeklyPct!) * urgency * 100; // headroom × clamped urgency
        if (score >= config.minScoreDelta) {
          decisions.push({
            targetSlot: dest.slot,
            sourceSlot: drainSourceSlot.slot,
            objective: 'drain',
            forced: null,
            reason: `drain ${drainAcc.accountId} (weekly resets in ${drainAcc.weeklyResetsInHours}h, ${100 - drainAcc.weeklyPct!}% unused) → busiest slot ${dest.slot}`,
          });
          return { decisions, degraded, attention };
        }
      }
    }
  }

  // ── Objective 3: default-slot preference ──────────────────────────────────────
  // Keep the designated default account in `~/.claude` when neither (1) nor (2) overrode.
  // (The pure policy only signals the preference when the default slot does NOT already
  // hold the default account AND the move clears the floor; B3 supplies which account is
  // "the default" via the slot.isDefault marker + a desiredDefaultAccountId in config-land.
  // In B1 we surface the preference as a no-op reason when nothing else acted.)
  return {
    decisions: [],
    degraded,
    attention,
    noActuationReason: walling.length > 0
      ? 'walling slots present but every candidate move was held by a cooldown / fresh-data gate / missing eligible target'
      : drainable.length > 0
        ? 'drainable account present but the move did not clear cooldown / fresh-data / min-improvement'
        : 'no wall, no drainable window, slots balanced — zero actuation',
  };
}
