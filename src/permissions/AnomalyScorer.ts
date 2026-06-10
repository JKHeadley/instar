/**
 * AnomalyScorer — the relationship/behavioral second factor (Pillar 3).
 *
 * Produces a 0..1 anomaly score for a (principal, request). The gate uses it ONLY
 * to RAISE the required assurance (allow → step-up) on a would-be-allowed floor
 * action; it can never LOWER the bar (a refuse stays a refuse). Composition rule:
 * docs/specs/SLACK-ORG-INTEGRATION-SPEC.md §7.4.
 *
 * Ships OBSERVE-ONLY first (NullAnomalyScorer is the default). The heuristic scorer
 * reads real urgency/pressure language plus an injected behavioral baseline (sourced
 * from RelationshipManager in production); the static scorer is for tests/harness.
 */

import type { Principal, RequestIntent, AnomalyAssessment } from './types.js';
import { isFloorAction } from './RolePolicy.js';

export interface AnomalyScorer {
  assess(principal: Principal, intent: RequestIntent, text: string): Promise<AnomalyAssessment>;
}

/** Default scorer — always in-character. Pillar 3 ships dark; this is the no-op. */
export class NullAnomalyScorer implements AnomalyScorer {
  // eslint-disable-next-line @typescript-eslint/require-await
  async assess(): Promise<AnomalyAssessment> {
    return { score: 0, reasons: [] };
  }
}

/** A principal's behavioral baseline (in production, derived from RelationshipManager). */
export interface PrincipalBaseline {
  /** Action labels this principal has historically made (their normal repertoire). */
  typicalActions?: string[];
  /** Number of prior interactions — depth of the relationship (a weak baseline = few). */
  interactionCount?: number;
}

export interface BaselineProvider {
  baselineFor(principal: Principal): PrincipalBaseline | undefined;
}

const URGENCY = /\b(urgent|urgently|asap|right now|immediately|before eod|by eod|end of day|emergency|hurry|quickly|can'?t wait)\b/i;

/**
 * Heuristic scorer: urgency/pressure language + "this principal never makes this
 * kind of request" (vs the injected baseline). Real, cheap, privacy-respecting —
 * no content surveillance, just shape.
 */
export class HeuristicAnomalyScorer implements AnomalyScorer {
  constructor(
    private readonly baselines?: BaselineProvider,
    private readonly opts: { urgencyWeight?: number; atypicalWeight?: number } = {},
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async assess(principal: Principal, intent: RequestIntent, text: string): Promise<AnomalyAssessment> {
    const reasons: string[] = [];
    let score = 0;
    const urgencyWeight = this.opts.urgencyWeight ?? 0.5;
    const atypicalWeight = this.opts.atypicalWeight ?? 0.5;

    if (URGENCY.test(text || '')) {
      score += urgencyWeight;
      reasons.push('urgency/pressure language');
    }

    const baseline = this.baselines?.baselineFor(principal);
    if (baseline && isFloorAction(intent.floorAction)) {
      const typical = baseline.typicalActions ?? [];
      const established = (baseline.interactionCount ?? 0) >= 5;
      if (established && !typical.includes(intent.action)) {
        score += atypicalWeight;
        reasons.push(`out-of-character: ${principal.name} has an established history but has never requested "${intent.action}"`);
      }
    }

    return { score: Math.max(0, Math.min(1, score)), reasons };
  }
}

/** Static scorer for tests/harness — fixed score per slackUserId. */
export class StaticAnomalyScorer implements AnomalyScorer {
  constructor(private readonly scores: Record<string, { score: number; reasons: string[] }>) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async assess(principal: Principal): Promise<AnomalyAssessment> {
    const s = principal.slackUserId ? this.scores[principal.slackUserId] : undefined;
    return s ? { score: s.score, reasons: [...s.reasons] } : { score: 0, reasons: [] };
  }
}
