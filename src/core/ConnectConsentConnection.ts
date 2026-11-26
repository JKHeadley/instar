import { createHash, randomBytes, type KeyObject } from 'node:crypto';
import { verifyConnectConsentFrame } from './ConnectConsentWireFrame.js';

export interface ConnectCompanionPairing {
  readonly agentId: string;
  readonly targetId: string;
  readonly companionKeyDigest: string;
  readonly revision: number;
}

function text(value: string): Buffer {
  const bytes = Buffer.from(value);
  if (!bytes.length || bytes.length > 128 || bytes.toString('utf8') !== value) throw new RangeError('Invalid Connect identifier');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function positiveSafeInteger(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('Invalid Connect integer');
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

interface ConnectionClock {
  wall(): number;
  monotonic(): number;
}

const systemClock: ConnectionClock = { wall: Date.now, monotonic: () => performance.now() };

export class ConnectConsentConnection {
  readonly generation = randomBytes(32).toString('hex');
  readonly #nonce = randomBytes(32);
  readonly #deadline: number;
  readonly #monotonicDeadline: number;
  readonly #onTransportClose = () => this.close();
  readonly #challenge: Buffer;
  #state: 'pending' | 'admitted' | 'closed' = 'pending';

  constructor(pairing: ConnectCompanionPairing, private readonly companion: KeyObject,
      private readonly pairingStillCurrent: () => boolean, private readonly transport: AbortSignal,
      private readonly clock: ConnectionClock = systemClock) {
    if (!/^[a-f0-9]{64}$/.test(pairing.companionKeyDigest) ||
        createHash('sha256').update(companion.export({ type: 'spki', format: 'der' })).digest('hex') !== pairing.companionKeyDigest) {
      throw new Error('Connect companion key mismatch');
    }
    const now = clock.wall();
    const monotonic = clock.monotonic();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(monotonic)) throw new RangeError('Invalid Connect clock');
    this.#deadline = now + 10_000;
    this.#monotonicDeadline = monotonic + 10_000;
    this.#challenge = Buffer.concat([
      text('instar-connect-connection-challenge-v1'), text(pairing.agentId),
      Buffer.from(pairing.companionKeyDigest, 'hex'), text(pairing.targetId), positiveSafeInteger(pairing.revision),
      Buffer.from(this.generation, 'hex'), this.#nonce, positiveSafeInteger(this.#deadline),
    ]);
    if (transport.aborted) this.close();
    else transport.addEventListener('abort', this.#onTransportClose, { once: true });
  }

  challengeTranscript(): Buffer {
    return Buffer.from(this.#challenge);
  }

  admit(frame: Buffer): boolean {
    if (this.#state !== 'pending') return false;
    const now = this.clock.wall();
    const monotonic = this.clock.monotonic();
    if (!Number.isSafeInteger(now) || now < this.#deadline - 10_000 || now >= this.#deadline ||
        !Number.isFinite(monotonic) || monotonic >= this.#monotonicDeadline ||
        this.transport.aborted || !this.pairingStillCurrent()) {
      this.close();
      return false;
    }
    const proof = verifyConnectConsentFrame(frame, this.companion);
    const expected = Buffer.concat([
      text('instar-connect-connection-proof-v1'), createHash('sha256').update(this.#challenge).digest(),
      Buffer.from(this.generation, 'hex'), this.#nonce,
    ]);
    if (!proof?.equals(expected) || this.transport.aborted || !this.pairingStillCurrent()) {
      this.close();
      return false;
    }
    this.#state = 'admitted';
    return true;
  }

  current(): boolean {
    if (this.#state !== 'admitted') return false;
    if (this.transport.aborted || !this.pairingStillCurrent()) {
      this.close();
      return false;
    }
    return true;
  }

  close(): void {
    this.#state = 'closed';
    this.transport.removeEventListener('abort', this.#onTransportClose);
  }
}
