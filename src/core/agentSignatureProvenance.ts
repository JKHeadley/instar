/**
 * Agent-Signature Provenance (ASP v1)
 * ===================================
 *
 * Justin's words: "some official signature that agents/topics can send within
 * messages that the infra can detect to recognize messages that are NOT me,
 * even though they come from my account."
 *
 * A message arriving from the operator's account is, by default, indistinguishable
 * from one an agent sent through that same account. This module makes the two
 * machine-separable by attaching an Ed25519 signature to agent-authored messages
 * and verifying it on the way back in.
 *
 * THREE CASES (the acceptance bar):
 *   1. A message the operator types carries no tag  -> `human`
 *   2. A message an agent sends carries a valid tag -> `agent-verified` (+ named agent/topic)
 *   3. A forged / altered / swapped / replayed tag  -> `rejected` (never trusted provenance)
 *
 * ── AUTHORITY BOUNDARY (standing ruling, 2026-08-14) ───────────────────────
 * Provenance NEVER settles AUTHORITY. This module answers exactly one question:
 * "who authored these bytes?" It deliberately exposes no notion of permission,
 * role, or trust level, and a caller cannot derive one from its output. What an
 * agent-authored message is ALLOWED TO DECIDE is a separate, separately-recorded
 * decision. `agent-verified` means authenticated, NOT authorized.
 *
 * ── WHY CRYPTOGRAPHIC RATHER THAN HEURISTIC ────────────────────────────────
 * A heuristic authorship detector (see the agentAuthorshipSuspected layer) can
 * flag a message as *suspected* agent-authored from style or context. It cannot
 * reject an EXACT REPLAY: a byte-identical copy of a genuine agent message is,
 * to any heuristic, genuine — because it is. Only a signature bound to a
 * single-use nonce distinguishes the original from the copy. This layer upgrades
 * a SUSPECTED label into a PROVEN one; it does not replace the heuristic, which
 * still covers unsigned agent traffic.
 *
 * ── THREAT MODEL ───────────────────────────────────────────────────────────
 * The adversary has: normal send capability on the channel, full knowledge of
 * this format, and one captured valid agent message. The adversary lacks: the
 * signing key. Under those assumptions every forgery path below must fail
 * closed. The operator's own account being the transport is assumed — the whole
 * point is that account access does not confer agent identity.
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { sign, verify } from '../threadline/ThreadlineCrypto.js';

/** Wire version. Bump only for breaking preimage/format changes. */
export const ASP_VERSION = 'asp1' as const;

/**
 * Default clock-skew tolerance. A tag older or newer than this is `stale`.
 * This bounds how long a replay-nonce must be retained: a nonce older than the
 * window can be evicted, because a replay carrying it is rejected on age alone.
 */
export const DEFAULT_MAX_AGE_SECONDS = 900; // 15 minutes

/**
 * Field charset. agentId and nonce are restricted so no field can contain the
 * preimage separator ("\n") or the tag delimiters. This is what makes the
 * newline-separated preimage unambiguous and prevents field-splicing, where an
 * attacker moves a delimiter to re-interpret one field as two.
 */
const SAFE_FIELD = /^[A-Za-z0-9_-]{1,64}$/;

/** Tag delimiters. Chosen to be inert in Markdown, HTML and Telegram entities. */
const TAG_OPEN = '⟦'; // ⟦
const TAG_CLOSE = '⟧'; // ⟧

/**
 * Strict tag pattern, anchored. Field order is FIXED — a verifier that accepted
 * reordered fields would accept two distinct texts for one signature.
 */
const TAG_RE = new RegExp(
  `^${TAG_OPEN}asp1 a=([A-Za-z0-9_-]{1,64}) t=(-?\\d{1,19}) ts=(\\d{1,19}) n=([A-Za-z0-9_-]{1,64}) s=([A-Za-z0-9_-]{86,88})${TAG_CLOSE}$`
);

export interface AspTag {
  agentId: string;
  topicId: number;
  timestamp: number; // unix seconds
  nonce: string;
  signature: string; // base64url, unpadded
}

export type AspVerdict =
  | { classification: 'human'; body: string }
  | {
      classification: 'agent-verified';
      body: string;
      agentId: string;
      topicId: number;
      timestamp: number;
      nonce: string;
    }
  | { classification: 'rejected'; body: string; reason: AspRejectReason; agentId?: string };

export type AspRejectReason =
  | 'malformed'
  | 'unknown-agent'
  | 'bad-signature'
  | 'replay'
  | 'stale'
  | 'topic-mismatch';

/** Durable replay defence. Supplied by the caller so the store can outlive a process. */
export interface SeenNonceStore {
  /** True if this key has been accepted before. */
  has(key: string): boolean;
  /** Record an accepted key. `expiresAtMs` allows the store to evict safely. */
  add(key: string, expiresAtMs: number): void;
}

/** In-memory nonce store. Adequate for a single process; NOT durable across restarts. */
export class MemorySeenNonceStore implements SeenNonceStore {
  private readonly seen = new Map<string, number>();

  has(key: string): boolean {
    const expiry = this.seen.get(key);
    if (expiry === undefined) return false;
    if (expiry <= Date.now()) {
      this.seen.delete(key);
      return false;
    }
    return true;
  }

  add(key: string, expiresAtMs: number): void {
    this.seen.set(key, expiresAtMs);
    if (this.seen.size > 10_000) this.evict();
  }

  private evict(): void {
    const now = Date.now();
    for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k);
  }
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Build the signed preimage.
 *
 * Domain-separated by version and newline-delimited. Every field is charset- or
 * numerically-constrained so none can contain a newline; therefore the mapping
 * from (fields) to (preimage) is injective and two different field-sets can
 * never produce the same bytes. The body is included by hash, so the signature
 * covers the message content without bounding its size.
 */
export function buildPreimage(params: {
  agentId: string;
  topicId: number;
  timestamp: number;
  nonce: string;
  body: string;
}): Buffer {
  const { agentId, topicId, timestamp, nonce, body } = params;
  return Buffer.from(
    [ASP_VERSION, agentId, String(topicId), String(timestamp), nonce, sha256Hex(body)].join('\n'),
    'utf8'
  );
}

/** Render a tag line. Exported so tests and red-team tooling share one formatter. */
export function formatTag(tag: AspTag): string {
  return `${TAG_OPEN}asp1 a=${tag.agentId} t=${tag.topicId} ts=${tag.timestamp} n=${tag.nonce} s=${tag.signature}${TAG_CLOSE}`;
}

/**
 * Split a received message into (body, tag).
 *
 * ONLY the final line may be a tag, and only if it matches TAG_RE exactly.
 * Consequences, both deliberate:
 *  - A decoy tag earlier in the text stays part of the BODY, so it is covered by
 *    the body hash; adding one to a captured message breaks the signature.
 *  - Text appended AFTER a genuine tag means the last line is not a tag, so the
 *    message classifies as `human` rather than `agent-verified`. Attribution is
 *    lost, which is the safe direction: we never attribute altered bytes to an
 *    agent.
 */
export function splitTag(raw: string): { body: string; tag: AspTag | null; hadTagShape: boolean } {
  const normalized = raw.replace(/\r\n/g, '\n');
  const lastNewline = normalized.lastIndexOf('\n');
  if (lastNewline === -1) return { body: normalized, tag: null, hadTagShape: false };

  const candidate = normalized.slice(lastNewline + 1).trim();
  if (!candidate.startsWith(TAG_OPEN)) return { body: normalized, tag: null, hadTagShape: false };

  const body = normalized.slice(0, lastNewline).replace(/\n+$/, '');
  const m = TAG_RE.exec(candidate);
  if (!m) {
    // Tag-shaped but not well-formed: a forgery attempt, not operator prose.
    return { body, tag: null, hadTagShape: true };
  }

  const topicId = Number(m[2]);
  const timestamp = Number(m[3]);
  if (!Number.isSafeInteger(topicId) || !Number.isSafeInteger(timestamp)) {
    return { body, tag: null, hadTagShape: true };
  }

  return {
    body,
    tag: { agentId: m[1], topicId, timestamp, nonce: m[4], signature: m[5] },
    hadTagShape: true,
  };
}

/**
 * Sign an outbound agent message, returning the text to actually send.
 *
 * The tag is appended on its own final line. `body` is signed exactly as passed;
 * callers must not mutate it afterwards (any later edit invalidates the tag,
 * which is the point).
 */
export function signMessage(params: {
  agentId: string;
  topicId: number;
  body: string;
  privateKey: Buffer;
  timestamp?: number;
  nonce?: string;
}): { text: string; tag: AspTag } {
  const { agentId, topicId, body, privateKey } = params;

  if (!SAFE_FIELD.test(agentId)) {
    throw new Error(`agentSignatureProvenance: agentId must match ${SAFE_FIELD} (got ${JSON.stringify(agentId)})`);
  }
  if (!Number.isSafeInteger(topicId)) {
    throw new Error('agentSignatureProvenance: topicId must be a safe integer');
  }

  const timestamp = params.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = params.nonce ?? b64url(randomBytes(12));
  if (!SAFE_FIELD.test(nonce)) {
    throw new Error('agentSignatureProvenance: nonce charset');
  }

  const signature = b64url(sign(privateKey, buildPreimage({ agentId, topicId, timestamp, nonce, body })));
  const tag: AspTag = { agentId, topicId, timestamp, nonce, signature };
  return { text: `${body}\n${formatTag(tag)}`, tag };
}

/**
 * Classify a received message.
 *
 * Fails closed everywhere: any doubt yields `rejected`, never `agent-verified`.
 * An untagged message is `human` — that is the operator typing, case 1.
 */
export function verifyMessage(params: {
  raw: string;
  expectedTopicId?: number;
  resolvePublicKey: (agentId: string) => Buffer | null | undefined;
  seenNonces?: SeenNonceStore;
  nowSeconds?: number;
  maxAgeSeconds?: number;
}): AspVerdict {
  const { raw, expectedTopicId, resolvePublicKey, seenNonces } = params;
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxAge = params.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;

  const { body, tag, hadTagShape } = splitTag(raw);

  // Case 1: no tag at all -> the operator typed it.
  if (!tag) {
    if (hadTagShape) return { classification: 'rejected', body, reason: 'malformed' };
    return { classification: 'human', body };
  }

  // Bind to the channel we actually received on, when the caller knows it.
  if (expectedTopicId !== undefined && tag.topicId !== expectedTopicId) {
    return { classification: 'rejected', body, reason: 'topic-mismatch', agentId: tag.agentId };
  }

  // Freshness first: it is cheap, and it bounds nonce retention.
  if (Math.abs(now - tag.timestamp) > maxAge) {
    return { classification: 'rejected', body, reason: 'stale', agentId: tag.agentId };
  }

  const publicKey = resolvePublicKey(tag.agentId);
  if (!publicKey || publicKey.length !== 32) {
    return { classification: 'rejected', body, reason: 'unknown-agent', agentId: tag.agentId };
  }

  let signatureOk = false;
  try {
    const sig = fromB64url(tag.signature);
    if (sig.length === 64) {
      signatureOk = verify(
        publicKey,
        buildPreimage({
          agentId: tag.agentId,
          topicId: tag.topicId,
          timestamp: tag.timestamp,
          nonce: tag.nonce,
          body,
        }),
        sig
      );
    }
  } catch {
    signatureOk = false;
  }

  if (!signatureOk) {
    return { classification: 'rejected', body, reason: 'bad-signature', agentId: tag.agentId };
  }

  // Replay: a byte-identical copy of a genuine message. The signature is valid —
  // it is the SAME signature — so only single-use nonce state separates the
  // original from the copy. Checked last so a forged tag never mutates the store.
  if (seenNonces) {
    const key = `${tag.agentId}:${tag.nonce}`;
    if (seenNonces.has(key)) {
      return { classification: 'rejected', body, reason: 'replay', agentId: tag.agentId };
    }
    seenNonces.add(key, (tag.timestamp + maxAge) * 1000);
  }

  return {
    classification: 'agent-verified',
    body,
    agentId: tag.agentId,
    topicId: tag.topicId,
    timestamp: tag.timestamp,
    nonce: tag.nonce,
  };
}

/**
 * Constant-time signature comparison helper, for callers that cache a verdict
 * and later re-check it against a re-parsed tag.
 */
export function signaturesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
