/**
 * SEAL references — how a Witness record points at a SealKeeper SEAL.
 *
 * PROVISIONAL. The `sealkeeper:seal:1:` form is Dawn's reading of SealKeeper's
 * written standard (Carl, Oct 14 2026): one reference string under 200 chars,
 * `sealkeeper:seal:1:<party>:<sha256 hex of the SEAL>:<SEAL read URL>`. Carl has
 * not yet confirmed that reading, so every output that touches this form says
 * `provisional: true`. If his party ids can contain a colon, this parser is
 * ambiguous and must change before the form is final.
 *
 * Two forms are accepted:
 *   sealkeeper:seal:1:<party>:<sha256>:<url>   SealKeeper's one reference string
 *   seal:sha256:<hex>                          the Witness v0 form; still accepted
 *
 * Only the sha256 is trusted: it is what the SEAL bytes are checked against.
 * Party and URL are labels the issuer wrote; nothing here verifies them, and
 * verify says so. SealKeeper does not serve past SEALs by hash (the read URL
 * returns the CURRENT SEAL, not the one the record names), so the bytes travel
 * with the record and are checked by hash, never fetched.
 */

import crypto from 'node:crypto';

export const SEALKEEPER_REFERENCE_PREFIX = 'sealkeeper:seal:1:';
export const LEGACY_SEAL_PREFIX = 'seal:sha256:';
/** SealKeeper's standard: the whole reference string stays under 200 characters. */
export const MAX_SEALKEEPER_REFERENCE = 200;
export const SEAL_REFERENCE_PROVISIONAL_NOTE =
  'provisional: the sealkeeper:seal:1 reference form is our reading of SealKeeper\'s standard and SealKeeper has not yet confirmed it';
export const SEAL_LABELS_NOTE = 'party and url are unverified labels written by the issuer; only the sha256 is checked';

export type SealReference =
  | {
      format: 'sealkeeper-v1';
      reference: string;
      sha256: string;
      party: string;
      url: string;
      trusted: ['sha256'];
      unverified: ['party', 'url'];
      provisional: true;
    }
  | { format: 'legacy'; reference: string; sha256: string; trusted: ['sha256']; unverified: []; provisional: false }
  | { format: 'malformed'; reference: string; reason: string; provisional: true };

export function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Parses one evidence item. Returns null when the item is not a SEAL reference
 * at all (an ordinary URL, a thread id). A `sealkeeper:seal:1:` item is split on
 * its first five colons only; everything after the fifth colon is the URL, because
 * a URL contains colons itself.
 */
export function parseSealReference(item: string): SealReference | null {
  if (typeof item !== 'string') return null;
  if (item.startsWith(LEGACY_SEAL_PREFIX)) {
    const hex = item.slice(LEGACY_SEAL_PREFIX.length).toLowerCase();
    if (!HEX64.test(hex)) return null; // not a SEAL reference, just text that starts like one
    return { format: 'legacy', reference: item, sha256: hex, trusted: ['sha256'], unverified: [], provisional: false };
  }
  if (!item.startsWith(SEALKEEPER_REFERENCE_PREFIX)) return null;
  const malformed = (reason: string): SealReference => ({ format: 'malformed', reference: item, reason, provisional: true });
  if (item.length > MAX_SEALKEEPER_REFERENCE) return malformed(`longer than ${MAX_SEALKEEPER_REFERENCE} characters`);
  // Find the first five colons by hand: String.split with a limit drops the rest.
  const colons: number[] = [];
  for (let i = 0; i < item.length && colons.length < 5; i++) if (item[i] === ':') colons.push(i);
  if (colons.length < 5) return malformed('fewer than five colons: expected sealkeeper:seal:1:<party>:<sha256>:<url>');
  const party = item.slice(colons[2] + 1, colons[3]);
  const sha256 = item.slice(colons[3] + 1, colons[4]).toLowerCase();
  const url = item.slice(colons[4] + 1);
  if (!party) return malformed('empty party');
  if (!HEX64.test(sha256)) return malformed('the sha256 field is not 64 hex characters');
  if (!url) return malformed('empty url');
  return {
    format: 'sealkeeper-v1', reference: item, sha256, party, url,
    trusted: ['sha256'], unverified: ['party', 'url'], provisional: true,
  };
}

/**
 * Builds SealKeeper's reference string. Throws on anything the form cannot carry:
 * a party containing a colon (the parser could not tell it from the hash field),
 * a non-https url, a bad hash, or a string over the 200-character limit.
 */
export function formatSealkeeperReference(input: { party: string; sha256: string; url: string }): string {
  const { party, url } = input;
  const sha256 = input.sha256.toLowerCase();
  if (!party) throw new TypeError('party must not be empty');
  if (party.includes(':')) throw new TypeError('party must not contain a colon: the sealkeeper:seal:1 form splits on colons');
  if (!HEX64.test(sha256)) throw new TypeError('sha256 must be 64 hex characters');
  if (!/^https:\/\/\S+$/.test(url)) throw new TypeError('url must be an https URL');
  const reference = `${SEALKEEPER_REFERENCE_PREFIX}${party}:${sha256}:${url}`;
  if (reference.length > MAX_SEALKEEPER_REFERENCE) {
    throw new RangeError(`the reference is ${reference.length} characters; SealKeeper allows at most ${MAX_SEALKEEPER_REFERENCE}`);
  }
  const back = parseSealReference(reference);
  if (!back || back.format !== 'sealkeeper-v1' || back.party !== party || back.url !== url) {
    throw new TypeError('the reference does not parse back to its own fields'); // unreachable by construction; kept as a guard
  }
  return reference;
}

/** Every SEAL reference among a record's evidence items, in order. */
export function sealReferencesIn(evidence: readonly string[]): SealReference[] {
  const out: SealReference[] = [];
  for (const item of evidence) {
    const ref = parseSealReference(item);
    if (ref) out.push(ref);
  }
  return out;
}

export interface SealBytesCheck {
  /** sha256 → the bytes, for every supplied SEAL that matches a reference. */
  matched: Map<string, Uint8Array>;
  /** The sha256 of each supplied SEAL that matches NO reference. One of these is a refusal. */
  unmatched: string[];
}

/**
 * Checks supplied SEAL bytes against the references they are claimed to belong to.
 * The hash is the only link: a SEAL whose bytes hash to a referenced sha256 is that
 * SEAL; one that hashes to nothing referenced is a mismatch, never silently kept.
 */
export function checkSealBytes(references: readonly SealReference[], seals: readonly Uint8Array[]): SealBytesCheck {
  const wanted = new Set(references.flatMap((r) => (r.format === 'malformed' ? [] : [r.sha256])));
  const matched = new Map<string, Uint8Array>();
  const unmatched: string[] = [];
  for (const bytes of seals) {
    const hash = sha256Hex(bytes);
    if (wanted.has(hash)) matched.set(hash, bytes);
    else unmatched.push(hash);
  }
  return { matched, unmatched };
}
