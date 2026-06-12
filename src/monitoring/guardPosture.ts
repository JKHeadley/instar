/**
 * guardPosture — the SINGLE shared definition of "what is a guard and what
 * does the config say about it" (GUARD-POSTURE-ENDPOINT-SPEC §2.1).
 *
 * Consumed by BOTH the boot-time GuardPostureTripwire (transition alarms) and
 * the GET /guards endpoint (steady-state readability). Never re-derive this
 * extraction elsewhere — the SafeGitExecutor single-funnel lesson: two copies
 * of "what counts as a guard" WILL drift, and the drifted one is always the
 * one watching when the next Mini incident happens.
 *
 * Also home of resolveGuardConfigSnapshot(): the one-disk-read resolved-config
 * snapshot the endpoint derives everything from. Disk, not the in-memory
 * config object, because the original incident (2026-06-05) was an emergency
 * DIRECT DISK EDIT invisible to in-memory config until restart.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getInitDefaults, type AgentType } from '../config/ConfigDefaults.js';
import { resolveDevAgentGate } from '../core/devAgentGate.js';
import { DEV_GATED_FEATURES, getConfigByPath } from '../core/devGatedFeatures.js';

export type GuardPosture = Record<string, boolean>;

export interface GuardPostureDiff {
  /** Guards that were enabled last boot and are disabled now. */
  disabled: string[];
  /** Guards that were disabled last boot and are enabled now. */
  enabled: string[];
}

/** Posture keys whose false→true transition is COST-INCREASING and must be
 *  surfaced as loudly as a guard-disable (FABLE-MODEL-ESCALATION-SPEC §10). */
export const COST_INCREASING_ENABLE_KEYS: ReadonlySet<string> = new Set([
  'models.tierEscalation.enabled',
]);

/**
 * Extract the guard posture from a resolved config object.
 *
 * Covered surface (generic by design — a future guard is covered the moment
 * it follows the `monitoring.<key>.enabled` convention, with no change here):
 *   - `monitoring.<key>.enabled` (boolean) → `monitoring.<key>.enabled`
 *   - `monitoring.<key>` (plain boolean)   → `monitoring.<key>`
 *   - `scheduler.enabled` (boolean)        → `scheduler.enabled`
 *   - `models.tierEscalation.{enabled,dryRun}`
 */
export function extractGuardPosture(config: unknown): GuardPosture {
  const posture: GuardPosture = {};
  if (!config || typeof config !== 'object') return posture;
  const cfg = config as Record<string, unknown>;

  const monitoring = cfg.monitoring;
  if (monitoring && typeof monitoring === 'object' && !Array.isArray(monitoring)) {
    for (const [key, value] of Object.entries(monitoring as Record<string, unknown>)) {
      if (typeof value === 'boolean') {
        posture[`monitoring.${key}`] = value;
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        const enabled = (value as Record<string, unknown>).enabled;
        if (typeof enabled === 'boolean') posture[`monitoring.${key}.enabled`] = enabled;
      }
    }
  }

  const scheduler = cfg.scheduler;
  if (scheduler && typeof scheduler === 'object' && !Array.isArray(scheduler)) {
    const enabled = (scheduler as Record<string, unknown>).enabled;
    if (typeof enabled === 'boolean') posture['scheduler.enabled'] = enabled;
  }

  // Model-tier escalation (FABLE-MODEL-ESCALATION-SPEC §10): a COST-INCREASING
  // enable gets the same visibility as a guard-disable, and a dryRun-off flip
  // is the moment real swaps start — both are posture.
  const models = cfg.models;
  if (models && typeof models === 'object' && !Array.isArray(models)) {
    const tierEscalation = (models as Record<string, unknown>).tierEscalation;
    if (tierEscalation && typeof tierEscalation === 'object' && !Array.isArray(tierEscalation)) {
      const te = tierEscalation as Record<string, unknown>;
      if (typeof te.enabled === 'boolean') posture['models.tierEscalation.enabled'] = te.enabled;
      if (typeof te.dryRun === 'boolean') posture['models.tierEscalation.dryRun'] = te.dryRun;
    }
  }

  return posture;
}

/**
 * Diff two postures. Only keys present in BOTH snapshots can transition —
 * a key appearing for the first time (new feature) or vanishing (config
 * cleanup) is a shape change, not a guard flip, and raises nothing.
 */
export function diffGuardPosture(prev: GuardPosture, cur: GuardPosture): GuardPostureDiff {
  const disabled: string[] = [];
  const enabled: string[] = [];
  for (const key of Object.keys(cur).sort()) {
    if (!(key in prev)) continue;
    if (prev[key] === true && cur[key] === false) disabled.push(key);
    else if (prev[key] === false && cur[key] === true) enabled.push(key);
  }
  return { disabled, enabled };
}

// ── Boot snapshot (written by the tripwire at every boot, read by /guards
//    for diverged-pending-restart derivation) ──

export interface GuardPostureBootSnapshot {
  ts: string;
  posture: GuardPosture;
}

export function guardPostureSnapshotPath(stateDir: string): string {
  return path.join(stateDir, 'state', 'guard-posture.json');
}

/** Read the tripwire's boot-time posture snapshot. null = absent/corrupt —
 *  callers degrade to `divergence: "snapshot-unavailable"`, never invent. */
export function readGuardPostureBootSnapshot(stateDir: string): GuardPostureBootSnapshot | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(guardPostureSnapshotPath(stateDir), 'utf-8'),
    ) as GuardPostureBootSnapshot;
    if (parsed && typeof parsed === 'object' && parsed.posture && typeof parsed.posture === 'object') {
      return parsed;
    }
    return null;
  } catch {
    // @silent-fallback-ok — absent or corrupt snapshot degrades to
    // snapshot-unavailable honesty downstream; the tripwire repairs the file
    // at next boot.
    return null;
  }
}

// ── Resolved-config snapshot (GUARD-POSTURE-ENDPOINT-SPEC §2.1/§2.2) ──

export interface ResolvedGuardConfigSnapshot {
  /** Defaults + on-disk file deep-merged, dev gates resolved. The ONLY object
   *  posture derivation reads config from. */
  resolved: Record<string, unknown>;
  /** Defaults alone (same agent type, dev gates resolved against the merged
   *  config's developmentAgent) — the baseline for offClass classification. */
  defaults: Record<string, unknown>;
  /** True when `.instar/config.json` was absent (a defaults-only snapshot). */
  fileAbsent: boolean;
  /** Set when the file existed but could not be read/parsed. The caller must
   *  surface this as a top-level error — never an empty-truthful inventory. */
  readError?: string;
}

function deepMergeInto(target: Record<string, unknown>, source: Record<string, unknown>, depth = 0): void {
  for (const key of Object.keys(source)) {
    if (
      depth < 64 &&
      typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key]) &&
      typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])
    ) {
      deepMergeInto(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>, depth + 1);
    } else {
      // Past the sanity depth a subtree is replaced wholesale — a config
      // nested >64 levels is not a real agent config, and unbounded
      // recursion on hostile input is a stack-overflow vector.
      target[key] = structuredClone(source[key]);
    }
  }
}

function setConfigByPath(config: Record<string, unknown>, dottedPath: string, value: unknown): void {
  const keys = dottedPath.split('.');
  let cur = config;
  for (const key of keys.slice(0, -1)) {
    const next = cur[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

/**
 * Read the on-disk agent config ONCE and resolve it the way the server would:
 * shared defaults (by agent type) + file deep-merged on top + every
 * DEV_GATED_FEATURES `enabled` resolved via resolveDevAgentGate (their
 * convention is to OMIT `enabled` and let the gate decide).
 *
 * EXACTLY ONE fs read of config.json per call — the endpoint calls this once
 * per request (Tier-1 pinned), never per guard.
 */
export function resolveGuardConfigSnapshot(
  projectDir: string,
  opts?: { agentType?: AgentType },
): ResolvedGuardConfigSnapshot {
  const configPath = path.join(projectDir, '.instar', 'config.json');

  let fileRaw: Record<string, unknown> | null = null;
  let fileAbsent = true;
  let readError: string | undefined;
  try {
    const text = fs.readFileSync(configPath, 'utf-8');
    fileAbsent = false;
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      fileRaw = parsed as Record<string, unknown>;
    } else {
      readError = `config.json parsed to a non-object (${Array.isArray(parsed) ? 'array' : typeof parsed})`;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      fileAbsent = true; // defaults-only snapshot — valid, not an error
    } else {
      fileAbsent = false;
      readError = err instanceof Error ? err.message : String(err);
    }
  }

  const agentType: AgentType =
    opts?.agentType ??
    ((fileRaw?.agentType === 'standalone' ? 'standalone' : 'managed-project') as AgentType);

  const defaults = getInitDefaults(agentType);
  const resolved = structuredClone(defaults);
  if (fileRaw) deepMergeInto(resolved, fileRaw);

  // Dev-gated features deliberately omit `enabled` from defaults; the runtime
  // resolves them via the dev-agent gate. Mirror that here so a dev-gated
  // guard appears with its gate-resolved value (spec §2.1) — in BOTH the
  // resolved view and the defaults baseline (the gate IS the default).
  const gateSource = { developmentAgent: (resolved as { developmentAgent?: boolean }).developmentAgent };
  for (const feature of DEV_GATED_FEATURES) {
    const explicit = getConfigByPath(resolved, feature.configPath);
    const effective = resolveDevAgentGate(
      typeof explicit === 'boolean' ? explicit : undefined,
      gateSource,
    );
    setConfigByPath(resolved, feature.configPath, effective);
    const explicitDefault = getConfigByPath(defaults, feature.configPath);
    if (typeof explicitDefault !== 'boolean') {
      setConfigByPath(defaults, feature.configPath, resolveDevAgentGate(undefined, gateSource));
    }
  }

  return { resolved, defaults, fileAbsent, readError };
}
