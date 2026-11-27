/**
 * Floor — the deterministic evidence floor of the Skill Learning Sentinel
 * (docs/specs/skill-learning-sentinel.md §3.3, decision class `invariant`).
 *
 * The floor is count-based and has NO time bound (a quarterly request is still
 * a recurrence). It is never widened by a model: everything above it is a
 * judgment (the default rung and the arbiter, see Arbiter.ts); below it nothing
 * else runs. Three conditions, all deterministic:
 *
 *   1. at least `floor.minOccurrences` VERIFIED occurrences of the key
 *      (asserted-identity and unverified-catchup rows count toward recurrence
 *      support only — never toward the floor, §3.1);
 *   2. at least `floor.minCorroboratedCleanRuns` clean runs from verified rows,
 *      where one `accepted` run OR two `accepted-inferred` runs meet one clean
 *      run (§3.6 — `unknown` and `weak-positive` never do). A still-provisional
 *      `accepted` counts: a later correction flips the row to `corrected`, which
 *      removes it from the clean set by itself, so waiting `windowDays` for the
 *      finalization would only hide the floor for a month and make "the arbiter
 *      may act earlier than the default rung" impossible.
 *   3. no existing skill covers the key: `skillUsed` on >= 2 occurrences means
 *      the key is covered — by a LEARNED skill (an `improve` event for §3.7) or
 *      by a hand-written one (`covered-by-handwritten`, recorded, no action).
 *
 * Pure: no I/O, no clock. The caller supplies the rows it read from the ledger.
 */

import type { OutcomeRow, RequestRow, SkillLearningConfig } from './types.js';

export type FloorFailure =
  | 'below-min-occurrences'
  | 'below-min-clean-runs'
  | 'covered-by-handwritten'
  | 'covered-by-learned';

export interface FloorCounts {
  /** Every request row for the key, any identity. */
  occurrences: number;
  /** Rows with `identity: 'verified'` — the only rows that count toward the floor. */
  verifiedOccurrences: number;
  /** `accepted` runs whose request row is verified. */
  acceptedRuns: number;
  /** `accepted-inferred` runs whose request row is verified. */
  acceptedInferredRuns: number;
  /** The §3.6 reduction: accepted + floor(acceptedInferred / 2). */
  cleanRuns: number;
  /** `corrected` runs (any identity) — reported for the drafter's evidence line. */
  correctedRuns: number;
}

export interface FloorResult {
  passes: boolean;
  failure?: FloorFailure;
  counts: FloorCounts;
  /** Set when condition 3 fails: which skill covers the key and whether the sentinel owns it. */
  coveredBy?: { skill: string; learned: boolean; occurrences: number };
  /** The run ids of the clean runs from verified rows (the drafter's evidence, §3.5 input 1-2). */
  cleanRunIds: string[];
  /** The run ids of corrected runs (the drafter's §3.5 input 3). */
  correctedRunIds: string[];
}

export interface FloorInputs {
  requests: RequestRow[];
  outcomes: OutcomeRow[];
  floor: SkillLearningConfig['floor'];
  /** Is this skill name one the sentinel owns (`instar-learned-origin` present)? */
  isLearnedSkill: (name: string) => boolean;
}

/**
 * Reduce the ledger rows for one key against the floor. Deterministic; the
 * same rows always yield the same verdict.
 */
export function evaluateFloor(input: FloorInputs): FloorResult {
  const { requests, outcomes, floor } = input;
  const verifiedRuns = new Set<string>();
  let verifiedOccurrences = 0;
  for (const r of requests) {
    if (r.identity === 'verified') {
      verifiedOccurrences++;
      if (r.runId) verifiedRuns.add(r.runId);
    }
  }

  // Outcomes are already reduced per run by the ledger (latest revision,
  // precedence on conflict). A provisional `accepted` is still a corroborated
  // acceptance today; if it flips to `corrected` later the row leaves the clean
  // set on its own (the reducer keeps the higher-ranked label).
  let acceptedRuns = 0;
  let acceptedInferredRuns = 0;
  let correctedRuns = 0;
  const cleanRunIds: string[] = [];
  const correctedRunIds: string[] = [];
  const usedBy = new Map<string, number>();
  for (const o of outcomes) {
    if (o.skillUsed && o.skillUsed.skill) {
      usedBy.set(o.skillUsed.skill, (usedBy.get(o.skillUsed.skill) ?? 0) + 1);
    }
    if (o.label === 'corrected' || o.label === 'redo') {
      correctedRuns++;
      correctedRunIds.push(o.runId);
      continue;
    }
    if (!verifiedRuns.has(o.runId)) continue;          // asserted / catch-up runs never count
    if (o.label === 'accepted') { acceptedRuns++; cleanRunIds.push(o.runId); }
    else if (o.label === 'accepted-inferred') { acceptedInferredRuns++; cleanRunIds.push(o.runId); }
  }
  const cleanRuns = acceptedRuns + Math.floor(acceptedInferredRuns / 2);
  const counts: FloorCounts = {
    occurrences: requests.length,
    verifiedOccurrences,
    acceptedRuns,
    acceptedInferredRuns,
    cleanRuns,
    correctedRuns,
  };

  const minOcc = Math.max(1, Math.floor(floor.minOccurrences));
  const minClean = Math.max(1, Math.floor(floor.minCorroboratedCleanRuns));

  if (verifiedOccurrences < minOcc) {
    return { passes: false, failure: 'below-min-occurrences', counts, cleanRunIds, correctedRunIds };
  }
  if (cleanRuns < minClean) {
    return { passes: false, failure: 'below-min-clean-runs', counts, cleanRunIds, correctedRunIds };
  }
  // Condition 3: covered. The skill used on the most occurrences decides; a
  // skill seen on a single occurrence is not coverage (one use can be a misfire).
  let top: { skill: string; occurrences: number } | null = null;
  for (const [skill, n] of usedBy) {
    if (!top || n > top.occurrences) top = { skill, occurrences: n };
  }
  if (top && top.occurrences >= 2) {
    const learned = input.isLearnedSkill(top.skill);
    return {
      passes: false,
      failure: learned ? 'covered-by-learned' : 'covered-by-handwritten',
      counts,
      coveredBy: { skill: top.skill, learned, occurrences: top.occurrences },
      cleanRunIds,
      correctedRunIds,
    };
  }
  return { passes: true, counts, cleanRunIds, correctedRunIds };
}
