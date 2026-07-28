/**
 * WS5.2 R4b — de-pair X25519 key-rotation as the pairing-epoch mechanism.
 *
 * The load-bearing revocation primitive: instead of inventing a new counter, the recipient's
 * X25519 key (the key credentials are sealed TO) is ROTATED on de-pair, and the rotation
 * generation IS the `pairingEpoch` bound into every sealed credential's AAD (SecretStore.ts).
 * Rotating the key makes EVERY previously-sealed blob undecryptable at once — achieving
 * replay-defeat (S3) and forward-revocation of sealed blobs (S4) by reusing identity machinery.
 *
 * Durability + rollback-resistance (R4b invariant): the (private key, epoch) anchor is persisted
 * via the injected `PairingKeyAnchor`. In production that anchor is backed by the existing
 * encrypted `SecretStore` (AES-256-GCM under the OS-keychain master key) — so a hostile local
 * root that reverts the on-disk ciphertext CANNOT yield the old private key (the keychain master
 * key is not file-revertible; the GCM fallback is authenticated). The receiver learns the CURRENT
 * key/generation across reboot by reading this anchor, never an in-memory or plaintext value.
 *
 * `secretStoreKeyAnchor` wires the anchor to a real encrypted store; tests use an in-memory anchor.
 */

import crypto from 'node:crypto';

export interface PairingEpochState {
  /** PKCS8 PEM of the current X25519 private key. */
  privateKeyPem: string;
  /** Raw 32-byte X25519 public key (base64) — what peers seal credentials to. */
  publicKeyB64: string;
  /** Rotation generation — bound into sealed-credential AAD as `pairingEpoch`. */
  epoch: number;
}

/** Durable, rollback-resistant anchor for the pairing key + epoch. */
export interface PairingKeyAnchor {
  load(): PairingEpochState | null;
  save(state: PairingEpochState): void;
}

/** Minimal encrypted key/value surface (satisfied by SecretStore). */
export interface EncryptedKvStore {
  get(keyPath: string): unknown;
  set(keyPath: string, value: unknown): void;
}

/**
 * Build a durable anchor backed by an encrypted store (production: the real SecretStore, whose
 * master key lives in the OS keychain — giving the R4b rollback-resistance for free).
 */
export function secretStoreKeyAnchor(
  store: EncryptedKvStore,
  keyPath = 'multiMachine.accountFollowMe.pairingKey',
): PairingKeyAnchor {
  return {
    load(): PairingEpochState | null {
      const raw = store.get(keyPath);
      if (!raw || typeof raw !== 'object') return null;
      const s = raw as Partial<PairingEpochState>;
      if (typeof s.privateKeyPem !== 'string' || typeof s.publicKeyB64 !== 'string' || typeof s.epoch !== 'number') {
        return null;
      }
      return { privateKeyPem: s.privateKeyPem, publicKeyB64: s.publicKeyB64, epoch: s.epoch };
    },
    save(state: PairingEpochState): void {
      store.set(keyPath, state);
    },
  };
}

function generateState(epoch: number): PairingEpochState {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const raw = spki.subarray(spki.length - 32);
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { privateKeyPem, publicKeyB64: raw.toString('base64'), epoch };
}

export class PairingEpochManager {
  constructor(private readonly anchor: PairingKeyAnchor) {}

  /**
   * The current pairing identity. Initializes epoch 0 + a fresh key on first use (persisted),
   * and returns the SAME key/epoch on every later call (and across reboot, via the anchor).
   */
  current(): { privateKey: crypto.KeyObject; publicKeyB64: string; epoch: number } {
    let st = this.anchor.load();
    if (!st) {
      st = generateState(0);
      this.anchor.save(st);
    }
    return {
      privateKey: crypto.createPrivateKey(st.privateKeyPem),
      publicKeyB64: st.publicKeyB64,
      epoch: st.epoch,
    };
  }

  /** Just the current epoch (for AAD construction / status reads) without materializing the key. */
  currentEpoch(): number {
    return this.anchor.load()?.epoch ?? this.current().epoch;
  }

  /** Just the current public key (base64) peers seal to. */
  currentPublicKeyB64(): string {
    return this.anchor.load()?.publicKeyB64 ?? this.current().publicKeyB64;
  }

  /**
   * De-pair rotation (R4b). Generates a NEW X25519 key, bumps the epoch, persists atomically.
   * Every credential sealed to the prior key/epoch is now permanently undecryptable.
   */
  rotateOnDepair(): { publicKeyB64: string; epoch: number } {
    const prev = this.anchor.load();
    const next = generateState((prev?.epoch ?? -1) + 1);
    this.anchor.save(next);
    return { publicKeyB64: next.publicKeyB64, epoch: next.epoch };
  }
}
