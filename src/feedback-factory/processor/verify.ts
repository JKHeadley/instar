/**
 * verify.ts — TS port of the feedback-factory fix-verification logic.
 *
 * Byte-exact port of `can_transition_to_verified` (:1084) from the reference
 * `the-portal/.claude/scripts/feedback-processor.py`. Decides whether a fixed
 * cluster has actually stayed fixed (so it may transition to `verified`), via two
 * strategies: version-anchored (HIGH confidence — no recurrence on the fixed
 * version) and silence-based (LOW confidence — quiet long enough relative to its
 * historical report frequency).
 *
 * The reference is time- and DB-dependent (`datetime.now()` + a recent-reports
 * query). This port keeps it PURE by INJECTING both: `now` and the version-
 * anchored query result (`recentReportsSinceFix`) are passed in by the caller
 * (the real store adapter does `datetime.now()` + the query). Parity is verified
 * by monkeypatching the reference's `datetime.now` + `run_prisma_query` to the
 * same fixed values.
 */

import type { Cluster } from './types.js';

export interface VerifyOptions {
  /** Injected "now" (ISO string). The reference uses datetime.now(timezone.utc). */
  now: string;
  /**
   * The version-anchored recent-reports query result (items with the cluster's
   * fingerprint received since fixAppliedAt). Only consulted when the cluster has
   * BOTH fixedInVersion and fingerprint. The real adapter runs the query; tests
   * inject it. Treated as empty when omitted.
   */
  recentReportsSinceFix?: unknown[];
}

export interface VerifyResult {
  allowed: boolean;
  evidence: string;
  recommendation?: string;
  confidence?: string;
  verified_by?: string;
}

/** Reproduce Python `f"{x:.0f}"` — round-half-to-even to an integer, as a string. */
export function pyFormat0f(x: number): string {
  const floor = Math.floor(x);
  const diff = x - floor;
  let r: number;
  if (diff > 0.5) r = floor + 1;
  else if (diff < 0.5) r = floor;
  else r = floor % 2 === 0 ? floor : floor + 1;
  return String(r);
}

/** Parse an ISO timestamp to epoch ms (mirrors datetime.fromisoformat(s.replace('Z','+00:00'))). */
function parseIso(s: string): number {
  return new Date(s).getTime();
}

export function canTransitionToVerified(cluster: Cluster, opts: VerifyOptions): VerifyResult {
  const fingerprint = cluster.fingerprint;
  const fixedVersion = cluster.fixedInVersion;
  // Fall back to dispatchedAt when fixAppliedAt is missing (reference comment:
  // dispatch happens after the fix is applied, so it's a safe proxy timestamp).
  const fixAppliedAt = cluster.fixAppliedAt || cluster.dispatchedAt;

  if (!fixAppliedAt) {
    return {
      allowed: false,
      evidence: 'No fixAppliedAt or dispatchedAt timestamp',
      recommendation: 'set_fix_applied_at',
    };
  }

  const nowMs = parseIso(opts.now);
  const fixTimeMs = parseIso(fixAppliedAt);
  const hoursSinceFix = (nowMs - fixTimeMs) / 1000 / 3600;

  // Strategy 1: Version-anchored (HIGH confidence).
  if (fixedVersion && fingerprint) {
    const recentItems = opts.recentReportsSinceFix ?? [];
    if (recentItems.length > 0) {
      return { allowed: false, evidence: `Still seeing ${recentItems.length} reports since fix`, recommendation: 'revert_to_investigating' };
    }
    if (hoursSinceFix >= 24) {
      return {
        allowed: true,
        evidence: `No recurrence on v${fixedVersion}+ in ${pyFormat0f(hoursSinceFix)}h`,
        confidence: 'high',
        verified_by: `auto:version_check:v${fixedVersion}`,
      };
    }
  }

  // Strategy 2: Silence-based (LOW confidence).
  const createdAt = cluster.createdAt as string;
  const firstSeenMs = parseIso(createdAt);
  const lastSeenStr = (cluster.updatedAt as string) ?? createdAt;
  const lastSeenMs = parseIso(lastSeenStr);
  const reportCount = (cluster.reportCount as number) ?? 1;

  const spanHours = (lastSeenMs - firstSeenMs) / 1000 / 3600;
  const freqHours = (spanHours < 1 || reportCount < 2) ? 24.0 : spanHours / Math.max(reportCount - 1, 1);
  const silenceRequired = Math.max(freqHours * 3, 48);

  if (hoursSinceFix < silenceRequired) {
    return { allowed: false, evidence: `Only ${pyFormat0f(hoursSinceFix)}h since fix, need ${pyFormat0f(silenceRequired)}h`, recommendation: 'wait' };
  }

  return {
    allowed: true,
    evidence: `No recurrence in ${pyFormat0f(hoursSinceFix)}h (required: ${pyFormat0f(silenceRequired)}h)`,
    confidence: 'low',
    verified_by: 'auto:silence_check',
  };
}
