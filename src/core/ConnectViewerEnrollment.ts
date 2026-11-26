import { createHash, randomBytes, verify } from 'node:crypto';
import { isStrictLowSDer, parseDevicePublicKey } from './MobileDeviceKeys.js';

export interface ConnectViewerBinding {
  readonly agentId: string;
  readonly targetMachineId: string;
  readonly keyDigest: string;
}

export interface ConnectViewerChallenge extends ConnectViewerBinding {
  readonly nonce: string;
  readonly expiresAt: number;
}

export function connectViewerEnrollmentMessage(challenge: ConnectViewerChallenge): Buffer {
  return Buffer.from(JSON.stringify([
    'instar-connect-enrollment-v1', 'look-only', challenge.agentId, challenge.targetMachineId,
    challenge.keyDigest, challenge.nonce, challenge.expiresAt,
  ]));
}

/** The trusted enrollment caller owns each challenge. Successful proof consumes it exactly once. */
export class ConnectViewerEnrollment {
  readonly challenge: ConnectViewerChallenge;
  #used = false;

  constructor(binding: ConnectViewerBinding, now = Date.now()) {
    if (!Number.isSafeInteger(now + 60_000) || !Number.isSafeInteger(now) || now < 0) throw new RangeError("Invalid enrollment time");
    this.challenge = Object.freeze({
      agentId: binding.agentId,
      targetMachineId: binding.targetMachineId,
      keyDigest: binding.keyDigest,
      nonce: randomBytes(32).toString('base64url'),
      expiresAt: now + 60_000,
    });
  }

  accept(publicKey: string, signature: string, now = Date.now()): ConnectViewerBinding | undefined {
    if (this.#used || !Number.isSafeInteger(now) || now < 0 || now < this.challenge.expiresAt - 60_000 || now >= this.challenge.expiresAt || !/^[\w-]{8,100}$/.test(signature)) return;
    const key = parseDevicePublicKey(publicKey);
    if (!key) return;
    const digest = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
    if (digest !== this.challenge.keyDigest) return;
    const bytes = Buffer.from(signature, 'base64url');
    if (bytes.toString('base64url') !== signature || !isStrictLowSDer(bytes) ||
        !verify('sha256', connectViewerEnrollmentMessage(this.challenge), key, bytes)) return;
    this.#used = true;
    return Object.freeze({
      agentId: this.challenge.agentId, targetMachineId: this.challenge.targetMachineId, keyDigest: digest,
    });
  }
}
