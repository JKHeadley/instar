/**
 * stateSync config resolution + invariant validation (WS2 replicated-store
 * foundation, §10.2).
 *
 * Spec: docs/specs/multi-machine-replicated-store-foundation.md §10 (config
 * schema, validateStateSyncInvariants, rollout posture), §3.4 (the maxDriftMs
 * clamp), §8.2 (snapshot-cache ceilings).
 *
 * Mirrors `seamlessnessConfig.ts`: resolve the optional `multiMachine.stateSync`
 * knobs to concrete values, then enforce the cross-knob invariants. A violating
 * config is REJECTED with a clear message (StateSyncConfigError) rather than
 * silently coerced — the §10.2 contract: "a bad config is REJECTED, not silently
 * degraded". The per-store `enabled` flags are NOT validated here (they are the
 * dark-by-default on-switches, store by store); this module governs the
 * FOUNDATION-LEVEL knobs every store shares (the journal budget, the HLC drift
 * ceiling, the snapshot cache bounds).
 */

import {
  clampMaxDriftMs,
  DEFAULT_MAX_DRIFT_MS,
  MIN_MAX_DRIFT_MS,
  MAX_MAX_DRIFT_MS,
} from './HybridLogicalClock.js';
import { DEFAULT_FLUSH_INTERVAL_MS } from './CoherenceJournal.js';
import type { MultiMachineConfig } from './types.js';

/** Foundation-level stateSync defaults (§10.2). */
export const DEFAULT_AGGREGATE_JOURNAL_BUDGET_BYTES = 64 * 1024 * 1024; // 64 MiB
export const DEFAULT_MAX_CACHED_SNAPSHOTS = 16;
export const DEFAULT_MAX_CACHE_BYTES = 32 * 1024 * 1024; // 32 MiB
/**
 * The propagation allowance (§10.2): the invariant `maxDriftMs > flush interval +
 * propagation allowance` must hold so the drift bound can never be tighter than
 * the journal's own flush+replicate latency (which would quarantine our own
 * in-flight writes). With the 60s floor this always holds; the allowance is the
 * realistic worst-case mesh propagation lag we account for explicitly.
 */
export const DEFAULT_PROPAGATION_ALLOWANCE_MS = 10 * 1000; // 10s

/** Fully-resolved foundation-level stateSync knobs (every field concrete). */
export interface ResolvedStateSyncConfig {
  /** Aggregate journal byte budget across all replicated kinds (§10.2). */
  aggregateJournalBudgetBytes: number;
  /** The CLAMPED HLC bounded-drift ceiling the clock enforces (§3.4 / §10.2). */
  maxDriftMs: number;
  /** Snapshot-cache count ceiling (§8.2). */
  maxCachedSnapshots: number;
  /** Snapshot-cache byte ceiling (§8.2). */
  maxCacheBytes: number;
}

export class StateSyncConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateSyncConfigError';
  }
}

/** The minimal shape this module reads from config — the per-store flags are a
 *  free-form map (a store's key → { enabled, dryRun }); the foundation knobs are
 *  optional siblings. Mirrors the spec §10 schema. */
export interface StateSyncRawConfig {
  aggregateJournalBudgetBytes?: number;
  maxDriftMs?: number;
  maxCachedSnapshots?: number;
  maxCacheBytes?: number;
  /** Per-store on-switches live as sibling keys; this module ignores their
   *  shape beyond the foundation knobs. Stores are typed loosely so a new
   *  store added later needs no change here. */
  [store: string]: unknown;
}

/** Read the stateSync block off a multiMachine config (may be absent). */
export function readStateSyncRaw(mm?: MultiMachineConfig): StateSyncRawConfig | undefined {
  const ss = (mm as unknown as { stateSync?: StateSyncRawConfig } | undefined)?.stateSync;
  return ss && typeof ss === 'object' ? ss : undefined;
}

/**
 * Resolve the foundation-level stateSync knobs to concrete values. Does NOT
 * validate — call validateStateSyncInvariants() after (or use
 * assertStateSyncInvariants() for resolve+validate+throw in one step). The
 * maxDriftMs is CLAMPED here via the clock's clampMaxDriftMs so a resolved value
 * is always in-range; the §10.2 invariant additionally REJECTS an out-of-range
 * RAW value (so an operator sees an error, not a silent clamp) — see
 * validateStateSyncInvariants.
 */
export function resolveStateSyncConfig(mm?: MultiMachineConfig): ResolvedStateSyncConfig {
  const ss = readStateSyncRaw(mm);
  return {
    aggregateJournalBudgetBytes: ss?.aggregateJournalBudgetBytes ?? DEFAULT_AGGREGATE_JOURNAL_BUDGET_BYTES,
    maxDriftMs: clampMaxDriftMs(ss?.maxDriftMs),
    maxCachedSnapshots: ss?.maxCachedSnapshots ?? DEFAULT_MAX_CACHED_SNAPSHOTS,
    maxCacheBytes: ss?.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES,
  };
}

/**
 * Validate the foundation-level stateSync invariants (§10.2). Returns the list
 * of violations (empty = valid). Operates on the RAW config (not the resolved
 * one) for the maxDriftMs range check, so an out-of-range value is REJECTED
 * rather than silently clamped — the spec's "rejected, not silently coerced".
 *
 * Invariants (§10.2):
 *  1. aggregateJournalBudgetBytes > 0.
 *  2. maxDriftMs within [60_000, 900_000] (the §3.4 clamp) — out-of-range REJECTED.
 *  3. maxDriftMs > flush interval + propagation allowance (NOT the vacuous
 *     "> flush window") — so the bound can never be tighter than the journal's
 *     own flush+replicate latency.
 *  4. maxCachedSnapshots > 0 and maxCacheBytes > 0 (§8.2).
 */
export function validateStateSyncInvariants(mm?: MultiMachineConfig): string[] {
  const errors: string[] = [];
  const ss = readStateSyncRaw(mm);
  const resolved = resolveStateSyncConfig(mm);

  // 1. aggregate budget positive.
  if (!(resolved.aggregateJournalBudgetBytes > 0)) {
    errors.push(`multiMachine.stateSync.aggregateJournalBudgetBytes must be > 0 (got ${resolved.aggregateJournalBudgetBytes})`);
  }

  // 2. maxDriftMs in [60s, 15min] — reject an out-of-range RAW value rather than
  //    silently clamping (resolveStateSyncConfig clamps for the live primitive,
  //    but the operator must SEE that their value was rejected).
  const rawDrift = ss?.maxDriftMs;
  if (rawDrift !== undefined) {
    if (typeof rawDrift !== 'number' || !Number.isFinite(rawDrift)) {
      errors.push(`multiMachine.stateSync.maxDriftMs must be a finite number (got ${String(rawDrift)})`);
    } else if (rawDrift < MIN_MAX_DRIFT_MS || rawDrift > MAX_MAX_DRIFT_MS) {
      errors.push(
        `multiMachine.stateSync.maxDriftMs (${rawDrift}ms) must be within [${MIN_MAX_DRIFT_MS}, ${MAX_MAX_DRIFT_MS}]ms ` +
        `(the §3.4 bounded-drift clamp) — out-of-range is rejected, not silently coerced.`,
      );
    }
  }

  // 3. maxDriftMs > flush interval + propagation allowance (the non-vacuous bound).
  const floor = DEFAULT_FLUSH_INTERVAL_MS + DEFAULT_PROPAGATION_ALLOWANCE_MS;
  if (!(resolved.maxDriftMs > floor)) {
    errors.push(
      `multiMachine.stateSync.maxDriftMs (${resolved.maxDriftMs}ms) must be > flush interval + propagation allowance ` +
      `(${floor}ms) so the drift bound is never tighter than the journal's own flush+replicate latency.`,
    );
  }

  // 4. snapshot-cache ceilings positive (§8.2).
  if (!(resolved.maxCachedSnapshots > 0)) {
    errors.push(`multiMachine.stateSync.maxCachedSnapshots must be > 0 (got ${resolved.maxCachedSnapshots})`);
  }
  if (!(resolved.maxCacheBytes > 0)) {
    errors.push(`multiMachine.stateSync.maxCacheBytes must be > 0 (got ${resolved.maxCacheBytes})`);
  }

  return errors;
}

/**
 * Resolve + validate in one step, throwing StateSyncConfigError on any invariant
 * violation. Use at server startup so a bad config is rejected loudly rather
 * than degrading silently (mirrors assertSeamlessnessInvariants).
 */
export function assertStateSyncInvariants(mm?: MultiMachineConfig): ResolvedStateSyncConfig {
  const errors = validateStateSyncInvariants(mm);
  if (errors.length > 0) {
    throw new StateSyncConfigError(
      `Invalid multiMachine.stateSync config — refusing to start:\n` +
      errors.map((e) => `  • ${e}`).join('\n'),
    );
  }
  return resolveStateSyncConfig(mm);
}

/** Re-export the drift-clamp constants for callers/tests that assert the range. */
export { DEFAULT_MAX_DRIFT_MS, MIN_MAX_DRIFT_MS, MAX_MAX_DRIFT_MS };
