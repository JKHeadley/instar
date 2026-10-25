/**
 * CanonicalIdentityManager — Manages the agent's canonical Ed25519 identity.
 *
 * Stores identity at {stateDir}/identity.json with encrypted private key.
 * This is the single source of truth for agent identity across all systems
 * (Threadline, MoltBridge, A2A).
 *
 * Spec Section 3.3: Single keypair, managed by Instar, used by both systems.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateIdentityKeyPair } from '../threadline/ThreadlineCrypto.js';
import { deriveX25519PublicKey } from '../threadline/client/MessageEncryptor.js';
import { encryptPrivateKey, decryptPrivateKey, generateSalt } from './KeyEncryption.js';
import {
  IDENTITY_KEY_BYTES,
  IdentityFileInvalidError,
  derivePublicKey,
  readIdentityKeyFile,
  writeFileAtomicOwnerOnly,
} from './IdentityKeyFile.js';
import {
  generateRecoveryPhrase,
  deriveRecoveryKeypair,
  createRecoveryCommitment,
  generateRecoverySalt,
} from './RecoveryPhrase.js';
import {
  computeCanonicalId,
  computeDisplayFingerprint,
  IDENTITY_SCHEMA_VERSION,
  type CanonicalIdentity,
  type IdentityFile,
  type PrivateKeyEncryption,
} from './types.js';

// ── Types ────────────────────────────────────────────────────────────

export interface CreateIdentityOptions {
  /** Passphrase for encrypting the private key. If omitted, key stored unencrypted (dev mode). */
  passphrase?: string;
  /** Skip recovery phrase generation (for testing). */
  skipRecovery?: boolean;
}

export interface CreateIdentityResult {
  identity: CanonicalIdentity;
  /** The 24-word recovery phrase. Only returned on creation — never persisted by the manager. */
  recoveryPhrase?: string;
}

export interface LoadIdentityOptions {
  /** Passphrase for decrypting the private key. Required if key was encrypted. */
  passphrase?: string;
}

// ── Manager ──────────────────────────────────────────────────────────

export class CanonicalIdentityManager {
  private readonly stateDir: string;
  private readonly identityFile: string;
  private identity: CanonicalIdentity | null = null;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.identityFile = path.join(stateDir, 'identity.json');
  }

  /**
   * Create a new canonical identity.
   *
   * Generates Ed25519 keypair, optional recovery phrase, encrypts private key,
   * and writes identity.json.
   *
   * @returns The identity and (if generated) the recovery phrase.
   *          The recovery phrase is ONLY returned here — it must be shown to the user
   *          and never stored by the system.
   */
  create(options: CreateIdentityOptions = {}): CreateIdentityResult {
    const keypair = generateIdentityKeyPair();
    const canonicalId = computeCanonicalId(keypair.publicKey);
    const displayFingerprint = computeDisplayFingerprint(canonicalId);

    let recoveryPhrase: string | undefined;
    let recoveryCommitment: string | undefined;
    let recoverySalt: string | undefined;

    if (!options.skipRecovery) {
      recoveryPhrase = generateRecoveryPhrase();
      const rSalt = generateRecoverySalt();
      const recoveryKeypair = deriveRecoveryKeypair(recoveryPhrase, rSalt);
      recoveryCommitment = createRecoveryCommitment(recoveryKeypair.publicKey, keypair.privateKey);
      recoverySalt = rSalt.toString('base64');
    }

    // Encrypt private key (or store plaintext in dev mode)
    let privateKeyData: string;
    let encryption: PrivateKeyEncryption;
    let keySalt: string | undefined;

    if (options.passphrase !== undefined) {
      const salt = generateSalt();
      privateKeyData = encryptPrivateKey(keypair.privateKey, options.passphrase, salt);
      encryption = 'xchacha20-poly1305+argon2id';
      keySalt = salt.toString('base64');
    } else {
      privateKeyData = keypair.privateKey.toString('base64');
      encryption = 'none';
    }

    const file: IdentityFile = {
      version: IDENTITY_SCHEMA_VERSION,
      publicKey: keypair.publicKey.toString('base64'),
      privateKey: privateKeyData,
      privateKeyEncryption: encryption,
      ...(keySalt && { keySalt }),
      canonicalId,
      displayFingerprint,
      ...(recoveryCommitment && { recoveryCommitment }),
      ...(recoverySalt && { recoverySalt }),
      createdAt: new Date().toISOString(),
    };

    this.writeToDisk(file);

    const identity: CanonicalIdentity = {
      version: IDENTITY_SCHEMA_VERSION,
      publicKey: keypair.publicKey,
      privateKey: keypair.privateKey,
      x25519PublicKey: deriveX25519PublicKey(keypair.privateKey),
      canonicalId,
      displayFingerprint,
      createdAt: file.createdAt,
      recoveryCommitment,
    };

    this.identity = identity;
    return { identity, recoveryPhrase };
  }

  /**
   * Load an existing identity from disk.
   *
   * @param options.passphrase Required if the private key is encrypted.
   * @returns The decrypted identity, or null if no identity exists.
   * @throws Error if passphrase is wrong or file is corrupted.
   */
  load(options: LoadIdentityOptions = {}): CanonicalIdentity | null {
    if (this.identity) return this.identity;

    // Validate on read (spec: threadline-identity-single-writer). A file whose
    // keys were stored as hex is the same identity in the wrong encoding: it is
    // repaired in place. Any other invalid file throws — never a silent null
    // that a caller could answer by creating a new identity over it.
    const loaded = readIdentityKeyFile(this.identityFile, { repair: true });
    if (!loaded) return null;
    const file = loaded.raw as unknown as IdentityFile;

    let privateKey: Buffer;

    // The pairing installer (installAgentIdentityFromPairing) writes a
    // plaintext key with no `privateKeyEncryption` field (spec:
    // joined-machine-unified-trust). An ABSENT field therefore means 'none'.
    // readIdentityKeyFile has already validated that file as a plaintext pair
    // (32-byte seed whose public key matches), so a ciphertext key without the
    // field never reaches here. A field that is present but holds anything
    // other than the two known methods is still refused below.
    const declaresNoEncryption =
      file.privateKeyEncryption === 'none' || !('privateKeyEncryption' in loaded.raw);

    if (declaresNoEncryption) {
      privateKey = loaded.privateKey!;
    } else if (file.privateKeyEncryption === 'xchacha20-poly1305+argon2id') {
      if (!options.passphrase && options.passphrase !== '') {
        throw new Error('Passphrase required to decrypt identity');
      }
      if (!file.keySalt) {
        throw new Error('Identity file missing keySalt for encrypted key');
      }
      const salt = Buffer.from(file.keySalt, 'base64');
      privateKey = decryptPrivateKey(file.privateKey, options.passphrase!, salt);
      if (privateKey.length !== IDENTITY_KEY_BYTES) {
        throw new IdentityFileInvalidError(
          this.identityFile,
          `the decrypted private key is ${privateKey.length} bytes, expected ${IDENTITY_KEY_BYTES}`,
        );
      }
      if (!derivePublicKey(privateKey).equals(loaded.publicKey)) {
        throw new IdentityFileInvalidError(this.identityFile, 'the public key does not belong to the private key');
      }
    } else {
      throw new Error(`Unknown encryption method: ${file.privateKeyEncryption}`);
    }

    // The installer shape also carries no canonicalId / displayFingerprint.
    // Both are pure functions of the public key, so derive them when absent
    // (or empty).
    const canonicalId = file.canonicalId || computeCanonicalId(loaded.publicKey);
    const identity: CanonicalIdentity = {
      version: file.version,
      publicKey: loaded.publicKey,
      privateKey,
      x25519PublicKey: deriveX25519PublicKey(privateKey),
      canonicalId,
      displayFingerprint: file.displayFingerprint || computeDisplayFingerprint(canonicalId),
      createdAt: file.createdAt,
      recoveryCommitment: file.recoveryCommitment,
      migrationComplete: file.migrationComplete,
    };

    this.identity = identity;
    return identity;
  }

  /**
   * Get the current identity (must have been created or loaded first).
   */
  get(): CanonicalIdentity | null {
    return this.identity;
  }

  /**
   * Check if an identity file exists on disk.
   */
  exists(): boolean {
    return fs.existsSync(this.identityFile);
  }

  /**
   * Get the identity file path.
   */
  get filePath(): string {
    return this.identityFile;
  }

  /**
   * Read the raw identity file (without decrypting).
   * Useful for checking encryption status or migration state.
   */
  readRaw(): IdentityFile | null {
    return this.readFromDisk();
  }

  // ── Private ─────────────────────────────────────────────────────

  private readFromDisk(): IdentityFile | null {
    try {
      if (!fs.existsSync(this.identityFile)) return null;
      const raw = fs.readFileSync(this.identityFile, 'utf-8');
      return JSON.parse(raw) as IdentityFile;
    } catch {
      return null;
    }
  }

  private writeToDisk(file: IdentityFile): void {
    writeFileAtomicOwnerOnly(this.identityFile, JSON.stringify(file, null, 2));
  }
}
