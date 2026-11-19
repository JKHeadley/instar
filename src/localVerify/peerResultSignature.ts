/**
 * Signed peer results for Local Verify (docs/specs/local-verify-peer-result-trust.md, D1).
 *
 * A peer signs, with its machine key, a digest over the request it ran and the result it returns.
 * The coordinator checks that the request digest is the one it sent, that the signer is the peer it
 * dispatched to, and that the signature verifies under that peer's PINNED key at the coordinator's
 * own receive time. Anything else is refused and the verify runs on the coordinator.
 *
 * Pure: no I/O. The signer and the key lookup are passed in. This module must stay reachable from a
 * VERIFIER_ROOTS entry, so a change here changes the verifier version (mixed versions never import).
 */
import crypto from 'node:crypto';
import { canonicalJson } from '../core/appMediaTypes.js';
import { verifyMachineSignature, type MachineKeyLookup, type MachineSignature, type MachineSigner } from '../core/AppRecordSignatures.js';

export const PEER_RESULT_DOMAIN = 'instar-lv-peer-result-v1';

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

/** Exactly the JSON a body carries on the wire (no undefined, no NaN): what both sides digest. */
function wireJson(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/** The digest of a peer-run request, over the JSON as sent / as received. */
export function requestDigest(request: unknown): string {
  return sha256(canonicalJson(wireJson(request)));
}

/** The signed payload for one peer answer. */
export function peerResultPayload(body: { record: unknown; run?: unknown; requestDigest: string }): string {
  const digest = sha256(canonicalJson({ record: wireJson(body.record), run: wireJson(body.run ?? null), requestDigest: body.requestDigest }));
  return `${PEER_RESULT_DOMAIN}\n${digest}`;
}

/** Peer side: sign an answer. */
export function signPeerResult(signer: MachineSigner, body: { record: unknown; run?: unknown; requestDigest: string }): MachineSignature {
  const s = signer.sign(peerResultPayload(body));
  return { machineId: s.machineId, signerKeyHash: s.signerKeyHash, sig: s.sig };
}

export type PeerResultRefusal = 'unsigned' | 'request-mismatch' | 'signature-wrong-machine' | 'signature-unknown-key' | 'signature-bad';

function isSig(v: unknown): v is MachineSignature {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.machineId === 'string' && typeof o.signerKeyHash === 'string' && typeof o.sig === 'string'
    && o.machineId.length <= 200 && o.signerKeyHash.length <= 200 && o.sig.length <= 1024;
}

/**
 * Coordinator side: why a raw peer answer must NOT be imported, or null when its signature holds.
 * `raw` is the parsed body exactly as received (before any reshaping). `receivedAtMs` is the
 * coordinator's clock: a key revoked before receipt never verifies.
 */
export function verifyPeerResult(
  raw: { record?: unknown; run?: unknown; requestDigest?: unknown; sig?: unknown },
  expected: { peerMachineId: string; requestDigest: string },
  keyLookup: MachineKeyLookup,
  receivedAtMs: number,
): PeerResultRefusal | null {
  if (!isSig(raw.sig) || typeof raw.requestDigest !== 'string') return 'unsigned';
  if (raw.requestDigest !== expected.requestDigest) return 'request-mismatch';
  if (raw.sig.machineId !== expected.peerMachineId) return 'signature-wrong-machine';
  const payload = peerResultPayload({ record: raw.record, run: raw.run, requestDigest: raw.requestDigest });
  const v = verifyMachineSignature(keyLookup, raw.sig, payload, receivedAtMs);
  if (v === 'unknown') return 'signature-unknown-key';
  if (v === 'bad') return 'signature-bad';
  return null;
}
