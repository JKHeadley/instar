/**
 * PrincipalGuard — cross-principal attribution detector (EXO 3.0 / "Know Your
 * Principal" standard, Phase 1 brain).
 *
 * The "Caroline" incident (2026-06-05, topic 19437): an autonomous session
 * silently adopted a real OTHER principal as its operator and credited the
 * actual operator's decisions to her across three docs — and no gate watched,
 * because the contamination was in the agent's OWN output, not an inbound
 * message. This module is the pure-logic detector for that failure: given a
 * piece of agent-authored text, it finds operator-ROLE-decision attributions
 * ("X approved", "locked with X", "mandate (X)", "X dropped a token") and
 * flags any whose attributed principal is NOT the topic's bound operator and
 * does NOT resolve to a known user.
 *
 * Pure + deterministic so it is unit-testable in isolation; it performs no I/O
 * and is not wired into the live request path here (that is a later increment).
 * The constitution standard it enforces: "Know Your Principal — An Unverified
 * Identity Is a Guess" (docs/STANDARDS-REGISTRY.md). Spec:
 * docs/specs/OPERATOR-IDENTITY-BINDING-SPEC.md.
 */

/** A verified operator, established ONLY from an authenticated channel — never
 *  from a name read in content (that is the whole point). */
export interface VerifiedOperator {
  /** The platform-verified sender id (e.g. Telegram uid). */
  uid: string;
  /** Display name(s) the operator is known by, lowercased for matching. */
  names: string[];
}

/**
 * Establish a topic's operator from the AUTHENTICATED sender — never from a
 * content name. The uid is the authority; names are only for matching the
 * agent's prose against the verified principal. A blank uid yields no operator
 * (an unbound topic), which the guard treats as "everything is unverified".
 */
export function establishOperator(authenticatedUid: string, displayName?: string): VerifiedOperator | null {
  const uid = String(authenticatedUid ?? '').trim();
  if (!uid) return null;
  const names = (displayName ?? '').trim() ? [displayName!.trim().toLowerCase()] : [];
  return { uid, names };
}

/** The kind of operator-role decision an attribution carries — drives warn vs block. */
export type AttributionKind =
  | 'approval' // "X approved", "blessed by X"
  | 'mandate' // "mandate (X)", "X authorized"
  | 'credential' // "X dropped a token", "X's credentials"
  | 'lock' // "locked with X", "standing requirement from X"
  | 'acting-for'; // "acting on X's behalf", "on X's say-so"

export interface Attribution {
  /** The principal name the decision was attributed to (lowercased). */
  principal: string;
  kind: AttributionKind;
  /** The matched snippet, for the audit trail. */
  snippet: string;
}

// ── Detection patterns ───────────────────────────────────────────────
// Each captures a person-like principal NAME in group 1. Kept conservative:
// a name is 1-3 capitalized-ish words (so "the team" / "prod" don't match).
// NAME requires a real capital first letter (case-SENSITIVE — no `i` flag — so
// "have"/"production" can never be captured as a principal). Only the keyword
// LEADS are made case-flexible ([Mm]andate, [Ll]ock…) so a sentence-initial
// "Mandate" matches as well as a mid-sentence "mandate".
const NAME = String.raw`([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})`;
// Bounded gap that lets a date/short clause sit between a keyword and the name
// ("Locked 2026-06-04 with Caroline") without swallowing a sentence.
const GAP = String.raw`[^.\n]{0,40}?`;
const PATTERNS: Array<{ re: RegExp; kind: AttributionKind }> = [
  { re: new RegExp(String.raw`\b[Mm]andate\s*\(\s*${NAME}\s*\)`, 'g'), kind: 'mandate' },
  { re: new RegExp(String.raw`\b${NAME}\s+[Aa]uthoriz(?:ed|es)\b`, 'g'), kind: 'mandate' },
  { re: new RegExp(String.raw`\b${NAME}\s+[Aa]pprov(?:ed|es)\b`, 'g'), kind: 'approval' },
  { re: new RegExp(String.raw`\b(?:[Bb]lessed|[Ss]igned[- ]off)\s+by\s+${NAME}`, 'g'), kind: 'approval' },
  { re: new RegExp(String.raw`\b[Ll]ock(?:ed)?\b${GAP}\b(?:with|by)\s+${NAME}`, 'g'), kind: 'lock' },
  { re: new RegExp(String.raw`\b[Ss]tanding requirement from\s+${NAME}`, 'g'), kind: 'lock' },
  { re: new RegExp(String.raw`\b${NAME}\s+(?:dropped|drop)\s+(?:a|the)\s+(?:token|credential|secret|key)`, 'g'), kind: 'credential' },
  { re: new RegExp(String.raw`\b${NAME}['’]s\s+(?:credential|token|git\s+cred)`, 'g'), kind: 'credential' },
  { re: new RegExp(String.raw`\b[Oo]n\s+behalf\s+of\s+${NAME}`, 'g'), kind: 'acting-for' },
  { re: new RegExp(String.raw`\b[Oo]n\s+${NAME}['’]s\s+(?:say-so|behalf|authority)`, 'g'), kind: 'acting-for' },
];

// Words that look capitalized but are never principals (sentence-start nouns,
// product/role terms). Keeps the detector from flagging "Production approved".
const NON_PRINCIPALS = new Set([
  'the', 'a', 'an', 'prod', 'production', 'ci', 'team', 'board', 'ops', 'staging',
  'github', 'telegram', 'slack', 'dawn', 'echo', 'i', 'we', 'you', 'they', 'it',
  'have', 'has', 'this', 'that', 'every', 'all',
]);

function isPersonLike(name: string): boolean {
  const firstWord = name.split(/\s+/)[0];
  // The `i` flag lets [A-Z] match lowercase too, so require an actual capital
  // first letter here — a real person name is capitalized; "production" is not.
  const startsCapital = /^[A-Z]/.test(firstWord);
  return startsCapital && !NON_PRINCIPALS.has(firstWord.toLowerCase());
}

/** Find every operator-role-decision attribution in agent-authored text. */
export function detectAttributions(text: string): Attribution[] {
  const out: Attribution[] = [];
  const seen = new Set<string>();
  for (const { re, kind } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const principal = (m[1] ?? '').trim();
      if (!principal || !isPersonLike(principal)) continue;
      const key = `${kind}:${principal.toLowerCase()}:${m.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ principal: principal.toLowerCase(), kind, snippet: m[0] });
    }
  }
  return out;
}

export type Verdict = 'ok' | 'warn' | 'block';

export interface PrincipalFinding {
  attribution: Attribution;
  verdict: Verdict;
  reason: string;
}

/** Credential/authority-bearing kinds BLOCK when misattributed; the rest WARN. */
const BLOCK_KINDS = new Set<AttributionKind>(['mandate', 'credential']);

/**
 * Evaluate a piece of agent-authored text against the topic's verified
 * operator and the known-user registry. An attribution to the bound operator
 * (or any known user) is fine; an attribution to anyone else is the Caroline
 * failure — warn for prose, block for authority/credential decisions.
 *
 * `knownUserNames` are lowercased display names from UserManager (the
 * authoritative registry). Resolution against it is what the "Know Your
 * Principal" standard requires before any principal is accepted.
 */
export function evaluatePrincipalCoherence(
  text: string,
  operator: VerifiedOperator | null,
  knownUserNames: string[] = [],
): PrincipalFinding[] {
  const known = new Set<string>([
    ...(operator?.names ?? []),
    ...knownUserNames.map((n) => n.trim().toLowerCase()).filter(Boolean),
  ]);
  const findings: PrincipalFinding[] = [];
  for (const attribution of detectAttributions(text)) {
    if (known.has(attribution.principal)) continue; // resolves to a verified principal — fine
    const verdict: Verdict = BLOCK_KINDS.has(attribution.kind) ? 'block' : 'warn';
    findings.push({
      attribution,
      verdict,
      reason:
        `Operator-role ${attribution.kind} attributed to "${attribution.principal}", who is ` +
        (operator
          ? `not this topic's bound operator and does not resolve to a known user`
          : `unverifiable — this topic has no bound operator`) +
        `. Know Your Principal: an unrecognized party in a decision role is a question to resolve, not a fact to accept.`,
    });
  }
  return findings;
}
