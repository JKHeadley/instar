import { createHash, type KeyObject } from 'node:crypto';
import { verifyConnectConsentFrame } from './ConnectConsentWireFrame.js';

export type ConsentActivationKind = 'decision' | 'ack' | 'confirm' | 'active';

export interface ConsentActivationFields {
  readonly sessionId: string;
  readonly digest: string;
  readonly transcriptDigest: string;
  readonly generation: string;
  readonly nonce?: string;
  readonly decision?: 'allow' | 'decline';
  readonly deadline?: number;
}

/** The caller chooses the expected message and supplies the pinned key for its role. */
export function verifyConsentActivation(
  frame: Buffer, signer: KeyObject, kind: ConsentActivationKind,
): ConsentActivationFields | undefined {
  const bytes = verifyConnectConsentFrame(frame, signer);
  if (!bytes) return;
  const domain = Buffer.from('instar-connect-consent-' + kind + '-v1');
  if (bytes.length < 2 + domain.length || bytes.readUInt16BE(0) !== domain.length ||
      !bytes.subarray(2, 2 + domain.length).equals(domain)) return;
  const payload = bytes.subarray(2 + domain.length);
  const transcriptDigest = createHash("sha256").update(bytes).digest("hex");
  if (kind === 'decision') {
    if (payload.length < 114) return;
    const size = payload.readUInt16BE(112);
    if (payload.length !== 114 + size) return;
    const word = payload.subarray(114);
    const decision = word.equals(Buffer.from('allow')) ? 'allow' : word.equals(Buffer.from('decline')) ? 'decline' : undefined;
    if (!decision) return;
    return {
      transcriptDigest,
      digest: payload.toString('hex', 0, 32), sessionId: payload.toString('hex', 32, 48),
      nonce: payload.toString('hex', 48, 80), generation: payload.toString('hex', 80, 112), decision,
    };
  }
  if (payload.length !== (kind === 'confirm' ? 80 : 88)) return;
  const offset = kind === 'ack' ? 0 : 32;
  const fields = {
    transcriptDigest,
    sessionId: payload.toString('hex', offset, offset + 16),
    digest: kind === 'ack' ? payload.toString('hex', 16, 48) : payload.toString('hex', 0, 32),
    generation: payload.toString('hex', 48, 80),
  };
  if (kind === 'confirm') return fields;
  const deadline = Number(payload.readBigUInt64BE(80));
  if (!Number.isSafeInteger(deadline) || deadline <= 0) return;
  return { ...fields, deadline };
}
