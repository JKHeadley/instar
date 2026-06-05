/**
 * IntentTestHarness — the two MTP-Protocol tests from EXO 3.0 (Salim Ismail,
 * "Why AI Agents Are Ignoring Your Purpose"):
 *
 *   1. Refusal test    — "Can your MTP make an agent say NO?"  If the purpose
 *                         can't cause a refusal, it's cheering, not governing.
 *   2. Endorsement test — "Would leadership endorse what the agent decided?"
 *
 * This operationalizes ORG-INTENT as a machine-readable protocol: a proposed
 * action is checked against the CONSTRAINT layer (forbidden actions → refuse)
 * and the GOAL/VALUE layers (alignment → endorse). It is deterministic and
 * heuristic (no LLM) so two agents reading the same intent reach the same call
 * — exactly the property EXO 3.0 demands of the decision layer. An optional
 * LLM pass can be layered on top by callers; the core here is pure + testable.
 *
 * Design mirrors OrgIntentManager's existing keyword-contradiction approach
 * (negation-aware core extraction) but is self-contained so the harness can be
 * unit-tested in isolation.
 */

import type { ParsedOrgIntent } from './OrgIntentManager.js';

// ── Types ────────────────────────────────────────────────────────────

export interface RefusalResult {
  /** True when a constraint forbids the action. */
  refused: boolean;
  /** The constraint text that triggered the refusal (if any). */
  matchedConstraint?: string;
  reason: string;
}

export interface EndorsementResult {
  /** True when the action violates no constraint AND aligns with a goal/value. */
  endorsed: boolean;
  /** The goal/value the action aligns with (if endorsed). */
  alignedWith?: string;
  reason: string;
}

// ── Keyword helpers (self-contained) ─────────────────────────────────

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const NEGATIONS = [
  /^never\s+(.+)/, /^do not\s+(.+)/, /^don t\s+(.+)/, /^dont\s+(.+)/,
  /^no\s+(.+)/, /^avoid\s+(.+)/, /^forbidden\s*:?\s*(.+)/, /^must not\s+(.+)/,
  /^cannot\s+(.+)/, /^can t\s+(.+)/, /^refuse to\s+(.+)/,
];

/** Strip a leading negation/imperative to get the action core. */
function core(text: string): string {
  const norm = normalize(text);
  for (const re of NEGATIONS) {
    const m = norm.match(re);
    if (m) return m[1].trim();
  }
  // strip leading positive imperatives so "always validate X" → "validate x"
  const pos = norm.match(/^(?:always|ensure|must|please)\s+(.+)/);
  return (pos ? pos[1] : norm).trim();
}

/** Content-word overlap ratio of the shorter phrase against the longer. */
const STOP = new Set(['the','a','an','to','of','for','with','and','or','any','that','this','is','are','be','on','in','it','its','our','your','their','all','from','by']);
function words(s: string): string[] {
  return s.split(' ').filter((w) => w.length > 2 && !STOP.has(w));
}
function overlap(a: string, b: string): number {
  const wa = words(a), wb = words(b);
  if (wa.length === 0 || wb.length === 0) return 0;
  const setB = new Set(wb);
  const shared = wa.filter((w) => setB.has(w)).length;
  return shared / Math.min(wa.length, wb.length);
}

const MATCH_THRESHOLD = 0.6;

// ── Public API ───────────────────────────────────────────────────────

export class IntentTestHarness {
  constructor(private readonly intent: ParsedOrgIntent) {}

  /**
   * Refusal test: does any constraint forbid this action?
   * The MTP "governs" only if it can produce a NO.
   */
  testRefusal(action: string): RefusalResult {
    const actCore = core(action);
    for (const c of this.intent.constraints) {
      const conCore = core(c.text);
      if (overlap(actCore, conCore) >= MATCH_THRESHOLD) {
        return {
          refused: true,
          matchedConstraint: c.text,
          reason: `Refused: the action matches the constraint "${c.text}".`,
        };
      }
    }
    return { refused: false, reason: 'No constraint forbids this action.' };
  }

  /**
   * Endorsement test: would leadership endorse this?
   * Endorsed only when (a) no constraint refuses it AND (b) it aligns with a
   * stated goal or value. Silence is NOT endorsement — an action unrelated to
   * every goal/value is left un-endorsed (returns false), which is the
   * conservative, governing default.
   */
  testEndorsement(action: string): EndorsementResult {
    const refusal = this.testRefusal(action);
    if (refusal.refused) {
      return { endorsed: false, reason: `Not endorsed — ${refusal.reason}` };
    }
    const actCore = core(action);
    const candidates: string[] = [
      ...this.intent.goals.map((g) => g.text),
      ...this.intent.values,
    ];
    for (const cand of candidates) {
      if (overlap(actCore, core(cand)) >= MATCH_THRESHOLD) {
        return {
          endorsed: true,
          alignedWith: cand,
          reason: `Endorsed: aligns with "${cand}" and violates no constraint.`,
        };
      }
    }
    return {
      endorsed: false,
      reason: 'Not endorsed — violates no constraint, but aligns with no stated goal or value.',
    };
  }

  /**
   * Governance self-check: an MTP that can never refuse anything is "cheering,
   * not governing" (EXO 3.0). True when at least one machine-readable
   * constraint exists to refuse against.
   */
  canGovern(): boolean {
    return this.intent.constraints.length > 0;
  }
}
