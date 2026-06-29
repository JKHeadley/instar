/**
 * Bias-to-Action observe-only telemetry (BIAS-TO-ACTION-SPEC D8).
 *
 * A SIGNAL-producer (never an authority): when the feature runs observe-only
 * (the default), the outbound seam records what the live B17 sub-clause WOULD
 * have judged — without ever altering a message. This module is the pure,
 * unit-testable core of that record so the route seam stays a thin caller.
 *
 * PRIVACY (the load-bearing contract): the would-fire record carries ONLY a
 * source enum, the matched ASK-phrase token, the grant timestamp, and a SHORT
 * HASH of the verified-operator uid — NEVER the raw operator uid and NEVER the
 * grant's raw quote (the operator's actual words). A record is produced ONLY
 * when the agent is actually ASKING and a grant is PRESENT — the exact case the
 * live clause would have to judge.
 */
import { createHash } from 'node:crypto';

export interface BiasToActionWouldFireInput {
  topicId: number;
  /** Did the ask-when-authorized detector fire on the outbound text? */
  asking: boolean;
  /** Did the resolver find a verified standing-authorization grant? */
  present: boolean;
  /** The grant source enum (e.g. 'verified-operator-directive'). */
  source?: string;
  /** The matched ASK phrase token (the agent's words, not the operator's). */
  askPhrase?: string | null;
  /** The VERIFIED operator uid — HASHED here, never emitted raw. */
  operatorUid: string | number | null;
  /** Epoch ms of the granting message. */
  grantedAt?: number | null;
}

export interface BiasToActionWouldFireRecord {
  t: string;
  kind: 'bias-to-action-would-fire';
  topicId: number;
  source: string;
  askPhrase: string | null;
  /** SHA-256(uid) truncated to 12 hex chars — never the raw uid. */
  operatorUidHash: string;
  grantedAt: number | null;
}

/** Short, stable, non-reversible hash of the operator uid for the telemetry log. */
export function hashOperatorUid(uid: string | number | null | undefined): string {
  return createHash('sha256').update(String(uid ?? '')).digest('hex').slice(0, 12);
}

/**
 * Build the observe-only would-fire record, or `null` when no record should be
 * written. Pure — `now` is injected for testability. A record is produced ONLY
 * when BOTH `asking` and `present` hold (the live-clause case); every other
 * combination returns null (nothing to record).
 */
export function buildBiasToActionWouldFire(
  input: BiasToActionWouldFireInput,
  now: () => number = Date.now,
): BiasToActionWouldFireRecord | null {
  if (!input.asking || !input.present) return null;
  return {
    t: new Date(now()).toISOString(),
    kind: 'bias-to-action-would-fire',
    topicId: input.topicId,
    source: input.source ?? 'verified-operator-directive',
    askPhrase: input.askPhrase ?? null,
    operatorUidHash: hashOperatorUid(input.operatorUid),
    grantedAt: input.grantedAt ?? null,
  };
}
