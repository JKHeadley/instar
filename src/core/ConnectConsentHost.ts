import type { KeyObject } from 'node:crypto';
import { ConnectConsentConnection, type ConnectCompanionPairing } from './ConnectConsentConnection.js';

interface ConnectionSlot {
  readonly lifetime: AbortController;
  readonly connection: ConnectConsentConnection;
}

/** One companion connection per trusted target. No listener or capture starts here. */
export class ConnectConsentHost {
  #slot?: ConnectionSlot;
  #closed = false;
  #replacing = false;

  open(pairing: ConnectCompanionPairing, key: KeyObject, transport: AbortSignal,
      pairingStillCurrent: () => boolean): {
    readonly challenge: Buffer;
    readonly signal: AbortSignal;
    admit(proof: Buffer): boolean;
    current(): boolean;
  } | undefined {
    if (this.#closed || this.#replacing || transport.aborted) return;
    const lifetime = new AbortController();
    const connection = new ConnectConsentConnection(pairing, key, pairingStillCurrent, lifetime.signal);
    const slot = { lifetime, connection };
    const onClose = () => {
      if (this.#slot === slot) this.#slot = undefined;
      lifetime.abort();
    };
    transport.addEventListener('abort', onClose, { once: true });
    lifetime.signal.addEventListener('abort', () => transport.removeEventListener('abort', onClose), { once: true });

    const previous = this.#slot;
    this.#slot = slot;
    this.#replacing = true;
    try { previous?.lifetime.abort(); }
    finally { this.#replacing = false; }
    if (this.#closed || this.#slot !== slot || transport.aborted) {
      onClose();
      return;
    }

    const ownsSlot = () => this.#slot === slot && !lifetime.signal.aborted;
    let admitted = false;
    return {
      challenge: connection.challengeTranscript(),
      signal: lifetime.signal,
      admit: proof => {
        if (!ownsSlot()) return false;
        if (!connection.admit(proof) || !ownsSlot()) {
          onClose();
          return false;
        }
        admitted = true;
        return true;
      },
      current: () => {
        if (!ownsSlot()) return false;
        if (connection.current() && ownsSlot()) return true;
        if (admitted) onClose();
        return false;
      },
    };
  }

  close(): void {
    this.#closed = true;
    const previous = this.#slot;
    this.#slot = undefined;
    previous?.lifetime.abort();
  }
}
