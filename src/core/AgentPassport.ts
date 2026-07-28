/**
 * AgentPassport — the EXO 3.0 "digital passport" (Salim Ismail, "The 80-Year
 * Business Rule AI Just Broke"): "every AI agent gets a digital passport with
 * metadata saying what it's allowed to do and what it's not allowed to do, and
 * other AI agents watching that it's complying."
 *
 * Instar already has the primitives — agent identity (name + routing
 * fingerprint), a trust level, and ORG-INTENT constraints (forbidden actions).
 * This module PACKAGES them into one explicit, portable passport object plus a
 * deterministic `permits()` check, so a peer agent can read a passport and
 * decide whether to trust a proposed action BEFORE it happens. Deterministic +
 * advisory; the caller decides what to do with the verdict.
 */

// ── Types ────────────────────────────────────────────────────────────

export type TrustLevel = 'untrusted' | 'supervised' | 'collaborative' | 'autonomous';

export interface PassportInput {
  agent: string;
  fingerprint: string;
  trustLevel?: TrustLevel;
  /** Capabilities this agent is scoped to (empty = unrestricted by capability). */
  allowedCapabilities?: string[];
  /** Actions this agent must never do (e.g. ORG-INTENT constraints). */
  forbiddenActions?: string[];
  /** ISO timestamp the passport was issued (caller-supplied to stay pure). */
  issuedAt: string;
}

export interface AgentPassport {
  version: 1;
  agent: string;
  fingerprint: string;
  trustLevel: TrustLevel;
  allowedCapabilities: string[];
  forbiddenActions: string[];
  issuedAt: string;
}

export interface PermitVerdict {
  permitted: boolean;
  /** 'forbidden-action' | 'out-of-scope' | 'trust-floor' | 'ok' */
  basis: 'forbidden-action' | 'out-of-scope' | 'trust-floor' | 'ok';
  reason: string;
  /** The forbidden action that matched, if any. */
  matched?: string;
}

// ── Helpers (keyword overlap, shared shape with IntentTestHarness) ───

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'with', 'and', 'or', 'any', 'that', 'this', 'is', 'are', 'be', 'on', 'in', 'it', 'its', 'our', 'your', 'their', 'all', 'from', 'by']);
function normalize(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function words(s: string): string[] {
  return normalize(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w));
}
function overlap(a: string, b: string): number {
  const wa = words(a), wb = words(b);
  if (!wa.length || !wb.length) return 0;
  const setB = new Set(wb);
  return wa.filter((w) => setB.has(w)).length / Math.min(wa.length, wb.length);
}
const MATCH = 0.6;

// Trust floors: an untrusted passport may only read/observe; supervised+ may act.
const ACTING_VERBS = ['wire', 'send', 'delete', 'deploy', 'pay', 'publish', 'transfer', 'modify', 'write', 'execute', 'purchase', 'sign'];
function isActing(action: string): boolean {
  const w = new Set(words(action));
  return ACTING_VERBS.some((v) => w.has(v));
}

// ── Public API ───────────────────────────────────────────────────────

export function buildPassport(input: PassportInput): AgentPassport {
  return {
    version: 1,
    agent: input.agent,
    fingerprint: input.fingerprint,
    trustLevel: input.trustLevel ?? 'supervised',
    allowedCapabilities: input.allowedCapabilities ?? [],
    forbiddenActions: input.forbiddenActions ?? [],
    issuedAt: input.issuedAt,
  };
}

/**
 * The compliance check a peer runs against a passport before trusting an action.
 * Order: forbidden-action (hard no) → trust-floor (untrusted can't act) →
 * capability-scope (if scoped, the action must be in scope) → ok.
 */
export function permits(passport: AgentPassport, action: string): PermitVerdict {
  // A passport supplied by a PEER may be partial/malformed — its whole purpose is
  // that another agent reads it. Default the array fields so a missing field yields
  // a verdict, never a crash (was: HTTP 500 "Cannot read properties of undefined
  // (reading 'length')" when allowedCapabilities was omitted; forbiddenActions was
  // likewise unguarded → "not iterable"). See exo3-harness passport-verify-robustness.
  const forbiddenActions = passport.forbiddenActions ?? [];
  const allowedCapabilities = passport.allowedCapabilities ?? [];
  for (const f of forbiddenActions) {
    if (overlap(action, f) >= MATCH) {
      return { permitted: false, basis: 'forbidden-action', reason: `Forbidden by the passport: "${f}".`, matched: f };
    }
  }
  if (passport.trustLevel === 'untrusted' && isActing(action)) {
    return { permitted: false, basis: 'trust-floor', reason: 'Untrusted passport may observe but not act.' };
  }
  if (allowedCapabilities.length > 0) {
    const inScope = allowedCapabilities.some((c) => overlap(action, c) >= MATCH);
    if (!inScope) {
      return { permitted: false, basis: 'out-of-scope', reason: 'Action is outside the passport\'s allowed capabilities.' };
    }
  }
  return { permitted: true, basis: 'ok', reason: 'Permitted: violates no forbidden action and is within scope.' };
}
