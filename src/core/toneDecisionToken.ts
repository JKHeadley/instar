/**
 * toneDecisionToken — the stateless join between a tone-gate HOLD and the
 * sender's explicit override of it
 * (docs/specs/tone-gate-contestation-evidence.md).
 *
 * WHY THIS EXISTS. `messaging-tone-gate` is ~99% of all graded decision volume and
 * every settled verdict was `unknown`: `tone-window-unknown-v1` is a window CLOSER,
 * not a grader, and no outcome evidence source was ever built. The gate's own
 * source already declares the intent — *"Agent overrides feed the decision-quality
 * meter as a signal — never authority."* — but nothing carried the decision's
 * identity from the hold to the override, so there was nothing to record against.
 *
 * WHY A TOKEN, NOT A CONTENT FINGERPRINT (cross-model review r7, codex gpt-5.5).
 * An earlier build fingerprinted the candidate text and looked it up at delivery
 * time. That required an HMAC key file + its lifecycle, a durable store, a
 * retention window, a scope tuple, and a heuristic tie-break for repeated
 * identical text — an elaborate local cache reconstructing a link that can simply
 * be HANDED OVER. The advisory response already travels to the sender and the
 * sender already re-sends; carrying the decision's identity along that existing
 * round trip is exact, needs no stored state, cannot be confused by two identical
 * messages, and travels across machines with the retry.
 *
 * THE TOKEN IS SIGNED, NOT A BARE ID. A bare correlation id in a client-supplied
 * field would let any caller annotate an arbitrary decision `wrong`. The token is
 * an HMAC envelope over (correlationId, rule, expiry) under a process-lifetime
 * key: the seam mints it when it holds and verifies it when the override arrives,
 * accepting nothing it did not itself issue.
 *
 * HONESTY. The grade this produces is `wrong` at `self-report` strength: an
 * override establishes that the sender CHOSE TO BYPASS the hold, never that the
 * gate was objectively wrong. Silence — a quiet PASS, an unoverridden hold — is
 * never a grade at all.
 */

import * as crypto from 'node:crypto';

/** The evidence rule id (immutable + versioned, §5.4.5). */
export const TONE_OVERRIDE_WRONG_RULE_ID = 'tone-advisory-override-wrong-v1';

/** Annotate-chokepoint owner for the rule (ADV r5 owner pin). */
export const TONE_GATE_COMPONENT = 'MessagingToneGate';

/**
 * Token lifetime. An override is an immediate round trip — minutes, not hours.
 * A short expiry bounds replay without needing any stored state.
 */
export const TONE_TOKEN_TTL_MS = 30 * 60 * 1000;

/**
 * Process-lifetime signing key. Deliberately NOT persisted: a token only has to
 * survive one request round trip, so a restart invalidating outstanding tokens
 * costs at most the overrides in flight during that second — which then settle
 * `unknown` (the safe direction), never mis-graded. Not persisting removes the
 * key file, its permissions, its corruption modes and its rotation story entirely.
 */
const SIGNING_KEY = crypto.randomBytes(32);

function sign(payload: string): string {
  // FULL HMAC-SHA256, not truncated (round-9, gemini-3.1-pro f1). Truncation to
  // 128 bits was safe for a 30-minute window but bought nothing measurable — a
  // token is not bandwidth-constrained. Standard practice is the full MAC.
  return crypto.createHmac('sha256', SIGNING_KEY).update(payload, 'utf8').digest('hex');
}

/**
 * A short public id for THIS process's signing key (round-9, codex gpt-5.5 f3).
 * Carried in the token so a token minted by a DIFFERENT process/machine is
 * classified `foreign-key` rather than `bad-signature` — otherwise ordinary
 * multi-machine retry routing would masquerade as forgery in the counters and
 * train an operator to ignore a real attack signal. It identifies the key, never
 * reveals it: a separate HMAC of a fixed label under the same key.
 */
export const KEY_ID: string = crypto
  .createHmac('sha256', SIGNING_KEY)
  .update('tone-decision-token/key-id', 'utf8')
  .digest('hex')
  .slice(0, 12);

/**
 * Mint a token binding THIS decision to THIS hold. Returns null when there is no
 * correlation id (a decision that never reached the router — the deterministic
 * degrade arms), so the caller simply omits the field.
 */
export function mintToneDecisionToken(
  correlationId: string | undefined,
  rule: string,
  nowMs: number = Date.now(),
): string | null {
  if (!correlationId || !rule) return null;
  if (correlationId.includes('.') || rule.includes('.')) return null; // payload is dot-delimited
  const exp = nowMs + TONE_TOKEN_TTL_MS;
  const payload = `${correlationId}.${rule}.${exp}`;
  return `${KEY_ID}.${Buffer.from(payload, 'utf8').toString('base64url')}.${sign(payload)}`;
}

export type ToneTokenRejection =
  | 'malformed'
  | 'bad-signature'
  | 'expired'
  | 'rule-mismatch'
  /**
   * Minted under a DIFFERENT key — another process or another machine (r9 f3).
   * Expected and benign under multi-machine retry routing or across a restart;
   * deliberately NOT counted as `bad-signature`, so that counter stays a real
   * forgery signal instead of routine topology noise.
   */
  | 'foreign-key';

export interface ToneTokenVerdict {
  readonly correlationId: string | null;
  readonly rejected: ToneTokenRejection | null;
}

/**
 * Verify a caller-supplied token and recover the correlation id it authorizes.
 *
 * FAIL-CLOSED at every step: malformed, bad signature, expired, or minted for a
 * DIFFERENT rule than the one now being acknowledged all yield
 * `correlationId: null`. A rejected token never grades anything — the decision
 * settles `unknown` like any unobserved one.
 *
 * The rule binding matters: without it, a token minted for one advisory hold
 * could be replayed to annotate a different decision under a different rule.
 */
export function verifyToneDecisionToken(
  token: unknown,
  expectedRule: string,
  nowMs: number = Date.now(),
): ToneTokenVerdict {
  if (typeof token !== 'string' || token.length === 0 || token.length > 512) {
    return { correlationId: null, rejected: 'malformed' };
  }
  const parts0 = token.split('.');
  if (parts0.length !== 3) return { correlationId: null, rejected: 'malformed' };
  const [keyId, encoded, mac] = parts0;
  if (!keyId || !encoded || !mac) return { correlationId: null, rejected: 'malformed' };
  // Key identity FIRST: a token from another process is topology, not an attack.
  if (keyId !== KEY_ID) return { correlationId: null, rejected: 'foreign-key' };

  let payload: string;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    // @silent-fallback-ok: an undecodable token is a rejection, never a throw.
    return { correlationId: null, rejected: 'malformed' };
  }

  // Constant-time compare — the MAC is the only thing between a caller and
  // annotating an arbitrary decision.
  const expected = sign(payload);
  const a = Buffer.from(mac, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { correlationId: null, rejected: 'bad-signature' };
  }

  const parts = payload.split('.');
  if (parts.length !== 3) return { correlationId: null, rejected: 'malformed' };
  const [correlationId, rule, expRaw] = parts;
  if (!correlationId) return { correlationId: null, rejected: 'malformed' };
  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(exp) || nowMs > exp) return { correlationId: null, rejected: 'expired' };
  if (rule !== expectedRule) return { correlationId: null, rejected: 'rule-mismatch' };

  return { correlationId, rejected: null };
}

/* ── Observability counters (no content, no key material) ─────────────────── */

export interface ToneContestationCounters {
  /** Tokens minted on an advisory hold. */
  minted: number;
  /** Overrides that arrived WITH a valid token and were graded. */
  gradedViaToken: number;
  /**
   * Overrides that arrived with NO token. On a pool — or from a caller that has
   * not been updated — this is the miss made countable: the override happened,
   * the decision it answers is not identifiable, so it settles `unknown`. The
   * override count is a lower bound and THIS is how loose that bound is.
   */
  overridesWithoutToken: number;
  /**
   * Tokens rejected, by reason. `bad-signature` is a real forgery signal;
   * `foreign-key` is routine multi-machine/restart topology and must NOT be read
   * as one (r9 f3).
   */
  rejected: Record<ToneTokenRejection, number>;
}

const _counters: ToneContestationCounters = {
  minted: 0,
  gradedViaToken: 0,
  overridesWithoutToken: 0,
  rejected: { malformed: 0, 'bad-signature': 0, expired: 0, 'rule-mismatch': 0, 'foreign-key': 0 },
};

export function bumpToneTokenMinted(): void { _counters.minted++; }
export function bumpToneGradedViaToken(): void { _counters.gradedViaToken++; }
export function bumpToneOverrideWithoutToken(): void { _counters.overridesWithoutToken++; }
export function bumpToneTokenRejected(reason: ToneTokenRejection): void { _counters.rejected[reason]++; }

export function getToneContestationCounters(): Readonly<ToneContestationCounters> {
  return { ..._counters, rejected: { ..._counters.rejected } };
}

/** Test-only seam (the `_resetDecisionQualityForTest` precedent). */
export function _resetToneContestationCountersForTest(): void {
  _counters.minted = 0;
  _counters.gradedViaToken = 0;
  _counters.overridesWithoutToken = 0;
  _counters.rejected = { malformed: 0, 'bad-signature': 0, expired: 0, 'rule-mismatch': 0, 'foreign-key': 0 };
}
