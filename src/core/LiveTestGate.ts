/**
 * LiveTestGate — the deterministic completion-gate veto (spec
 * docs/specs/live-user-channel-proof-standard.md §4). It refuses a "done"/"shipped"
 * verdict for a USER-FACING feature unless a verified live-test artifact (§4.4)
 * proves it ran through its real surface (Telegram AND Slack for a channel feature)
 * across the required risk categories.
 *
 * Signal vs. Authority (§4.2 — the load-bearing placement): the keyword classifier
 * holds NO standalone blocking authority. The HARD veto rests only on OBJECTIVE
 * facts — an author-DECLARED `userFacing:true` AND the absence of a verified
 * artifact. An undeclared-but-user-facing-looking goal gets a SOFT 'nudge'
 * (return-to-work signal), never a hard block on a brittle guess. Both outcomes
 * keep an autonomous run working (they prevent a premature "done"); only the
 * REPORTED authority differs, so the structure is honest about which is objective.
 *
 * Rollout (§4.8): `mode` is dry-run → warn → veto. In dry-run/warn the decision is
 * computed + logged but `blocks` is false (it never actually stops the run); only
 * `veto` mode blocks. The SAFE direction on an unverifiable artifact is not-proven
 * (return to work), never a false "done".
 */

import type { LiveTestArtifactStore, Surface, RiskCategory, LiveTestArtifact } from './LiveTestArtifactStore.js';
import { REQUIRED_RISK_CATEGORIES } from './LiveTestArtifactStore.js';

export type LiveTestGateMode = 'dry-run' | 'warn' | 'veto';

/** Keyword signal that a goal looks user-facing (NOT authority — §4.2/§4.3). */
const USER_FACING_KEYWORDS = [
  'channel', 'dashboard', 'message', 'transfer', 'slack', 'telegram', 'ux',
  'reply', 'notification', 'notify', 'conversation', 'topic', 'session',
];

export function looksUserFacing(goalText: string): boolean {
  const t = ` ${goalText.toLowerCase()} `;
  return USER_FACING_KEYWORDS.some((k) => new RegExp(`\\b${k}\\b`).test(t));
}

export interface LiveTestGateInput {
  featureId: string;
  /** Author declaration; undefined → classifier signal (never a hard block). */
  userFacing?: boolean;
  goalText: string;
  /** The surfaces this feature has (channel/dashboard). Default ['telegram','slack']. */
  requiredSurfaces?: Surface[];
  mode: LiveTestGateMode;
}

export type GateOutcome = 'allow' | 'veto' | 'nudge';

export interface LiveTestGateResult {
  outcome: GateOutcome;
  /** Whether this actually stops the run (only outcome!=allow AND mode==='veto'). */
  blocks: boolean;
  mode: LiveTestGateMode;
  reason: string;
  /** True when the gate WOULD veto/nudge but mode held it (dry-run/warn telemetry). */
  wouldBlock: boolean;
}

function uniq<T>(xs: T[]): T[] { return [...new Set(xs)]; }

/**
 * Evaluate the live-test artifact for a feature against the §4.5 surface +
 * §4.6 risk-category requirements. Returns null when the artifact fully satisfies
 * the bar, or a human reason string when it does not.
 */
export function evaluateArtifact(artifact: LiveTestArtifact, requiredSurfaces: Surface[]): string | null {
  // §4.5 surfaces: every required surface must be exercised (or carry an audited
  // exemption — modeled as the surface simply being present in surfaces[]).
  const present = new Set(artifact.surfaces);
  const missingSurface = requiredSurfaces.find((s) => !present.has(s));
  if (missingSurface) return `missing required surface "${missingSurface}" (have: ${[...present].join(', ') || 'none'})`;

  // §4.4 poison rule + §4.6 BLOCKED taxonomy, per risk category.
  const byCategory = new Map<RiskCategory, { pass: number; fail: number; blockedReal: number }>();
  for (const row of artifact.scenarios) {
    const c = byCategory.get(row.riskCategory) ?? { pass: 0, fail: 0, blockedReal: 0 };
    if (row.verdict === 'PASS') c.pass++;
    else if (row.verdict === 'FAIL') c.fail++;
    else if (row.verdict === 'BLOCKED') {
      // BLOCKED is honored only with a machine-verifiable external blocker (§4.6);
      // a bare BLOCKED counts as FAIL.
      const real = row.blockedKind === 'platform-error' || row.blockedKind === 'platform-outage' || row.blockedKind === 'operator-waiver';
      if (real) c.blockedReal++; else c.fail++;
    }
    byCategory.set(row.riskCategory, c);
  }

  // The load-bearing categories must have a PASS (BLOCKED never satisfies them, §4.6).
  const loadBearing: RiskCategory[] = ['happy-path', 'channel-parity'];
  for (const cat of loadBearing) {
    const c = byCategory.get(cat);
    if (!c || c.pass < 1) return `load-bearing category "${cat}" has no PASS scenario`;
    if (c.fail > 0) return `category "${cat}" has ${c.fail} FAIL/poisoned scenario(s)`;
  }
  // Every applicable required category present with at least one PASS (§4.6).
  const declared = uniq(artifact.riskCategories);
  for (const cat of declared) {
    if (!REQUIRED_RISK_CATEGORIES.includes(cat)) continue;
    const c = byCategory.get(cat);
    if (!c || c.pass < 1) return `risk category "${cat}" is declared but has no PASS scenario`;
    if (c.fail > 0) return `risk category "${cat}" has ${c.fail} FAIL/poisoned scenario(s)`;
  }
  return null;
}

export class LiveTestGate {
  constructor(private readonly store: LiveTestArtifactStore) {}

  evaluate(input: LiveTestGateInput): LiveTestGateResult {
    const requiredSurfaces = input.requiredSurfaces ?? (['telegram', 'slack'] as Surface[]);
    const mk = (outcome: GateOutcome, reason: string): LiveTestGateResult => {
      const wouldBlock = outcome !== 'allow';
      return { outcome, reason, mode: input.mode, wouldBlock, blocks: wouldBlock && input.mode === 'veto' };
    };

    // §4.2/§4.3: determine user-facing. Explicit declaration is authoritative;
    // otherwise the classifier is a SIGNAL only.
    const declaredUserFacing = input.userFacing;
    const classifierSaysUserFacing = looksUserFacing(input.goalText);

    if (declaredUserFacing === false) {
      // Declared internal. (A surfaced contradiction is the harness/sentinel's job,
      // signal-only — the gate honors the declaration here.)
      return mk('allow', 'declared userFacing:false — gate not applicable');
    }
    const isUserFacing = declaredUserFacing === true || classifierSaysUserFacing;
    if (!isUserFacing) return mk('allow', 'not a user-facing feature (no declaration, classifier negative)');

    // User-facing → require a verified artifact.
    const verified = this.store.latestVerified(input.featureId);
    if (!verified || !verified.ok) {
      const reason = `no verified live-test artifact for "${input.featureId}" (${verified?.reason ?? 'none found'}) — run the user-role harness through ${requiredSurfaces.join(' AND ')} first`;
      // HARD veto only when DECLARED user-facing (objective). Undeclared-but-classified
      // → soft nudge (Signal vs. Authority §4.2).
      return mk(declaredUserFacing === true ? 'veto' : 'nudge', reason);
    }

    const shortfall = evaluateArtifact(verified.artifact!, requiredSurfaces);
    if (shortfall) {
      return mk(declaredUserFacing === true ? 'veto' : 'nudge', `live-test artifact present but incomplete: ${shortfall}`);
    }
    return mk('allow', `verified live-test artifact proves "${input.featureId}" across ${requiredSurfaces.join(' AND ')}`);
  }
}

// (CMT-1568 live-user-channel-proof — decision-audit record trigger)
