/**
 * CredentialRebalancerSnapshot — pure mappers from the live system's state into the
 * balancer's read-only pass snapshot (Increment B, step B3b wiring helper).
 *
 * Spec: docs/specs/live-credential-repointing-rebalancer.md §2.4.
 *
 * The CredentialRebalancer orchestrator (B3a) consumes injected `listSlots` / `listAccounts`
 * / `resolveConfig` providers. These pure functions ARE those providers — they translate
 * the CredentialLocationLedger assignments and the SubscriptionPool accounts into the
 * policy's `SlotState` / `AccountState`, and clamp the configured balancer knobs into the
 * resolved config. Kept pure + out of server.ts so the mapping (the place a units/sign
 * bug would silently mis-steer the balancer) is unit-testable.
 */

import type { SlotState, AccountState } from './CredentialRebalancerPolicy.js';
import type { RebalancerResolvedConfig } from './CredentialRebalancer.js';
import type { SubscriptionAccount, SubscriptionAccountStatus } from './SubscriptionPool.js';
import type { CredentialAssignment } from './CredentialLocationLedger.js';

const HOUR_MS = 3600_000;

/**
 * Map the pool account lifecycle status into the policy's eligibility status.
 * Only needs-reauth/disabled are INELIGIBLE (dead credentials). rate-limited is `ok`:
 * a walled account must stay eligible so wall-avoidance can RESCUE its slot (its high
 * utilization % drives the wall objective; excluding it would strand the very slot that
 * needs help).
 */
export function mapAccountStatus(s: SubscriptionAccountStatus): AccountState['status'] {
  switch (s) {
    case 'needs-reauth': return 'needs-reauth';
    case 'disabled': return 'disabled';
    case 'active':
    case 'warming':
    case 'rate-limited':
    default:
      return 'ok';
  }
}

function pctOrNull(v: number | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function hoursUntil(resetsAt: string | undefined, now: number): number | null {
  if (!resetsAt) return null;
  const t = Date.parse(resetsAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (t - now) / HOUR_MS);
}

/** One pool account → the policy's AccountState. */
export function mapAccount(account: SubscriptionAccount, now: number): AccountState {
  const q = account.lastQuota ?? null;
  const measuredAt = q?.measuredAt ? Date.parse(q.measuredAt) : NaN;
  return {
    accountId: account.id,
    status: mapAccountStatus(account.status),
    fiveHrPct: pctOrNull(q?.fiveHour?.utilizationPct),
    weeklyPct: pctOrNull(q?.sevenDay?.utilizationPct),
    weeklyResetsInHours: hoursUntil(q?.sevenDay?.resetsAt, now),
    // No quota reading at all ⇒ measuredAt 0 (epoch) ⇒ always STALE ⇒ source-only.
    measuredAt: Number.isNaN(measuredAt) ? 0 : measuredAt,
  };
}

export function mapAccounts(accounts: readonly SubscriptionAccount[], now: number): AccountState[] {
  return accounts.map((a) => mapAccount(a, now));
}

export interface SlotMapOptions {
  /** The config-home slot that is the default (`~/.claude`), so isDefault is set. */
  defaultSlot?: string | null;
  /** Optional per-slot busyness (recent activity); absent ⇒ 0 (drain has no busiest preference). */
  busynessBySlot?: Record<string, number>;
  /** Optional per-slot "drain in progress" hold (balancer-tracked); absent ⇒ false. */
  drainInProgressBySlot?: Record<string, boolean>;
  /** Optional per-slot last-audit-divergent flag (scheduled-audit-tracked); absent ⇒ false. */
  auditDivergentBySlot?: Record<string, boolean>;
}

/** One ledger assignment → the policy's SlotState. */
export function mapSlot(a: CredentialAssignment, opts: SlotMapOptions): SlotState {
  const lastVerifiedAt = a.lastVerifiedAt ? Date.parse(a.lastVerifiedAt) : NaN;
  return {
    slot: a.slot,
    // The ledger uses '' for a quarantined-but-unassigned slot; normalize to null.
    tenantAccountId: a.accountId ? a.accountId : null,
    isDefault: opts.defaultSlot != null && a.slot === opts.defaultSlot,
    quarantined: a.quarantined,
    lastVerifiedAt: Number.isNaN(lastVerifiedAt) ? null : lastVerifiedAt,
    lastAuditDivergent: opts.auditDivergentBySlot?.[a.slot] ?? false,
    drainInProgress: opts.drainInProgressBySlot?.[a.slot] ?? false,
    busyness: opts.busynessBySlot?.[a.slot] ?? 0,
  };
}

export function mapSlots(assignments: readonly CredentialAssignment[], opts: SlotMapOptions): SlotState[] {
  return assignments.map((a) => mapSlot(a, opts));
}

function clamp(v: number | undefined, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  return Math.min(hi, Math.max(lo, n));
}

/** The raw balancer config block (subscriptionPool.credentialRepointing.balancer + siblings). */
export interface RawRebalancerConfig {
  passIntervalMs?: number;
  highWaterPct?: number;
  criticalPct?: number;
  maxForcedSwapsPerPass?: number;
  minScoreDelta?: number;
  drainHorizonHours?: number;
  drainHeadroomMinPct?: number;
  staleQuotaPollPeriods?: number;
  urgencyClampHours?: number;
  maxForcedOverridesPerWindow?: number;
  breakerThreshold?: number;
  auditCadenceMs?: number;
  desiredDefaultAccountId?: string | null;
  /** Number of slots — clamps maxForcedSwapsPerPass upper bound. */
  slotCount?: number;
}

/**
 * Clamp the configured knobs into the resolved config the orchestrator/policy use.
 * Cooldowns are DERIVED from the poll interval (per-pair ≥1×, per-tenant ≥2× — the
 * lag-sensored controller floors, §2.4); stale-quota is N poll periods.
 */
export function resolveRebalancerConfig(raw: RawRebalancerConfig): RebalancerResolvedConfig {
  const passIntervalMs = clamp(raw.passIntervalMs, 60_000, 3_600_000, 300_000);
  const slotCount = Math.max(1, raw.slotCount ?? 1);
  const stalePeriods = clamp(raw.staleQuotaPollPeriods, 1, 10, 2);
  return {
    policy: {
      highWaterPct: clamp(raw.highWaterPct, 50, 99, 85),
      criticalPct: clamp(raw.criticalPct, 85, 99, 95),
      drainHorizonHours: clamp(raw.drainHorizonHours, 1, 96, 24),
      drainHeadroomMinPct: clamp(raw.drainHeadroomMinPct, 0, 100, 30),
      minScoreDelta: clamp(raw.minScoreDelta, 0, 1000, 10),
      maxForcedSwapsPerPass: clamp(raw.maxForcedSwapsPerPass, 1, slotCount, 1),
      perPairCooldownMs: passIntervalMs, // ≥1× poll interval
      perTenantCooldownMs: passIntervalMs * 2, // ≥2× poll interval (defeats 3-way rotation)
      staleQuotaMs: passIntervalMs * stalePeriods,
      urgencyClampHours: clamp(raw.urgencyClampHours, 1, 24, 4),
    },
    auditCadenceMs: clamp(raw.auditCadenceMs, HOUR_MS, 24 * HOUR_MS, 6 * HOUR_MS),
    desiredDefaultAccountId: raw.desiredDefaultAccountId ?? null,
    maxForcedOverridesPerWindow: clamp(raw.maxForcedOverridesPerWindow, 1, 100, 5),
    breakerThreshold: clamp(raw.breakerThreshold, 1, 20, 3),
  };
}
