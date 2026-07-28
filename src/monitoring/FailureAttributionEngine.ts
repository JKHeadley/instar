/**
 * FailureAttributionEngine — joins a failure to the feature that produced it.
 *
 * Part of the Failure-Learning Loop (docs/specs/FAILURE-LEARNING-LOOP-SPEC.md
 * §4.2 #A/#B, §4.3). First-slice sources:
 *
 *  - #A bugfix-commit: parse a `Fixes-Feature: <initiativeId>` / `Fixes: <FAIL-id>`
 *    trailer, then CROSS-CHECK that the fix commit's touched files actually
 *    intersect the named initiative's `coveredFiles`. A forged/mistaken trailer
 *    that points at an unrelated initiative fails the overlap check and is
 *    downgraded to `inferred` (needs attribution) — never accepted as fact
 *    (spec §4.2 #A, M7). Trailer omission is reported as a coverage bucket, not
 *    silently dropped.
 *
 *  - #B agent-diagnosed: a server-validated one-tap. The cited `initiativeId`
 *    MUST exist; a caller-supplied `causeCommitOid` NEVER upgrades the record to
 *    `automatic` (spec §4.2 #B, B6) — it stays `one-tap` and is excluded from
 *    toolchain-blame aggregates by the analyzer.
 *
 * Pure logic with injected dependencies (initiative lookup + git file-overlap)
 * so it is unit-testable without a live InitiativeTracker or git.
 */
import type { FailureCategory, AttributionMode } from './FailureLedger.js';

/** Minimal view of an initiative the engine needs to attribute against. */
export interface InitiativeView {
  id: string;
  coveredFiles?: string[];
  mergeCommitOid?: string;
  parentProjectId?: string;
  specPath?: string;
}

export interface AttributionDeps {
  /** Resolve an initiative by id (from InitiativeTracker). Returns null if absent. */
  getInitiative: (id: string) => InitiativeView | null;
  /** Files touched by a commit (from git). Returns [] if unknown. */
  commitTouchedFiles: (commitOid: string) => string[];
}

export interface AttributionVerdict {
  attribution: AttributionMode;
  attributionConfidence: number;
  initiativeId?: string;
  projectId?: string;
  specPath?: string;
  causeCommitOid?: string;
  /** Human-readable note explaining the verdict (for the audit/needs-attribution surface). */
  note: string;
  /** True when the trailer was absent — feeds the "no-feature-link" coverage bucket (§4.2 #A). */
  noFeatureLink?: boolean;
}

export interface ParsedTrailers {
  fixesFeature?: string;
  fixesFailId?: string;
}

const TRAILER_FEATURE = /^\s*Fixes-Feature:\s*(\S+)\s*$/im;
const TRAILER_FAIL = /^\s*Fixes:\s*(FAIL-\S+)\s*$/im;

export class FailureAttributionEngine {
  constructor(private readonly deps: AttributionDeps) {}

  /** Parse the bugfix-commit trailers from a commit message. */
  static parseTrailers(commitMessage: string): ParsedTrailers {
    const out: ParsedTrailers = {};
    const f = commitMessage.match(TRAILER_FEATURE);
    if (f) out.fixesFeature = f[1].trim();
    const x = commitMessage.match(TRAILER_FAIL);
    if (x) out.fixesFailId = x[1].trim();
    return out;
  }

  /** Normalize a path for overlap comparison (strip leading ./, lowercase drive-irrelevant). */
  private static norm(p: string): string {
    return p.replace(/^\.\//, '').trim();
  }

  /**
   * Attribute a bugfix commit. The trailer is a HINT that must be reconciled
   * against reality: the cited initiative must exist AND the fix commit's
   * touched files must intersect its coveredFiles. Verified overlap → automatic;
   * trailer-without-overlap (or missing initiative) → inferred (needs attribution).
   */
  attributeBugfixCommit(input: { commitOid: string; commitMessage: string }): AttributionVerdict {
    const trailers = FailureAttributionEngine.parseTrailers(input.commitMessage);

    if (!trailers.fixesFeature) {
      // Trailer omission is a measured coverage gap, not a silent drop (§4.2 #A).
      return {
        attribution: 'inferred',
        attributionConfidence: 0,
        causeCommitOid: input.commitOid,
        noFeatureLink: true,
        note: 'no Fixes-Feature trailer — counted in the no-feature-link coverage bucket',
      };
    }

    const initiative = this.deps.getInitiative(trailers.fixesFeature);
    if (!initiative) {
      return {
        attribution: 'inferred',
        attributionConfidence: 0.1,
        causeCommitOid: input.commitOid,
        note: `trailer cites unknown initiative "${trailers.fixesFeature}" — needs attribution`,
      };
    }

    const touched = new Set(this.deps.commitTouchedFiles(input.commitOid).map(FailureAttributionEngine.norm));
    const covered = (initiative.coveredFiles ?? []).map(FailureAttributionEngine.norm);
    const overlap = covered.some((f) => touched.has(f));

    if (!overlap) {
      // Forged/mistaken trailer: the fix doesn't touch the feature's code (§4.2 M7).
      return {
        attribution: 'inferred',
        attributionConfidence: 0.2,
        initiativeId: initiative.id,
        projectId: initiative.parentProjectId,
        specPath: initiative.specPath,
        causeCommitOid: input.commitOid,
        note: `trailer cites "${initiative.id}" but fix touches none of its coveredFiles — needs attribution (possible mis-blame)`,
      };
    }

    return {
      attribution: 'automatic',
      attributionConfidence: 0.9,
      initiativeId: initiative.id,
      projectId: initiative.parentProjectId,
      specPath: initiative.specPath,
      causeCommitOid: input.commitOid,
      note: `trailer cross-checked: fix overlaps ${initiative.id} coveredFiles`,
    };
  }

  /**
   * Validate an agent-diagnosed one-tap filing. The cited initiative must
   * exist. A caller-supplied causeCommitOid NEVER upgrades to automatic (B6);
   * the verdict stays one-tap.
   */
  validateAgentDiagnosed(input: { initiativeId: string; causeCommitOid?: string }):
    | { ok: true; verdict: AttributionVerdict }
    | { ok: false; reason: string } {
    const initiative = this.deps.getInitiative(input.initiativeId);
    if (!initiative) {
      return { ok: false, reason: `initiative "${input.initiativeId}" does not exist` };
    }
    return {
      ok: true,
      verdict: {
        attribution: 'one-tap',
        attributionConfidence: 0.5,
        initiativeId: initiative.id,
        projectId: initiative.parentProjectId,
        specPath: initiative.specPath,
        causeCommitOid: input.causeCommitOid, // recorded but does NOT raise confidence/attribution
        note: 'agent-diagnosed one-tap — excluded from toolchain-blame aggregates',
      },
    };
  }

  /** Pick a category enum value defensively — never trust free text (§4.4). */
  static coerceCategory(value: string | undefined): FailureCategory {
    const allowed: FailureCategory[] = [
      'concurrency', 'config-parse', 'wiring', 'logic', 'migration', 'test-gap',
      'build-failure', 'test-failure', 'regression', 'unknown',
    ];
    return allowed.includes(value as FailureCategory) ? (value as FailureCategory) : 'unknown';
  }
}
