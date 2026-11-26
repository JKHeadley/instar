import type { KeyObject } from 'node:crypto';
import { ConnectConsentConnection, type ConnectCompanionPairing } from './ConnectConsentConnection.js';

export interface ConnectConsentHostHandle {
  readonly generation: string;
  readonly agentId: string;
  readonly targetId: string;
  readonly companionKey: KeyObject;
  readonly companionKeyDigest: string;
  readonly revision: number;
  readonly challenge: Buffer;
  readonly signal: AbortSignal;
  admit(proof: Buffer): boolean;
  current(): boolean;
}

const issuedHandles = new WeakSet<ConnectConsentHostHandle>();

export function isConnectConsentHostHandle(handle: ConnectConsentHostHandle): boolean {
  return issuedHandles.has(handle);
}

interface ConnectionSlot {
  readonly lifetime: AbortController;
  readonly connection: ConnectConsentConnection;
}

/** One companion connection per trusted target. No listener or capture starts here. */
export class ConnectConsentHost {
  #slot?: ConnectionSlot;
  #pending?: ConnectionSlot;
  #closed = false;
  #replacing = false;
  #attempts: number[] = [];

  open(pairing: ConnectCompanionPairing, key: KeyObject, transport: AbortSignal,
      pairingStillCurrent: () => boolean): ConnectConsentHostHandle | undefined {
    if (this.#closed || this.#replacing || this.#pending || transport.aborted) return;
    const now = performance.now();
    this.#attempts = this.#attempts.filter(at => at > now - 60_000);
    if (this.#attempts.length >= 12) return;
    this.#attempts.push(now);
    const lifetime = new AbortController();
    const connection = new ConnectConsentConnection(pairing, key, pairingStillCurrent, lifetime.signal);
    const slot = { lifetime, connection };
    const onClose = () => {
      if (this.#slot === slot) this.#slot = undefined;
      if (this.#pending === slot) this.#pending = undefined;
      lifetime.abort();
    };
    transport.addEventListener('abort', onClose, { once: true });
    lifetime.signal.addEventListener('abort', () => transport.removeEventListener('abort', onClose), { once: true });

    this.#pending = slot;
    const expiry = setTimeout(onClose, 10_000).unref();
    lifetime.signal.addEventListener('abort', () => clearTimeout(expiry), { once: true });
    const ownsSlot = () => !this.#replacing && this.#slot === slot && !lifetime.signal.aborted;
    const handle: ConnectConsentHostHandle = {
      generation: connection.generation,
      agentId: pairing.agentId,
      targetId: pairing.targetId,
      companionKey: key,
      companionKeyDigest: pairing.companionKeyDigest,
      revision: pairing.revision,
      challenge: connection.challengeTranscript(),
      signal: lifetime.signal,
      admit: proof => {
        if (this.#pending !== slot || lifetime.signal.aborted) return false;
        if (!connection.admit(proof) || this.#pending !== slot || lifetime.signal.aborted) {
          onClose();
          return false;
        }
        clearTimeout(expiry);
        const previous = this.#slot;
        this.#pending = undefined;
        this.#slot = slot;
        this.#replacing = true;
        try { previous?.lifetime.abort(); }
        finally { this.#replacing = false; }
        if (!ownsSlot() || !connection.current()) {
          onClose();
          return false;
        }
        return ownsSlot();
      },
      current: () => {
        if (!ownsSlot()) return false;
        if (connection.current() && ownsSlot()) return true;
        onClose();
        return false;
      },
    };
    issuedHandles.add(handle);
    return Object.freeze(handle);
  }

  close(): void {
    this.#closed = true;
    const previous = this.#slot;
    const pending = this.#pending;
    this.#slot = undefined;
    this.#pending = undefined;
    pending?.lifetime.abort();
    previous?.lifetime.abort();
  }
}
