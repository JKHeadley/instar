/**
 * Standing-authorization resolver (Standing-Authorization signal for
 * B17_FALSE_BLOCKER).
 *
 * Answers the DETERMINISTIC half of "has the verified operator already granted
 * the authority the agent is now asking for?": is there a VERIFIED-operator,
 * NON-forwarded, IN-WINDOW message that explicitly grants autonomy/preapproval?
 * It returns the structured grant (evidence + when + scope text) for the
 * MessagingToneGate; the gate makes the SEMANTIC call (does this grant cover the
 * SPECIFIC asked action, and is the action a FLOOR action?) per spec D4/D5. The
 * resolver never decides whether B17 fires.
 *
 * SAFETY (spec D6/D10, Know Your Principal):
 *  - Counts a row ONLY when attributable to the VERIFIED operator uid
 *    (`telegramUserId === operatorUid`) — NEVER `fromUser`, a content name, or
 *    the agent's own message. A missing/blank uid is non-attributable.
 *  - Counts a row ONLY when PROVABLY non-forwarded (`forwarded === false`). A
 *    row with an unknown/absent forwarded flag does NOT count (a forwarded
 *    operator message carries third-party content). Fail-safe: an unprovable
 *    grant never counts, so it can never suppress an ask.
 *
 * Pure: all reads are injected, so it is fully unit-testable.
 * Spec: docs/specs/BIAS-TO-ACTION-SPEC.md (D3/D4/D6/D9/D10).
 */

/** One inbound message row the resolver inspects (from the verified-operator history). */
export interface OperatorHistoryRow {
  /** Authenticated Telegram user id of the sender. Missing/blank ⇒ non-attributable. */
  telegramUserId?: number | string | null;
  /** Message text. */
  text?: string | null;
  /** Epoch ms the message arrived. */
  ts?: number | null;
  /**
   * Forwarded provenance. ONLY `false` (proven non-forwarded) lets a row count.
   * `true` or `undefined` (unknown / legacy row) ⇒ does NOT count (fail-safe).
   */
  forwarded?: boolean;
}

export interface StandingAuthorizationDeps {
  /** Verified operator uid for the topic, or null when none is bound. */
  getVerifiedOperatorUid(topicId: number | string): string | number | null;
  /** Recent inbound rows for the topic (newest-first or any order), bounded by the caller. */
  getRecentMessages(topicId: number | string): OperatorHistoryRow[];
  /** Now, injected for testability. */
  now(): number;
}

export interface StandingAuthorizationConfig {
  /** Max age of a grant to still count (ms). Default 24h (spec D9). */
  windowMs?: number;
  /** Max rows to scan (the caller may already bound; this is a backstop). Default 40. */
  maxRows?: number;
}

export interface StandingAuthorizationResult {
  present: boolean;
  /** Where the grant came from (only 'verified-operator-directive' for now). */
  source?: 'verified-operator-directive';
  /** Epoch ms of the granting message. */
  grantedAt?: number;
  /** The grant's surrounding text — the gate judges whether it covers the asked action. */
  grantedScope?: string;
  /** Bounded evidence quote (operator content) — the gate renders it as untrusted DATA. */
  evidenceQuote?: string;
  /** Why present:false — for telemetry/debug (never a security decision). */
  reason?: 'no-operator' | 'no-grant-in-window' | 'no-attributable-nonforwarded-row';
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ROWS = 40;

/**
 * Explicit autonomy/preapproval GRANT phrases an operator uses (inbound).
 * Distinct from the agent's ASK phrases. Deterministic SIGNAL only — the gate
 * judges whether the grant covers the specific asked action.
 */
const GRANT_PHRASES: readonly string[] = [
  'do it yourself',
  'fix it on your own',
  'fix it yourself',
  'on your own',
  'you have my preapproval',
  'you have my pre-approval',
  'my preapproval',
  'i preapprove',
  'i pre-approve',
  'go ahead',
  'go for it',
  'you have my approval',
  'you have my go-ahead',
  'you have the green light',
  'you have my blessing',
  'permission granted',
  'approved',
  'enter an autonomy session',
  'enter an autonomous session',
  'continue until',
  "you don't need to ask",
  'no need to ask',
  "don't wait for me",
  'act on your own',
];

/** Is the (already verified-operator, non-forwarded) text an explicit grant? */
function findGrantPhrase(text: string): string | null {
  const lc = text.toLowerCase();
  for (const phrase of GRANT_PHRASES) {
    if (lc.includes(phrase)) return phrase;
  }
  return null;
}

function attributableToOperator(row: OperatorHistoryRow, operatorUid: string | number): boolean {
  const uid = row.telegramUserId;
  // Missing/blank uid is NON-ATTRIBUTABLE — never a wildcard (spec D6).
  if (uid === undefined || uid === null || uid === '') return false;
  // Compare as strings to avoid number/string id mismatches.
  return String(uid) === String(operatorUid);
}

/**
 * Resolve standing authorization for a topic. Returns `present:false` unless a
 * VERIFIED-operator, PROVABLY-non-forwarded, IN-WINDOW message contains an
 * explicit grant phrase. Every uncertainty fails toward `present:false`.
 */
export function resolveStandingAuthorization(
  topicId: number | string,
  deps: StandingAuthorizationDeps,
  cfg: StandingAuthorizationConfig = {},
): StandingAuthorizationResult {
  const windowMs = cfg.windowMs ?? DEFAULT_WINDOW_MS;
  const maxRows = cfg.maxRows ?? DEFAULT_MAX_ROWS;

  const operatorUid = deps.getVerifiedOperatorUid(topicId);
  if (operatorUid === null || operatorUid === undefined || operatorUid === '') {
    return { present: false, reason: 'no-operator' };
  }

  const now = deps.now();
  const rows = (deps.getRecentMessages(topicId) ?? []).slice(0, maxRows);

  let sawAttributableRow = false;
  // Prefer the most recent grant: track the best (latest ts) match.
  let best: { ts: number; phrase: string; text: string } | null = null;

  for (const row of rows) {
    // (1) attributable to the verified operator
    if (!attributableToOperator(row, operatorUid)) continue;
    // (2) PROVABLY non-forwarded — only `forwarded === false` counts (D10 fail-safe)
    if (row.forwarded !== false) continue;
    sawAttributableRow = true;
    // (3) within the recency window
    const ts = typeof row.ts === 'number' ? row.ts : NaN;
    if (!Number.isFinite(ts) || now - ts > windowMs || ts > now + 60_000) continue;
    // (4) contains an explicit grant phrase
    const text = typeof row.text === 'string' ? row.text : '';
    if (!text) continue;
    const phrase = findGrantPhrase(text);
    if (!phrase) continue;
    if (!best || ts > best.ts) best = { ts, phrase, text };
  }

  if (!best) {
    return {
      present: false,
      reason: sawAttributableRow ? 'no-grant-in-window' : 'no-attributable-nonforwarded-row',
    };
  }

  // Bound the evidence quote (the gate renders it as untrusted DATA + scrubs it).
  const evidenceQuote = best.text.slice(0, 280);
  return {
    present: true,
    source: 'verified-operator-directive',
    grantedAt: best.ts,
    grantedScope: evidenceQuote,
    evidenceQuote,
  };
}
