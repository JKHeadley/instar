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
import type { IntelligenceProvider } from './types.js';

// ── Types ────────────────────────────────────────────────────────────

export interface RefusalResult {
  /** True when a constraint forbids the action. */
  refused: boolean;
  /** The constraint text that triggered the refusal (if any). */
  matchedConstraint?: string;
  reason: string;
}

/**
 * HOW a governance verdict was produced — Truthful Provenance (constitution):
 * a verdict must carry the method that generated it so consumers never
 * mistake a heuristic for ground truth (PR #899), nor an LLM judgment for
 * certainty (this Phase 2).
 */
export type JudgeMethod = 'keyword-heuristic' | 'llm-judge';

/** A refusal verdict produced by the LLM judge (always method 'llm-judge'). */
export interface JudgedRefusalResult extends RefusalResult {
  method: 'llm-judge';
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

// ── Phase-2 LLM judge (CMT-1128) ─────────────────────────────────────
//
// The keyword matcher above is a PRE-FILTER, not a decision-maker (the
// IntelligenceProvider contract, types.ts): it is high-precision when it
// matches but produces FALSE NEGATIVES on semantically-related wording (the
// live boundary-map example: a constraint "never present unverified WORK as
// completed" does not keyword-match "estimates as CONFIRMED numbers" though
// it plainly governs it in spirit). The judge below closes that side: callers
// short-circuit on a keyword MATCH (free, precise) and escalate keyword
// MISSES to one bounded LLM call that judges by MEANING. Any judge problem —
// no provider, circuit open, malformed reply — returns null so the caller
// keeps the heuristic verdict and says so honestly (Truthful Provenance:
// method 'llm-judge' is only ever claimed for a real, parsed LLM verdict).

/** Options for a single judge call. */
export interface JudgeOptions {
  /** Per-call timeout in ms (default 8000 — bounded for synchronous HTTP callers). */
  timeoutMs?: number;
}

interface JudgeReply {
  forbidden: boolean;
  constraintIndex: number | null;
  reason: string;
}

/** Strictly parse the judge's reply; null on anything malformed. */
function parseJudgeReply(raw: string, constraintCount: number): JudgeReply | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    // @silent-fallback-ok — a malformed judge reply yields null; the caller keeps the heuristic verdict and labels it honestly
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.forbidden !== 'boolean') return null;
  let idx: number | null = null;
  if (typeof o.constraintIndex === 'number' && Number.isInteger(o.constraintIndex) && o.constraintIndex >= 1 && o.constraintIndex <= constraintCount) {
    idx = o.constraintIndex;
  }
  return {
    forbidden: o.forbidden,
    constraintIndex: idx,
    reason: typeof o.reason === 'string' ? o.reason : '',
  };
}

/**
 * Ask the LLM whether any constraint SEMANTICALLY forbids the action — the
 * Phase-2 resolver for the keyword matcher's false-negative side.
 *
 * Returns a verdict with method 'llm-judge' when (and only when) a real LLM
 * reply parsed cleanly; returns null on ANY problem (no constraints, provider
 * error, circuit open, malformed reply) so the caller retains the heuristic
 * verdict. Never throws.
 */
export async function judgeRefusal(
  action: string,
  intent: ParsedOrgIntent,
  provider: IntelligenceProvider,
  opts?: JudgeOptions,
): Promise<JudgedRefusalResult | null> {
  const constraints = intent.constraints.map((c) => c.text);
  if (constraints.length === 0) return null;
  const prompt = [
    'You are a strict governance judge for an organization.',
    'The organization has these MANDATORY constraints (rules agents must never break):',
    ...constraints.map((c, i) => `${i + 1}. ${c}`),
    '',
    `Proposed action: "${action}"`,
    '',
    'Does any constraint SEMANTICALLY forbid this action? Judge by MEANING, not exact words —',
    'a constraint forbids the action if the action violates what the rule is plainly about,',
    'even when the wording differs (for example, a rule against "presenting unverified work',
    'as completed" forbids "presenting estimates as confirmed numbers").',
    '',
    'Reply with ONLY a JSON object, no other text:',
    '{"forbidden": true|false, "constraintIndex": <1-based index of the forbidding constraint, or null>, "reason": "<one sentence>"}',
  ].join('\n');
  let raw: string;
  try {
    raw = await provider.evaluate(prompt, {
      model: 'fast',
      maxTokens: 250,
      temperature: 0,
      timeoutMs: opts?.timeoutMs ?? 8000,
      attribution: { component: 'IntentLlmJudge', category: 'gate', gating: true },
    });
  } catch {
    // @silent-fallback-ok — judge unavailable (circuit open / provider error); caller keeps the heuristic verdict and labels it honestly
    return null;
  }
  const reply = parseJudgeReply(raw, constraints.length);
  if (!reply) return null;
  if (reply.forbidden) {
    const matched = reply.constraintIndex !== null ? constraints[reply.constraintIndex - 1] : undefined;
    return {
      refused: true,
      matchedConstraint: matched,
      method: 'llm-judge',
      reason: matched
        ? `Refused (LLM semantic judgment): the action violates the constraint "${matched}". ${reply.reason}`.trim()
        : `Refused (LLM semantic judgment): ${reply.reason || 'a constraint forbids this action.'}`,
    };
  }
  return {
    refused: false,
    method: 'llm-judge',
    reason: `No constraint forbids this action per LLM semantic judgment${reply.reason ? ` — ${reply.reason}` : ''}. Stronger than a keyword miss, but still a judgment, not ground truth.`,
  };
}
