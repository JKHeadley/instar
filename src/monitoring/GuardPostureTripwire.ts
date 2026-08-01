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
import {
  buildCompleteGuardPosture,
  COST_INCREASING_ENABLE_KEYS,
  diffGuardPosture,
  extractGuardPosture,
  guardPostureSnapshotPath,
  type GuardPosture,
  type GuardPostureBootSnapshot,
  type GuardPostureCoverage,
  type GuardPostureDiff,
} from './guardPosture.js';

// The extraction/diff logic lives in the SHARED guardPosture module
// (GUARD-POSTURE-ENDPOINT-SPEC §2.1 single-funnel rule: one definition of
// "what is a guard", consumed by both this tripwire and GET /guards).
// Re-exported here so existing importers keep working unchanged.
export { buildCompleteGuardPosture, COST_INCREASING_ENABLE_KEYS, diffGuardPosture, extractGuardPosture };
export type { GuardPosture, GuardPostureCoverage, GuardPostureDiff };

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
  /** Resolved defaults for the same agent. Used when a guard is newly enrolled
   *  so a pre-existing default-ON/config-OFF posture is not silently baselined. */
  defaultConfig?: unknown;
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
  newlyTrackedDisabled: string[];
  newlyTrackedEnabled: string[];
  coverage: GuardPostureCoverage;
  attentionEmitted: boolean;
  /** Non-fatal error message when the tripwire degraded (never throws). */
  error?: string;
}

type Snapshot = GuardPostureBootSnapshot;

const snapshotPath = guardPostureSnapshotPath;

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
    newlyTrackedDisabled: [],
    newlyTrackedEnabled: [],
    coverage: { watched: 0, configDerived: 0, manifestDeclared: 0, overlap: 0 },
    attentionEmitted: false,
  };

  try {
    const complete = buildCompleteGuardPosture(opts.config);
    const posture = complete.posture;
    result.coverage = complete.coverage;
    const defaultPosture = buildCompleteGuardPosture(opts.defaultConfig).posture;
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
    const snapshot: Snapshot = { ts: now.toISOString(), posture, coverage: complete.coverage };
    /* state-registry: guard-posture-snapshot */
    fs.writeFileSync(snapPath, JSON.stringify(snapshot, null, 2));

    if (!prev) {
      result.firstBoot = true;
      log(
        `[guard-posture] baseline recorded (watching ${complete.coverage.watched} guards: ` +
        `${complete.coverage.configDerived} config-derived + ${complete.coverage.manifestDeclared} manifest ` +
        `- ${complete.coverage.overlap} overlap)`,
      );
      return result;
    }

    const diff = diffGuardPosture(prev.posture, posture, defaultPosture);
    result.disabled = diff.disabled;
    result.enabled = diff.enabled;
    result.newlyTrackedDisabled = diff.newlyTrackedDisabled;
    result.newlyTrackedEnabled = diff.newlyTrackedEnabled;
    if (diff.disabled.length === 0 && diff.enabled.length === 0) return result;

    log(
      `[guard-posture] posture incidents detected across ${complete.coverage.watched} watched guards ` +
      `(disabled=${diff.disabled.length}/${complete.coverage.watched}, ` +
      `enabled=${diff.enabled.length}/${complete.coverage.watched})`,
    );

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
          newlyTrackedDisabled: diff.newlyTrackedDisabled,
          newlyTrackedEnabled: diff.newlyTrackedEnabled,
          prevTs: prev.ts,
          previousWatched: prev.coverage?.watched ?? Object.keys(prev.posture).length,
          coverage: complete.coverage,
        }) + '\n',
      );
    } catch (err) {
      result.error = `breadcrumb append failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    const newlyEnabled = new Set(diff.newlyTrackedEnabled);
    const newlyDisabled = new Set(diff.newlyTrackedDisabled);
    for (const key of diff.enabled) {
      log(newlyEnabled.has(key)
        ? `[guard-posture] newly watched default-OFF guard found ON: ${key}`
        : `[guard-posture] guard re-enabled since last boot: ${key}`);
    }
    for (const key of diff.disabled) {
      log(newlyDisabled.has(key)
        ? `[guard-posture] ⚠ newly watched default-ON guard found OFF: ${key}`
        : `[guard-posture] ⚠ GUARD DISABLED since last boot: ${key}`);
    }

    if (diff.disabled.length > 0 && opts.emitAttention) {
      const list = diff.disabled.join(', ');
      const existingDisabled = diff.disabled.filter(k => !diff.newlyTrackedDisabled.includes(k));
      const transitionText = existingDisabled.length > 0
        ? `${existingDisabled.join(', ')} were ON at the previous server boot and are OFF now. `
        : '';
      const enrollmentText = diff.newlyTrackedDisabled.length > 0
        ? `${diff.newlyTrackedDisabled.join(', ')} are newly watched and are OFF against their resolved ON default. `
        : '';
      try {
        await opts.emitAttention({
          id: `guard-posture-disabled:${now.toISOString().slice(0, 10)}:${diff.disabled.join(',')}`,
          title: `${diff.disabled.length} of ${complete.coverage.watched} watched guard(s) disabled`,
          summary:
            `Disabled guards: ${list}. ${transitionText}${enrollmentText}` +
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

    // Cost-increasing ENABLES get the same visibility as a guard-disable
    // (FABLE-MODEL-ESCALATION-SPEC §10): flipping model-tier escalation ON
    // roughly doubles the per-token cost of escalated work, so the flip must
    // be as loud as turning a guard off.
    const costIncreasing = diff.enabled.filter(k => COST_INCREASING_ENABLE_KEYS.has(k));
    if (costIncreasing.length > 0 && opts.emitAttention) {
      const list = costIncreasing.join(', ');
      const newlyTrackedCost = costIncreasing.filter(k => newlyEnabled.has(k));
      const transitionedCost = costIncreasing.filter(k => !newlyEnabled.has(k));
      const transitionedCostText = transitionedCost.length > 0
        ? `${transitionedCost.join(', ')} were OFF at the previous server boot and are ON now. `
        : '';
      const newlyTrackedCostText = newlyTrackedCost.length > 0
        ? `${newlyTrackedCost.join(', ')} are newly watched and are ON against their resolved OFF default. `
        : '';
      try {
        await opts.emitAttention({
          id: `guard-posture-cost-enable:${now.toISOString().slice(0, 10)}:${costIncreasing.join(',')}`,
          title: `${costIncreasing.length} of ${complete.coverage.watched} watched cost-increasing feature(s) enabled`,
          summary:
            `Enabled cost-increasing flags: ${list}. ${transitionedCostText}${newlyTrackedCostText}` +
            `Model-tier escalation routes eligible work to the ultra model (~2x cost). ` +
            `If this was deliberate, acknowledge this item; otherwise flip it back in .instar/config.json. ` +
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
