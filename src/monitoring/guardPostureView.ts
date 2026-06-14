/**
 * guardPostureView — honest effective-state derivation + strict output
 * projection for GET /guards (GUARD-POSTURE-ENDPOINT-SPEC §2.2).
 *
 * Pure logic, no I/O: callers hand in the one-read resolved-config snapshot,
 * the tripwire's boot posture snapshot, and a GuardRegistry; this module
 * derives one closed-vocabulary state per guard via the spec's NORMATIVE
 * PRECEDENCE TABLE (first match wins) and emits ONLY the closed field set —
 * the route never spreads source config/runtime objects (several guard
 * config blocks carry operationally sensitive values; getters are untrusted
 * producers, this projection is the authority).
 */

import {
  GUARD_MANIFEST,
  type GuardManifestEntry,
} from './guardManifest.js';
import { getConfigByPath } from '../core/devGatedFeatures.js';
import {
  extractGuardPosture,
  type GuardPostureBootSnapshot,
  type ResolvedGuardConfigSnapshot,
} from './guardPosture.js';
import type { GuardRegistry, GuardRuntimeRead } from './GuardRegistry.js';

export type GuardEffectiveState =
  | 'on-confirmed'
  | 'on-unverified'
  | 'on-stale'
  | 'on-dry-run'
  | 'off'
  | 'diverged-pending-restart'
  | 'errored'
  | 'missing'
  | 'off-runtime-divergent';

export type GuardOffClass = 'dark-default' | 'diverged-from-default' | null;

export type GuardDivergence = 'none' | 'diverged' | 'not-applicable' | 'snapshot-unavailable';

/** Staleness multiplier over a guard's self-declared cadence (spec §2.2, N=5). */
export const STALE_TICK_MULTIPLIER = 5;

/** The CLOSED projection — every field a /guards row may carry. Anything not
 *  named here never leaves the server (Tier-1 allowlist test). */
export interface GuardRuntimeProjection {
  enabled: boolean;
  dryRun?: boolean;
  lastTickAt?: number;
  tickAgeMs?: number;
  stale?: boolean;
  jobCount?: number;
  pausedJobCount?: number;
}

export interface GuardRow {
  key: string;
  configEnabled: boolean | null;
  defaultEnabled: boolean | null;
  effective: GuardEffectiveState;
  offClass: GuardOffClass;
  divergence: GuardDivergence;
  runtime: GuardRuntimeProjection | null;
  runtimeReason?: 'not-instrumented' | 'status-error' | 'out-of-process' | 'not-registered';
  /** Normalized getter-error message (errored state only). */
  error?: string;
  process: 'server' | 'lifeline';
}

export interface GuardsSummary {
  onConfirmed: number;
  onUnverified: number;
  onStale: number;
  onDryRun: number;
  off: number;
  offDeviant: number;
  offDarkDefault: number;
  divergedPendingRestart: number;
  errored: number;
  missing: number;
  offRuntimeDivergent: number;
  runtimeEnriched: string; // "n/total"
}

export interface GuardInventoryResult {
  guards: GuardRow[];
  summary: GuardsSummary;
}

const ROW_FIELD_ALLOWLIST: ReadonlySet<string> = new Set([
  'key', 'configEnabled', 'defaultEnabled', 'effective', 'offClass',
  'divergence', 'runtime', 'runtimeReason', 'error', 'process',
]);
const RUNTIME_FIELD_ALLOWLIST: ReadonlySet<string> = new Set([
  'enabled', 'dryRun', 'lastTickAt', 'tickAgeMs', 'stale', 'jobCount', 'pausedJobCount',
]);
export { ROW_FIELD_ALLOWLIST, RUNTIME_FIELD_ALLOWLIST };

function asBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

interface DeriveInput {
  key: string;
  manifest: GuardManifestEntry | undefined;
  configEnabled: boolean | undefined;
  defaultEnabled: boolean | undefined;
  configDryRun: boolean | undefined;
  bootValue: boolean | undefined;
  bootSnapshotAvailable: boolean;
  runtime: GuardRuntimeRead;
  now: number;
}

/**
 * The normative precedence table (spec §2.2) — ONE state per guard, first
 * match wins:
 *   errored → missing → off-runtime-divergent → diverged-pending-restart →
 *   off → on-dry-run → on-stale → on-confirmed → on-unverified
 */
export function deriveGuardRow(input: DeriveInput): GuardRow {
  const { key, manifest, runtime, now } = input;
  const isCodeDefault = manifest?.kind === 'code-default';
  const configEnabled = input.configEnabled ?? (isCodeDefault ? manifest!.defaultEnabled : undefined);
  const defaultEnabled = input.defaultEnabled ?? manifest?.defaultEnabled;
  const process = manifest?.process ?? 'server';

  // ── Disk-vs-boot divergence classification (input to two states below) ──
  let divergence: GuardDivergence;
  if (isCodeDefault) {
    divergence = 'not-applicable';
  } else if (manifest?.liveConfig) {
    // Component re-reads config per use — a disk change is already live, the
    // diverged-pending-restart state would lie in the false-positive direction.
    divergence = 'none';
  } else if (!input.bootSnapshotAvailable || input.bootValue === undefined) {
    // Absent snapshot or older-inventory snapshot (key missing): suppressed
    // AND flagged — degraded honestly, never silently clean.
    divergence = 'snapshot-unavailable';
  } else if (configEnabled !== undefined && input.bootValue !== configEnabled) {
    divergence = 'diverged';
  } else {
    divergence = 'none';
  }

  // Runtime projection (closed fields only).
  let runtimeProjection: GuardRuntimeProjection | null = null;
  let runtimeReason: GuardRow['runtimeReason'];
  let error: string | undefined;
  if (process === 'lifeline') {
    // Out-of-process guards are config-derived ONLY (spec §2.1): the sync
    // in-memory getter contract cannot cross processes.
    runtimeReason = 'out-of-process';
  } else if (runtime.kind === 'ok') {
    const s = runtime.status;
    runtimeProjection = { enabled: s.enabled };
    if (typeof s.dryRun === 'boolean') runtimeProjection.dryRun = s.dryRun;
    if (typeof s.lastTickAt === 'number') {
      runtimeProjection.lastTickAt = s.lastTickAt;
      if (s.lastTickAt > 0) runtimeProjection.tickAgeMs = Math.max(0, now - s.lastTickAt);
    }
    if (typeof s.jobCount === 'number') runtimeProjection.jobCount = s.jobCount;
    if (typeof s.pausedJobCount === 'number') runtimeProjection.pausedJobCount = s.pausedJobCount;
  } else if (runtime.kind === 'error') {
    runtimeReason = 'status-error';
    error = runtime.message;
  } else {
    runtimeReason = manifest?.expectRuntime ? 'not-registered' : 'not-instrumented';
  }

  // Staleness only applies where the guard self-declares a cadence.
  let stale = false;
  if (
    runtime.kind === 'ok' &&
    runtime.status.enabled &&
    manifest?.expectedTickMs !== undefined
  ) {
    const lastTickAt = runtime.status.lastTickAt;
    if (!lastTickAt || lastTickAt <= 0) {
      stale = true; // constructed-but-never-ticking reports stale, never "on"
    } else if (now - lastTickAt > STALE_TICK_MULTIPLIER * manifest.expectedTickMs) {
      stale = true;
    }
  }
  if (runtimeProjection && manifest?.expectedTickMs !== undefined && runtime.kind === 'ok' && runtime.status.enabled) {
    runtimeProjection.stale = stale;
  }

  const dryRun =
    (runtime.kind === 'ok' ? asBool(runtime.status.dryRun) : undefined) ?? input.configDryRun ?? false;

  // ── Precedence table — first match wins ──
  let effective: GuardEffectiveState;
  let offClass: GuardOffClass = null;

  const diskDivergenceDetected = divergence === 'diverged';
  const noDetectedDiskDivergence = !diskDivergenceDetected; // snapshot-unavailable counts as none

  if (runtime.kind === 'error') {
    effective = 'errored';
  } else if (
    manifest?.expectRuntime === true &&
    process === 'server' &&
    configEnabled === true &&
    runtime.kind === 'unregistered' &&
    input.bootValue !== false
  ) {
    // Declared for this host, config says on, but no runtime registered at
    // boot (crash-before-register / unconfigured adapter): a STATE, never a
    // silent omission. The `bootValue !== false` clause keeps this honest: a
    // guard that was OFF at boot and flipped on-disk since was never expected
    // to construct — that case falls through to diverged-pending-restart,
    // which describes it truthfully (missing would be a false crash alarm).
    effective = 'missing';
  } else if (
    configEnabled === true &&
    runtime.kind === 'ok' &&
    runtime.status.enabled === false &&
    noDetectedDiskDivergence
  ) {
    // The in-memory load-shed class: config says ON, disk matches boot, but
    // the live runtime self-reports off — the strongest "the config is lying
    // to you" signal; never folds into on-unverified.
    effective = 'off-runtime-divergent';
  } else if (diskDivergenceDetected) {
    effective = 'diverged-pending-restart';
  } else if (configEnabled === false) {
    effective = 'off';
    offClass = defaultEnabled === false ? 'dark-default' : 'diverged-from-default';
  } else if (dryRun && configEnabled === true) {
    effective = 'on-dry-run'; // watching but toothless; stale stays visible in the runtime block
  } else if (stale) {
    effective = 'on-stale';
  } else if (runtime.kind === 'ok' && runtime.status.enabled) {
    effective = 'on-confirmed';
  } else {
    // Config on, no live runtime surface. NEVER counted or rendered as
    // confirmed-on — a guard that crashed mid-init lands here, and painting
    // it green is the Mini bug with extra steps.
    effective = 'on-unverified';
  }

  const row: GuardRow = {
    key,
    configEnabled: configEnabled ?? null,
    defaultEnabled: defaultEnabled ?? null,
    effective,
    offClass,
    divergence,
    runtime: runtimeProjection,
    process,
  };
  if (runtimeReason) row.runtimeReason = runtimeReason;
  if (error) row.error = error;
  return row;
}

/**
 * Assemble the full inventory: shared extractor (config-derived) ∪ declared
 * manifest, deduped by key, each row derived through the precedence table.
 */
export function buildGuardInventory(opts: {
  snapshot: ResolvedGuardConfigSnapshot;
  bootSnapshot: GuardPostureBootSnapshot | null;
  registry: GuardRegistry;
  now?: number;
}): GuardInventoryResult {
  const now = opts.now ?? Date.now();
  const extractedCurrent = extractGuardPosture(opts.snapshot.resolved);
  const extractedDefaults = extractGuardPosture(opts.snapshot.defaults);
  const manifestMap = new Map<string, GuardManifestEntry>();
  for (const entry of GUARD_MANIFEST) manifestMap.set(entry.key, entry);

  const keys = [...new Set([...Object.keys(extractedCurrent), ...manifestMap.keys()])].sort();

  const guards: GuardRow[] = [];
  for (const key of keys) {
    const manifest = manifestMap.get(key);

    let configEnabled = asBool(extractedCurrent[key]);
    let defaultEnabled = asBool(extractedDefaults[key]);
    if (configEnabled === undefined && manifest?.configPath) {
      configEnabled = asBool(getConfigByPath(opts.snapshot.resolved, manifest.configPath));
    }
    if (defaultEnabled === undefined && manifest?.configPath) {
      defaultEnabled = asBool(getConfigByPath(opts.snapshot.defaults, manifest.configPath));
    }
    if (defaultEnabled === undefined && manifest) defaultEnabled = manifest.defaultEnabled;
    // The resolved snapshot normally contains every default key (defaults are
    // merged in), but a degraded/partial snapshot must still yield the
    // default-resolved state — a guard can never drop out of the inventory.
    if (configEnabled === undefined) configEnabled = defaultEnabled;

    const configDryRun = manifest?.dryRunConfigPath
      ? asBool(getConfigByPath(opts.snapshot.resolved, manifest.dryRunConfigPath))
      : undefined;

    const bootPosture = opts.bootSnapshot?.posture;
    guards.push(
      deriveGuardRow({
        key,
        manifest,
        configEnabled,
        defaultEnabled,
        configDryRun,
        bootValue: bootPosture ? asBool(bootPosture[key]) : undefined,
        bootSnapshotAvailable: !!bootPosture,
        runtime: opts.registry.read(key),
        now,
      }),
    );
  }

  const summary: GuardsSummary = {
    onConfirmed: 0, onUnverified: 0, onStale: 0, onDryRun: 0,
    off: 0, offDeviant: 0, offDarkDefault: 0,
    divergedPendingRestart: 0, errored: 0, missing: 0, offRuntimeDivergent: 0,
    runtimeEnriched: '',
  };
  let enriched = 0;
  for (const g of guards) {
    if (g.runtime) enriched++;
    switch (g.effective) {
      case 'on-confirmed': summary.onConfirmed++; break;
      case 'on-unverified': summary.onUnverified++; break;
      case 'on-stale': summary.onStale++; break;
      case 'on-dry-run': summary.onDryRun++; break;
      case 'off':
        summary.off++;
        if (g.offClass === 'diverged-from-default') summary.offDeviant++;
        else summary.offDarkDefault++;
        break;
      case 'diverged-pending-restart': summary.divergedPendingRestart++; break;
      case 'errored': summary.errored++; break;
      case 'missing': summary.missing++; break;
      case 'off-runtime-divergent': summary.offRuntimeDivergent++; break;
    }
  }
  summary.runtimeEnriched = `${enriched}/${guards.length}`;

  return { guards, summary };
}

/** Compact posture block that rides the capacity heartbeat (spec §2.3).
 *  The wire shape lives in core/types.ts (GuardPostureSummary) so the
 *  heartbeat/pool layers don't import from monitoring; this alias keeps the
 *  spec's name for monitoring-side consumers. */
export type HeartbeatGuardPosture = import('../core/types.js').GuardPostureSummary;

export function buildHeartbeatPostureBlock(
  inventory: GuardInventoryResult,
  generatedAt: string,
): HeartbeatGuardPosture {
  const offDeviantKeys = inventory.guards
    .filter(g => g.effective === 'off' && g.offClass === 'diverged-from-default')
    .map(g => g.key);
  const offRuntimeDivergentKeys = inventory.guards
    .filter(g => g.effective === 'off-runtime-divergent')
    .map(g => g.key);
  const s = inventory.summary;
  return {
    onConfirmed: s.onConfirmed,
    onUnverified: s.onUnverified,
    onStale: s.onStale,
    onDryRun: s.onDryRun,
    offDeviant: s.offDeviant,
    offDeviantKeys,
    offRuntimeDivergent: s.offRuntimeDivergent,
    offRuntimeDivergentKeys,
    divergedPendingRestart: s.divergedPendingRestart,
    errored: s.errored,
    missing: s.missing,
    generatedAt,
  };
}
