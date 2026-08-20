/**
 * IdentityManager — Manages Ed25519 identity keys for relay agents.
 *
 * Delegates to the canonical identity ({stateDir}/identity.json) when available,
 * falling back to the legacy Threadline identity ({stateDir}/threadline/identity.json).
 *
 * This ensures backward compatibility: existing agents keep working with their
 * legacy identity, while new/migrated agents use the canonical location.
 *
 * The IdentityInfo interface is unchanged — consumers don't need to know
 * which storage backend is in use.
 */

import fs from 'node:fs';
import path from 'node:path';
import { generateIdentityKeyPair, type KeyPair } from '../ThreadlineCrypto.js';
import { computeFingerprint, deriveX25519PublicKey } from './MessageEncryptor.js';
import { detectJoinedMesh } from './JoinedMeshDetector.js';
import type { AgentFingerprint } from '../relay/types.js';

/**
 * Thrown when minting is refused because this home joined an existing mesh.
 *
 * Spec: docs/specs/agent-identity-continuity-on-expansion.md §2, Frontloaded Decision 2 —
 * fail closed, loudly. A machine that cannot obtain the agent's identity must NOT invent one:
 * a silent twin is worse than a machine that plainly says it could not join properly.
 */
export class IdentityNotProvisionedError extends Error {
  readonly code = 'identity-not-provisioned';
  readonly peerMachineCount: number;
  constructor(peerMachineCount: number) {
    super(
      'This machine joined an existing agent mesh but has no agent identity. Minting one here ' +
        'would split the agent into two identities sharing a name, so it is refused. The ' +
        'identity must be provisioned by the pairing exchange — re-pair this machine.',
    );
    this.name = 'IdentityNotProvisionedError';
    this.peerMachineCount = peerMachineCount;
  }
}

export interface IdentityInfo {
  fingerprint: AgentFingerprint;
  publicKey: Buffer;      // Ed25519 public key
  privateKey: Buffer;     // Ed25519 private key
  x25519PublicKey: Buffer; // X25519 public key (derived from Ed25519)
  createdAt: string;
}

export class IdentityManager {
  private readonly stateDir: string;
  private readonly legacyKeyFile: string;
  private readonly canonicalKeyFile: string;
  private identity: IdentityInfo | null = null;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.legacyKeyFile = path.join(stateDir, 'threadline', 'identity.json');
    this.canonicalKeyFile = path.join(stateDir, 'identity.json');
  }

  /**
   * Get or create the agent's identity.
   *
   * Priority:
   * 1. Cached in-memory identity
   * 2. Canonical identity ({stateDir}/identity.json)
   * 3. Legacy identity ({stateDir}/threadline/identity.json)
   * 4. Generate new (saves to legacy path for backward compat)
   */
  getOrCreate(): IdentityInfo {
    if (this.identity) return this.identity;

    // Try canonical first, then legacy
    const loaded = this.loadFromCanonical() ?? this.loadFromLegacy();
    if (loaded) {
      this.identity = loaded;
      return loaded;
    }

    // ── The mint refusal (spec: agent-identity-continuity-on-expansion §2) ───────────
    // Nothing was found on disk. For the FIRST machine of a new agent that is correct and
    // minting follows. For a machine that JOINED an existing agent's mesh it is the defect
    // this guard exists to close: the agent already has an identity, it simply was not
    // carried here, and minting turns one agent into two that share a name.
    //
    // Enforced at the minting SITE rather than at the call sites, deliberately — guarding
    // callers leaves the next caller free to reintroduce it.
    //
    // The discriminator is an on-disk fact (a registry naming another machine), and every
    // uncertain reading resolves toward minting, so an unrelated filesystem problem can
    // never deny a legitimate standalone agent its identity.
    const joined = detectJoinedMesh(this.stateDir);
    if (joined.joined) {
      throw new IdentityNotProvisionedError(joined.peerMachineCount);
    }

    // Generate new identity (legacy path for backward compat with standalone tooling)
    const keypair = generateIdentityKeyPair();
    const identity: IdentityInfo = {
      fingerprint: computeFingerprint(keypair.publicKey),
      publicKey: keypair.publicKey,
      privateKey: keypair.privateKey,
      x25519PublicKey: deriveX25519PublicKey(keypair.privateKey),
      createdAt: new Date().toISOString(),
    };

    this.saveToDisk(identity);
    this.identity = identity;
    return identity;
  }

  /**
   * Get the current identity without creating a new one.
   */
  get(): IdentityInfo | null {
    if (this.identity) return this.identity;
    const loaded = this.loadFromCanonical() ?? this.loadFromLegacy();
    if (loaded) {
      this.identity = loaded;
    }
    return this.identity;
  }

  /**
   * Check if an identity exists (canonical or legacy).
   */
  exists(): boolean {
    return this.identity !== null
      || fs.existsSync(this.canonicalKeyFile)
      || fs.existsSync(this.legacyKeyFile);
  }

  /**
   * Get the directory where keys are stored.
   */
  get keyDir(): string {
    return path.dirname(this.legacyKeyFile);
  }

  // ── Private ─────────────────────────────────────────────────────

  /**
   * Load from canonical identity.json (new format).
   * Only loads unencrypted keys — encrypted keys require the CanonicalIdentityManager
   * with a passphrase, which is handled at a higher level.
   */
  private loadFromCanonical(): IdentityInfo | null {
    try {
      if (!fs.existsSync(this.canonicalKeyFile)) return null;
      const raw = JSON.parse(fs.readFileSync(this.canonicalKeyFile, 'utf-8'));

      // Only load if unencrypted — encrypted keys need CanonicalIdentityManager
      if (raw.privateKeyEncryption && raw.privateKeyEncryption !== 'none') {
        return null;
      }

      const privateKey = Buffer.from(raw.privateKey, 'base64');
      const publicKey = Buffer.from(raw.publicKey, 'base64');
      return {
        fingerprint: computeFingerprint(publicKey),
        publicKey,
        privateKey,
        x25519PublicKey: deriveX25519PublicKey(privateKey),
        createdAt: raw.createdAt,
      };
    } catch {
      return null;
    }
  }

  /**
   * Load from legacy threadline/identity.json (old format).
   */
  private loadFromLegacy(): IdentityInfo | null {
    try {
      if (!fs.existsSync(this.legacyKeyFile)) return null;
      const raw = JSON.parse(fs.readFileSync(this.legacyKeyFile, 'utf-8'));
      const privateKey = Buffer.from(raw.privateKey, 'base64');
      return {
        fingerprint: raw.fingerprint,
        publicKey: Buffer.from(raw.publicKey, 'base64'),
        privateKey,
        x25519PublicKey: raw.x25519PublicKey
          ? Buffer.from(raw.x25519PublicKey, 'base64')
          : deriveX25519PublicKey(privateKey),
        createdAt: raw.createdAt,
      };
    } catch {
      return null;
    }
  }

  private saveToDisk(identity: IdentityInfo): void {
    const dir = path.dirname(this.legacyKeyFile);
    fs.mkdirSync(dir, { recursive: true });

    const data = JSON.stringify({
      fingerprint: identity.fingerprint,
      publicKey: identity.publicKey.toString('base64'),
      privateKey: identity.privateKey.toString('base64'),
      x25519PublicKey: identity.x25519PublicKey.toString('base64'),
      createdAt: identity.createdAt,
    }, null, 2);

    // Atomic write
    const tmpPath = `${this.legacyKeyFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, data, { mode: 0o600 });
    fs.renameSync(tmpPath, this.legacyKeyFile);
  }
}
