/**
 * One record against one binding, checked entirely on this machine.
 *
 * This is the check `witness verify` has always run, pulled into a function so
 * that every other path which must trust a record — publishing one, and reading
 * one back from a registry — runs the IDENTICAL sequence instead of a copy:
 *
 *   1. the binding's own shape and two signatures (verifyBinding);
 *   2. the record's issuer is the agent the binding names;
 *   3. for a did:key issuer, the issuer IS the binding's Threadline key, so a
 *      binding somebody else made under the issuer's name is refused;
 *   4. the record's shape and signature against the binding's Witness key
 *      (verifyRecord), which also reports an expired-but-genuine record.
 *
 * It does not walk a binding chain: a superseded or revoked binding still
 * verifies here, as it does in `witness verify`. The store applies chain rules.
 * A registry's word about any of this is never consulted; the registry is a
 * place to find records, and the signature is the authority.
 */

import { verifyBinding, type KeyBinding } from './binding.js';
import { publicKeyFromDidKey } from './didkey.js';
import { verifyRecord, type WitnessRecord } from './record.js';

export type LocalVerifyResult =
  | {
      ok: true;
      expired: boolean;
      binding: KeyBinding;
      record: WitnessRecord;
      threadlineFingerprint: string;
      issuerKeyCheck: string;
    }
  | { ok: false; reason: string };

export const ISSUER_KEY_CHECKED = 'checked: the issuer did:key is the binding\'s Threadline key';
export const ISSUER_KEY_NOT_CHECKED =
  'NOT checked offline: a did:web issuer\'s key is in its did document, so this binding is only known to carry the issuer\'s name';

/**
 * Verify `record` against `binding`, both as parsed JSON of unknown shape.
 * The returned `reason` strings are the ones `witness verify` prints; a registry
 * running the same package returns them unchanged on a 422.
 */
export function verifyRecordWithBinding(record: unknown, binding: unknown, now: Date = new Date()): LocalVerifyResult {
  const b = verifyBinding(binding);
  if (!b.ok) return { ok: false, reason: `binding: ${b.reason}` };
  if (!record || typeof record !== 'object') return { ok: false, reason: 'record is not an object' };
  const issuer = (record as { issuer?: unknown }).issuer;
  if (issuer !== b.binding.agent) return { ok: false, reason: 'the record\'s issuer is not the agent this binding names' };
  // A binding only names the issuer by string; anyone can make one with their own keys
  // under your name. For did:key the name IS the Threadline key, so check it offline.
  let issuerKeyCheck: string;
  if (b.binding.agent.startsWith('did:key:')) {
    const named = publicKeyFromDidKey(b.binding.agent);
    if (!named) return { ok: false, reason: 'the issuer is a did:key but not an Ed25519 one' };
    if (named !== b.binding.threadline_public_key) {
      return { ok: false, reason: 'the binding\'s Threadline key is not the key the issuer did:key names (a binding made by someone else)' };
    }
    issuerKeyCheck = ISSUER_KEY_CHECKED;
  } else {
    issuerKeyCheck = ISSUER_KEY_NOT_CHECKED;
  }
  const verdict = verifyRecord(record, b.binding.witness_public_key, now);
  if (!verdict.ok) return verdict;
  return {
    ok: true,
    expired: verdict.expired,
    binding: b.binding,
    record: record as WitnessRecord,
    threadlineFingerprint: b.binding.threadline_fingerprint,
    issuerKeyCheck,
  };
}
