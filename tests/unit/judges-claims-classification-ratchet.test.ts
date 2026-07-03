/**
 * judgesClaims classification ratchet — the test-side enforcement of the
 * Evidence-Bar Extension standard's judge-nature classification
 * (docs/specs/evidence-bar-judge-extension.md §2).
 *
 * Guarantees, structurally:
 *   1. EVERY LLM component in COMPONENT_CATEGORY carries an EXPLICIT
 *      judgesClaims classification — there is NO default (same polarity rule as
 *      the sibling `untrustedInput` axis). A new LLM callsite that forgets to
 *      classify its judge story fails CI (a silent omission can never default
 *      toward the un-benched state).
 *   2. No dangling entries (classification keys must name real components).
 *   3. Every `{ claimKind }` (judge) entry declares a VALID claimKind — the
 *      axis cases + accepted evidence classes are authored per kind, so an
 *      invalid kind is red CI.
 *   4. The spec-named JUDGE SEED set is classified as a judge (never `false`) —
 *      the callsites the defect-class review measured crediting a bare claim
 *      cannot silently slip out of scope.
 *   5. The argued-FALSE set (a judge-SHAPED callsite argued OUT of scope) is
 *      pinned SHRINK-ONLY and each false argues a real reason (>= 40 chars) —
 *      exactly like the untrustedInput / bench-coverage exemptions.
 *
 * Ships DARK/report-only in the sense that it wires no runtime gate; it is a
 * pinned-baseline ratchet in the same family as llm-bench-coverage-ratchet and
 * untrusted-input-classification-ratchet. The bench-AXIS pair (a bare-claim +
 * a real-evidence case per judge, spec §3) is DEFERRED with the sibling specs —
 * it is blocked on the program-wide "batteries readable by CI" decision
 * (research/ is absent from canonical main); see the release fragment.
 */
import { describe, it, expect } from 'vitest';
import { COMPONENT_CATEGORY } from '../../src/core/componentCategories.js';
import {
  LLM_JUDGES_CLAIMS,
  CLAIM_KINDS,
  type JudgesClaimsFlag,
} from '../../src/data/llmBenchCoverage.js';

function isJudge(v: JudgesClaimsFlag): v is { claimKind: (typeof CLAIM_KINDS)[number] } {
  return typeof v === 'object' && v !== null && 'claimKind' in v;
}

function isArguedFalse(v: JudgesClaimsFlag): v is { false: string } {
  return typeof v === 'object' && v !== null && 'false' in v;
}

// ── The spec-named judge SEED (docs/specs/evidence-bar-judge-extension.md §2).
// Each MUST be classified as a judge (a `{ claimKind }` entry) — these are the
// callsites the 2026-07-02 defect-class review measured crediting a bare claim,
// plus the two pending-wave judges named in §2 (JobReflector, mentor-stage-b),
// bound to their existing wave-3 graduation so the asymmetry can't silently
// reopen. The `real-check verifier` is also seed-named but is the DETERMINISTIC
// arm (no LLM component key), out of this classification by construction. ──
const JUDGE_SEED = [
  'CompletionEvaluator',
  'UnjustifiedStopGate',
  'SessionWatchdog',
  'PresenceProxy',
  'StallTriageNurse',
  'JobReflector',
  'mentor-stage-b',
].sort();

// ── Pinned argued-FALSE baseline. SHRINK-ONLY: flipping a `{ false: reason }`
// judge-shaped callsite to a real judge removes it here; ADDING a name means you
// are declaring a judge-SHAPED callsite does NOT judge a completion/health claim
// — argue the reason in src/data/llmBenchCoverage.ts AND add it here (a visible,
// reviewed act). Currently EMPTY: every judge-shaped callsite is classified as a
// real judge; plain non-judges use bare `false`, which needs no argument. ──
const ARGUED_FALSE_BASELINE: string[] = [];

describe('judgesClaims classification ratchet', () => {
  it('every COMPONENT_CATEGORY key has an EXPLICIT judgesClaims classification (no default)', () => {
    const missing = Object.keys(COMPONENT_CATEGORY).filter((k) => !(k in LLM_JUDGES_CLAIMS));
    expect(
      missing,
      `LLM component(s) with no judgesClaims classification: ${missing.join(', ')}.\n` +
        'Add each to LLM_JUDGES_CLAIMS in src/data/llmBenchCoverage.ts as ' +
        '`{ claimKind: "completionClaim" | "healthClaim" | "scoredCredit" }` (it credits/refuses ' +
        'an agent/session claim of completion, progress, or health) or `false` (it does not). ' +
        'A judge-shaped callsite argued out of scope uses `{ false: "<argued reason>" }` and must ' +
        'ALSO be added to ARGUED_FALSE_BASELINE in this test. evidence-bar-judge-extension.md §2.',
    ).toEqual([]);
  });

  it('no dangling classification entries (keys must exist in COMPONENT_CATEGORY)', () => {
    const dangling = Object.keys(LLM_JUDGES_CLAIMS).filter((k) => !(k in COMPONENT_CATEGORY));
    expect(dangling, `classification entries for unknown components: ${dangling.join(', ')}`).toEqual(
      [],
    );
  });

  it('every judge entry declares a VALID claimKind', () => {
    const bad = Object.entries(LLM_JUDGES_CLAIMS)
      .filter(([, v]) => isJudge(v))
      .filter(([, v]) => !CLAIM_KINDS.includes((v as { claimKind: string }).claimKind as never))
      .map(([k, v]) => `${k}=${(v as { claimKind: string }).claimKind}`);
    expect(
      bad,
      `judge entries with an invalid claimKind: ${bad.join(', ')}. ` +
        `Valid kinds: ${CLAIM_KINDS.join(' | ')}.`,
    ).toEqual([]);
  });

  it('every spec-named JUDGE SEED callsite is classified as a judge (never false)', () => {
    const notAJudge = JUDGE_SEED.filter((k) => {
      const v = LLM_JUDGES_CLAIMS[k];
      return !(v && isJudge(v));
    });
    expect(
      notAJudge,
      `spec-named judge(s) not classified as a judge: ${notAJudge.join(', ')}.\n` +
        'These are the callsites the 2026-07-02 defect-class review measured crediting a bare ' +
        'claim (evidence-bar-judge-extension.md §2). Each must carry a `{ claimKind }` — they ' +
        'cannot be marked `false`.',
    ).toEqual([]);
  });

  it('the argued-FALSE set matches the pinned shrink-only baseline exactly', () => {
    const actualFalse = Object.entries(LLM_JUDGES_CLAIMS)
      .filter(([, v]) => isArguedFalse(v))
      .map(([k]) => k)
      .sort();
    expect(
      actualFalse,
      'The argued-false set drifted from the pinned baseline. Flipping an argued-false judge to a ' +
        'real judge is a shrink (remove it from ARGUED_FALSE_BASELINE); adding a new argued-false ' +
        'requires editing this pinned baseline — a visible, reviewed act.',
    ).toEqual([...ARGUED_FALSE_BASELINE].sort());
  });

  it('every argued-false carries a real reason (>= 40 chars)', () => {
    const lazy = Object.entries(LLM_JUDGES_CLAIMS)
      .filter(([, v]) => isArguedFalse(v))
      .filter(([, v]) => (v as { false: string }).false.trim().length < 40)
      .map(([k]) => k);
    expect(lazy, `argued-false entries with a too-short reason: ${lazy.join(', ')}`).toEqual([]);
  });

  it('at least the five measured completion/health judges are classified (grounding sanity)', () => {
    // A canary that the classification is not accidentally emptied: the core
    // five LLM judges from the defect-class review must all resolve to a judge.
    const core = [
      'CompletionEvaluator',
      'UnjustifiedStopGate',
      'SessionWatchdog',
      'PresenceProxy',
      'StallTriageNurse',
    ];
    for (const k of core) {
      expect(LLM_JUDGES_CLAIMS[k], `${k} must be classified`).toBeDefined();
      expect(isJudge(LLM_JUDGES_CLAIMS[k]), `${k} must be a judge`).toBe(true);
    }
  });
});
