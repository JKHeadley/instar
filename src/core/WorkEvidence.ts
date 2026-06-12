/**
 * WorkEvidence — the exact evidence vocabulary for mid-work reap tagging.
 *
 * Spec: docs/specs/reap-notify-per-topic-and-midwork-resume-queue.md (R2.1/R2.2).
 *
 * Killers supply evidence at THEIR decision point (the only moment the work
 * was observable — e.g. the quota-shed migrator computes it BEFORE its Ctrl+C
 * grace round tears the work down). The single kill chokepoint
 * (`SessionManager.terminateSession`) clamps whatever arrives to this enum —
 * unknown names are dropped, not stored — so the vocabulary cannot drift per
 * killer.
 *
 * Classes:
 *  - strong: direct positive evidence of in-flight work; any one makes a reap
 *    resume-eligible (R2.2).
 *  - weak: circumstantial (gameable with one child process, or merely "the
 *    user was around"); only ≥2 DISTINCT weak signals on a topic-bound
 *    session reach eligibility.
 *  - marker: not evidence at all — a record that verification was SKIPPED
 *    (pressure tier critical ⇒ fork-based closures not run). Never eligible.
 */

export const STRONG_WORK_EVIDENCE = [
  'build-or-autonomous-active',
  'active-subagent',
  'pending-injection',
  'open-commitment',
  'structural-long-work',
] as const;

export const WEAK_WORK_EVIDENCE = [
  'active-process',
  'main-process-active',
  'recent-user-message',
  'relay-lease',
] as const;

export const MARKER_WORK_EVIDENCE = ['unverified-under-pressure'] as const;

export type StrongWorkEvidence = (typeof STRONG_WORK_EVIDENCE)[number];
export type WeakWorkEvidence = (typeof WEAK_WORK_EVIDENCE)[number];
export type MarkerWorkEvidence = (typeof MARKER_WORK_EVIDENCE)[number];
export type WorkEvidenceName = StrongWorkEvidence | WeakWorkEvidence | MarkerWorkEvidence;

const ALL_EVIDENCE: ReadonlySet<string> = new Set([
  ...STRONG_WORK_EVIDENCE,
  ...WEAK_WORK_EVIDENCE,
  ...MARKER_WORK_EVIDENCE,
]);

const STRONG_SET: ReadonlySet<string> = new Set(STRONG_WORK_EVIDENCE);
const WEAK_SET: ReadonlySet<string> = new Set(WEAK_WORK_EVIDENCE);
const MARKER_SET: ReadonlySet<string> = new Set(MARKER_WORK_EVIDENCE);

/**
 * Clamp killer-supplied evidence to the enum (R2.1): unknown names are
 * DROPPED (never stored), non-strings dropped, duplicates collapsed. Applied
 * INSIDE the chokepoint regardless of which killer supplied the values.
 */
export function clampWorkEvidence(names: unknown): WorkEvidenceName[] {
  if (!Array.isArray(names)) return [];
  const out: WorkEvidenceName[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    if (typeof n !== 'string') continue;
    if (!ALL_EVIDENCE.has(n)) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n as WorkEvidenceName);
  }
  return out;
}

/** midWork = any non-marker evidence (R2.1). */
export function isMidWork(evidence: readonly string[]): boolean {
  return evidence.some((e) => ALL_EVIDENCE.has(e) && !MARKER_SET.has(e));
}

export function strongEvidence(evidence: readonly string[]): WorkEvidenceName[] {
  return evidence.filter((e): e is StrongWorkEvidence => STRONG_SET.has(e));
}

export function weakEvidence(evidence: readonly string[]): WorkEvidenceName[] {
  return evidence.filter((e): e is WeakWorkEvidence => WEAK_SET.has(e));
}

/**
 * Resume eligibility (R2.2), evidence half: ≥1 strong signal, OR (when the
 * session is topic-bound) ≥2 distinct weak signals. Weak-alone (un-bound or
 * a single weak signal) never qualifies. Markers never count.
 */
export function evidenceEligible(evidence: readonly string[], topicBound: boolean): boolean {
  if (strongEvidence(evidence).length >= 1) return true;
  if (topicBound && weakEvidence(evidence).length >= 2) return true;
  return false;
}
