/**
 * GuardPostureTripwire — a disabled guard is itself an incident.
 *
 * Triggering incident (2026-06-05): the meltdown load-shed at 2:54 PM PDT
 * batch-flipped a set of monitoring guards off in `.instar/config.json` —
 * scheduler.enabled (issue #882), contextWedgeSentinel, failureLearning,
 * resourceLedger, burnDetection. Only the scheduler was noticed and
 * re-enabled (5.5h later); the wedge sentinel stayed dark and watched the
 * EXO 3.0 AUP-rejection wedge kill a session for an hour THAT SAME EVENING
 * without a single audit row. No instar code writes those flags — the flip
 * was emergency hand-editing — so nothing structural recorded it. Two
 * silently-disabled guards discovered in one day is a class, not a
 * coincidence.
 *
 * The tripwire: at every server boot, compare the resolved guard posture
 * (every monitoring.* enabled flag + scheduler.enabled) against the persisted
 * posture from the previous boot. Any guard that went enabled→disabled gets:
 *   1. a loud boot log line,
 *   2. one JSONL breadcrumb row in `logs/guard-posture.jsonl` (same home as
 *      sentinel-events.jsonl — the documented "why did X stop?" surface),
 *   3. ONE aggregated Attention item listing every newly-disabled guard
 *      (aggregate per the Bounded Notification Surface rule — never one
 *      item per guard).
 * Re-enabled guards get the log line + breadcrumb only (good news is not a
 * to-do). First boot (no snapshot) records the posture and raises nothing.
 *
 * Signal-vs-authority: pure detector. It never re-enables anything, never
 * blocks a boot, never edits config — a deliberate disable stays disabled;
 * the Attention item is the consent surface where the operator either
 * acknowledges the flip or goes and re-enables the guard. Errors are
 * swallowed into the log: a broken tripwire must never break a boot.
 */

import fs from 'node:fs';
import path from 'node:path';

export type GuardPosture = Record<string, boolean>;

export interface GuardPostureDiff {
  /** Guards that were enabled last boot and are disabled now. */
  disabled: string[];
  /** Guards that were disabled last boot and are enabled now. */
  enabled: string[];
}

export interface AttentionItemInput {
  id: string;
  title: string;
  summary: string;
  description?: string;
  category: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  sourceContext?: string;
}

export interface GuardPostureTripwireOpts {
  /** The RESOLVED config object the server is booting with. */
  config: unknown;
  /** Agent state dir (`<projectDir>/.instar`) — snapshot lives at `state/guard-posture.json`. */
  stateDir: string;
  /** Logs dir (`<projectDir>/logs`) — breadcrumb lives at `guard-posture.jsonl`. */
  logsDir: string;
  /** Aggregated Attention emit; absent (no Telegram) → breadcrumb-only. */
  emitAttention?: (item: AttentionItemInput) => Promise<void>;
  /** Boot logger (default console.log). */
  log?: (msg: string) => void;
  /** Clock override (tests). */
  now?: () => Date;
}

export interface GuardPostureTripwireResult {
  firstBoot: boolean;
  disabled: string[];
  enabled: string[];
  attentionEmitted: boolean;
  /** Non-fatal error message when the tripwire degraded (never throws). */
  error?: string;
}

/**
 * Extract the guard posture from a resolved config object.
 *
 * Covered surface (generic by design — a future guard is covered the moment
 * it follows the `monitoring.<key>.enabled` convention, with no tripwire
 * change):
 *   - `monitoring.<key>.enabled` (boolean) → `monitoring.<key>.enabled`
 *   - `monitoring.<key>` (plain boolean)   → `monitoring.<key>`
 *   - `scheduler.enabled` (boolean)        → `scheduler.enabled`
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

interface Snapshot {
  ts: string;
  posture: GuardPosture;
}

function snapshotPath(stateDir: string): string {
  return path.join(stateDir, 'state', 'guard-posture.json');
}

function breadcrumbPath(logsDir: string): string {
  return path.join(logsDir, 'guard-posture.jsonl');
}

/** Run the tripwire once at boot. Never throws. */
export async function runGuardPostureTripwire(
  opts: GuardPostureTripwireOpts,
): Promise<GuardPostureTripwireResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const now = (opts.now ?? (() => new Date()))();
  const result: GuardPostureTripwireResult = {
    firstBoot: false,
    disabled: [],
    enabled: [],
    attentionEmitted: false,
  };

  try {
    const posture = extractGuardPosture(opts.config);
    const snapPath = snapshotPath(opts.stateDir);

    let prev: Snapshot | null = null;
    if (fs.existsSync(snapPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(snapPath, 'utf-8')) as Snapshot;
        if (parsed && typeof parsed === 'object' && parsed.posture && typeof parsed.posture === 'object') {
          prev = parsed;
        }
      } catch {
        // @silent-fallback-ok — a corrupt snapshot degrades to first-boot
        // semantics (re-baseline, no alarms); the new write below repairs it.
      }
    }

    // Persist the new snapshot FIRST so even an emit failure below leaves the
    // baseline current (no repeat alarms for the same transition next boot).
    fs.mkdirSync(path.dirname(snapPath), { recursive: true });
    fs.writeFileSync(snapPath, JSON.stringify({ ts: now.toISOString(), posture } satisfies Snapshot, null, 2));

    if (!prev) {
      result.firstBoot = true;
      log(`[guard-posture] baseline recorded (${Object.keys(posture).length} guards)`);
      return result;
    }

    const diff = diffGuardPosture(prev.posture, posture);
    result.disabled = diff.disabled;
    result.enabled = diff.enabled;
    if (diff.disabled.length === 0 && diff.enabled.length === 0) return result;

    // Breadcrumb — one aggregated row per boot that saw transitions.
    try {
      fs.mkdirSync(path.dirname(breadcrumbPath(opts.logsDir)), { recursive: true });
      fs.appendFileSync(
        breadcrumbPath(opts.logsDir),
        JSON.stringify({
          ts: now.toISOString(),
          kind: 'guard-posture-change',
          disabled: diff.disabled,
          enabled: diff.enabled,
          prevTs: prev.ts,
        }) + '\n',
      );
    } catch (err) {
      result.error = `breadcrumb append failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    for (const key of diff.enabled) log(`[guard-posture] guard re-enabled since last boot: ${key}`);
    for (const key of diff.disabled) log(`[guard-posture] ⚠ GUARD DISABLED since last boot: ${key}`);

    if (diff.disabled.length > 0 && opts.emitAttention) {
      const list = diff.disabled.join(', ');
      try {
        await opts.emitAttention({
          id: `guard-posture-disabled:${now.toISOString().slice(0, 10)}:${diff.disabled.join(',')}`,
          title: `${diff.disabled.length} monitoring guard(s) disabled since last boot`,
          summary:
            `These guards were ON at the previous server boot and are OFF now: ${list}. ` +
            `Nothing in instar code flips these flags — this was a config edit. ` +
            `If it was deliberate (e.g. load-shedding), acknowledge this item; otherwise re-enable them in .instar/config.json. ` +
            `History: logs/guard-posture.jsonl.`,
          category: 'monitoring',
          priority: 'HIGH',
          sourceContext: 'guard-posture-tripwire',
        });
        result.attentionEmitted = true;
      } catch (err) {
        result.error = `attention emit failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return result;
  } catch (err) {
    // A broken tripwire must never break a boot.
    result.error = err instanceof Error ? err.message : String(err);
    log(`[guard-posture] tripwire degraded: ${result.error}`);
    return result;
  }
}
