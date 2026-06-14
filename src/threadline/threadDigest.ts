/**
 * threadDigest — the FROZEN, byte-precise v1 wire encoding for Threadline
 * canonical-history symmetry (Robustness Phase 2, D-D / FD-5 / LD1).
 *
 * These bytes cross to an INDEPENDENTLY-implemented peer (Dawn), so the encoding
 * is a published cross-agent interface and is frozen for `digestVersion: 1`. The
 * "Wire encoding (normative)" section of
 * docs/specs/THREADLINE-CANONICAL-HISTORY-SPEC.md pins every byte; this module is
 * the reference implementation of that section and the unit test pins reference
 * vectors a reimplementer must reproduce.
 *
 * Two values are defined here:
 *
 *  1. `contentDigest` — sha256 over an IDENTITY-FREE canonical projection of a
 *     message: `{ body, createdAt, messageId, threadId }`, RFC 8785 (JCS)
 *     serialized. Identity-free because name↔fingerprint is asymmetric across the
 *     two ends (Phase 1 grounding §5); hashing identity would manufacture false
 *     `diverged` on healthy threads. Both ends compute the SAME digest from the
 *     SAME bytes. The digest is ALWAYS recomputed locally on receive — a
 *     wire-supplied digest is a cross-check only, never trusted into the chain.
 *
 *  2. `setAccum` — an ORDER-INDEPENDENT, O(1)-maintained 256-bit modular-sum
 *     accumulator over the multiset of per-message digests. Order-independent
 *     because the two ends append in different local orders (inbound/outbound
 *     interleave; relay vs local-fastpath race), so an order-dependent fold would
 *     report permanent false `diverged`. Modular sum is commutative (two ends
 *     agree regardless of arrival order) and incremental (O(1) per append).
 *
 * HONEST STRENGTH BOUND (SA3): `(count, setAccum)` equality is a reliable
 * CONSISTENCY signal against a NON-adversarial peer — it is NOT a
 * collision-resistant proof against a *malicious* verified peer (a modular sum is
 * not collision-resistant). This is acceptable in Phase 2 ONLY because symmetry is
 * advisory-only (it never blocks a send, never binds, never gates an irreversible
 * action — Signal vs. Authority). An LtHash-style collision-resistant commitment
 * is the named Phase-3 hardening; the frozen v1 combiner lets a future
 * `digestVersion: 2` introduce it without breaking v1 chains.
 */

import { createHash } from 'node:crypto';

/** The frozen content-digest projection version carried per-entry and on threadSync. */
export const DIGEST_VERSION = 1;

/** Domain-separation label for the accumulator inner hash (frozen, LD1). */
const SETACCUM_DOMAIN = 'threadline-setaccum-v1';
/** 2^256 — the accumulator modulus (frozen). */
const MODULUS = 1n << 256n;

/**
 * The identity-FREE message core the content digest is computed over. Every field
 * is a value BOTH ends provably hold byte-identically: the message's own id, its
 * body text, the sender-stamped `createdAt`, and the threadId — NO sender
 * fingerprint / name / trust field (the asymmetry that would cause false
 * `diverged`).
 */
export interface MessageCore {
  threadId: string;
  messageId: string;
  /** The EXACT received UTF-8 body string. */
  body: string;
  /** The verbatim wire `createdAt` string — hashed AS RECEIVED, never re-parsed. */
  createdAt: string;
}

/** The additive wire field a peer sends so both ends can cross-verify a thread. */
export interface ThreadSync {
  digestVersion: number;
  /** Count of NON-backfilled entries of this digestVersion. */
  count: number;
  /** 64-hex lowercase, zero-padded — the modular-sum accumulator. */
  setAccum: string;
}

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * RFC 8785 (JCS) serialization of the FLAT, all-string content-digest projection.
 *
 * The projection is a flat object whose every value is a string, so JCS reduces
 * to: keys sorted lexicographically by code unit, each key and value emitted via
 * ECMAScript `JSON.stringify` (whose string escaping is RFC-8785-conformant — JCS
 * adopts ES string serialization verbatim), no whitespace. Non-ASCII body bytes
 * stay literal UTF-8 (JCS escapes only what JSON requires), which the reference
 * vector with a non-ASCII body pins. This is deliberately NOT a general JCS
 * implementation — it is correct for THIS frozen flat-string projection only; a
 * non-string value would be a programming error against the frozen shape.
 */
function jcsFlatStringObject(obj: Record<string, string>): string {
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(`${JSON.stringify(k)}:${JSON.stringify(obj[k])}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * Compute the v1 content digest over the identity-free projection
 * `{ body, createdAt, messageId, threadId }`. Lowercase-hex sha256 of the
 * UTF-8 JCS serialization.
 */
export function contentDigest(core: MessageCore): string {
  const projection: Record<string, string> = {
    body: core.body,
    createdAt: core.createdAt,
    messageId: core.messageId,
    threadId: core.threadId,
  };
  return sha256Hex(Buffer.from(jcsFlatStringObject(projection), 'utf-8'));
}

/**
 * The domain-separated inner hash of one content digest, as a 256-bit integer:
 * `H_acc(x) = sha256( utf8("threadline-setaccum-v1") || 0x00 || utf8(x) )`
 * interpreted big-endian. `x` is the lowercase-hex content-digest string.
 */
function hAcc(contentDigestHex: string): bigint {
  const buf = Buffer.concat([
    Buffer.from(SETACCUM_DOMAIN, 'utf-8'),
    Buffer.from([0x00]),
    Buffer.from(contentDigestHex, 'utf-8'),
  ]);
  return BigInt(`0x${sha256Hex(buf)}`);
}

/** Render a non-negative bigint < 2^256 as exactly 64 lowercase-hex chars. */
function toAccumHex(n: bigint): string {
  return n.toString(16).padStart(64, '0');
}

/** The accumulator value for an EMPTY set (zero), as 64-hex. */
export const EMPTY_SET_ACCUM = toAccumHex(0n);

/**
 * Fold one content digest into a running accumulator (O(1) incremental append).
 * `(accum + H_acc(contentDigest)) mod 2^256`. Commutative, so the order of folds
 * does not matter — the two ends converge regardless of local arrival order.
 */
export function setAccumAdd(accumHex: string, contentDigestHex: string): string {
  const acc = accumHex ? BigInt(`0x${accumHex}`) : 0n;
  return toAccumHex((acc + hAcc(contentDigestHex)) % MODULUS);
}

/**
 * Compute the accumulator over a whole multiset of content digests (the
 * rebuild-from-log path). Order-independent by construction.
 */
export function computeSetAccum(contentDigests: string[]): string {
  let acc = 0n;
  for (const cd of contentDigests) acc = (acc + hAcc(cd)) % MODULUS;
  return toAccumHex(acc);
}

/**
 * Equality test for two thread sync reports. Equality requires BOTH `count` and
 * `setAccum` (and the same `digestVersion`) — the count guards the (astronomically
 * unlikely, non-adversarial) case of a colliding sum at a different cardinality.
 * Returns false on any digestVersion mismatch (that is `version-skew`, handled by
 * the caller, never a benign equal).
 */
export function threadSyncEqual(a: ThreadSync, b: ThreadSync): boolean {
  return a.digestVersion === b.digestVersion && a.count === b.count && a.setAccum === b.setAccum;
}
