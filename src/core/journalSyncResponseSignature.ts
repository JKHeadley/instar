/**
 * Signed `journal-sync` responses, for attribution only (SEC-088 part 2,
 * docs/specs/trust-records-holder-authored.md decision 5).
 *
 * The serving machine signs, with its registry-pinned Ed25519 machine key, the canonical array
 *   ['journal-sync-response', responder, requesterNonce, kind, incarnation, fromSeq, sha256(canonical entries)]
 * following the signed-response pattern of `AgentIdentityAdoption.ts` (a JSON array of the bound
 * fields, signed by the responder, verified by the requester against the registered key of the
 * machine it ASKED — never a key or machine id named in the body).
 *
 * Wire compatibility: the request gains an optional `requesterNonce` (older servers ignore it) and
 * the response gains an optional `sig` (older clients ignore it). A response with NO signature (an
 * older build) is accepted as today; there is no ratchet.
 *
 * What an INVALID signature costs: only that response's `trust-grant-record` entries are refused
 * (and counted by the caller as `journal.sync.badSignature`); every other kind is handled as today.
 * Honest limit (spec): an on-path attacker can strip the signature; under the holder-authored design
 * that can only narrow, never grant.
 *
 * PURE: no I/O. Signing/verification are injected so this module is unit-testable.
 */

import crypto from 'node:crypto';

/** The one kind whose entries an invalid signature refuses (decision 5). */
export const SIGNATURE_GATED_KIND = 'trust-grant-record';

/** Canonical JSON: object keys sorted recursively, `undefined` members dropped (as JSON.stringify does). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : sortDeep(v)));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      out[k] = sortDeep(v);
    }
    return out;
  }
  return value;
}

/** sha256 (hex) over the canonical JSON of the served entries. */
export function entriesDigest(entries: readonly unknown[]): string {
  return crypto.createHash('sha256').update(canonicalJson(entries ?? [])).digest('hex');
}

export interface JournalSyncResponseParts {
  /** The machine that served the batch (the client puts the machine it ASKED here). */
  responder: string;
  requesterNonce: string;
  kind: string;
  incarnation: string;
  fromSeq: number;
  entries: readonly unknown[];
}

/** The canonical bytes the response signature covers. */
export function canonicalJournalSyncResponse(p: JournalSyncResponseParts): string {
  return JSON.stringify([
    'journal-sync-response',
    p.responder,
    p.requesterNonce,
    p.kind,
    p.incarnation,
    p.fromSeq,
    entriesDigest(p.entries),
  ]);
}

/** Sign a served batch. `sign` signs canonical bytes with THIS machine's registry-pinned key. */
export function signJournalSyncResponse(p: JournalSyncResponseParts, sign: (canonical: string) => string): string {
  return sign(canonicalJournalSyncResponse(p));
}

/** A fresh per-request nonce (the client generates one for every request). */
export function mintRequesterNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

export type ResponseSignatureVerdict = 'valid' | 'unsigned' | 'invalid';

/**
 * Verify a served batch against the registered key of the machine that was ASKED.
 * - no `sig` at all (an older server) → 'unsigned' (accepted as today);
 * - a `sig` that is not a non-empty string, or that does not verify → 'invalid';
 * - `verifySig` throwing (no registered key, malformed key) → 'invalid'.
 */
export function verifyJournalSyncResponse(
  askedMachineId: string,
  requesterNonce: string,
  fromSeq: number,
  stream: { kind?: unknown; incarnation?: unknown; entries?: unknown },
  sig: unknown,
  verifySig: (machineId: string, canonical: string, sig: string) => boolean,
): ResponseSignatureVerdict {
  if (sig === undefined || sig === null) return 'unsigned';
  if (typeof sig !== 'string' || sig.length === 0) return 'invalid';
  if (!stream || typeof stream.kind !== 'string' || typeof stream.incarnation !== 'string' || !Array.isArray(stream.entries)) {
    return 'invalid';
  }
  const canonical = canonicalJournalSyncResponse({
    responder: askedMachineId,
    requesterNonce,
    kind: stream.kind,
    incarnation: stream.incarnation,
    fromSeq,
    entries: stream.entries,
  });
  try {
    return verifySig(askedMachineId, canonical, sig) ? 'valid' : 'invalid';
  } catch { /* @silent-fallback-ok: a signature that cannot be checked against the registered key is a refused attribution ('invalid'), never agreement. */
    return 'invalid';
  }
}

/**
 * Apply the verdict to one served stream. An INVALID signature refuses the stream's
 * `trust-grant-record` entries (returns `refusedEntries` for the caller to count); every other
 * kind, and every valid or unsigned response, passes through unchanged.
 */
export function screenJournalSyncStream<S extends { kind?: unknown; entries?: unknown }>(
  stream: S,
  verdict: ResponseSignatureVerdict,
): { stream: S | null; refusedEntries: number } {
  if (verdict !== 'invalid' || stream?.kind !== SIGNATURE_GATED_KIND) return { stream, refusedEntries: 0 };
  const n = Array.isArray(stream.entries) ? stream.entries.length : 0;
  return { stream: null, refusedEntries: n };
}
