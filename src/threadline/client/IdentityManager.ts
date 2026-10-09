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
 *
 * This is the ONLY module that writes {stateDir}/threadline/identity.json
 * (spec: docs/specs/threadline-identity-single-writer.md). Every read is
 * validated: keys must be 32 bytes; a file whose keys were stored as hex is
 * the same identity in the wrong encoding and is repaired in place; any other
 * invalid file is reported and is never overwritten by a freshly minted
 * identity.
 */

import fs from 'node:fs';
import path from 'node:path';
import { generateIdentityKeyPair } from '../ThreadlineCrypto.js';
import { computeFingerprint, deriveX25519PublicKey } from './MessageEncryptor.js';
import { detectJoinedMesh } from './JoinedMeshDetector.js';
import {
  IdentityFileInvalidError,
  createFileExclusiveOwnerOnly,
  readIdentityKeyFile,
} from '../../identity/IdentityKeyFile.js';
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

/** One loud line per (file, reason) per process — health polls must not spam the log. */
const reportedProblems = new Set<string>();

export class IdentityManager {
  private readonly stateDir: string;
  private readonly legacyKeyFile: string;
  private readonly canonicalKeyFile: string;
  private identity: IdentityInfo | null = null;
  private loadProblem: IdentityFileInvalidError | null = null;
  private filesDisagree = false;

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
    const loaded = this.loadFromDisk();
    if (loaded) {
      this.identity = loaded;
      return loaded;
    }

    // An identity file exists but cannot be used. Minting here would write a
    // NEW identity over (or beside) it and silently change this agent's
    // address — refuse, loudly. The file is left exactly as it was.
    if (this.loadProblem) throw this.loadProblem;

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

    // Create-if-absent, never replace. If another process minted between our
    // read and this write, ITS identity stands and we adopt it — two processes
    // that both found no file must not end up with two identities.
    if (!this.saveToDisk(identity)) {
      const winner = this.loadFromDisk();
      if (!winner) {
        throw this.loadProblem
          ?? new IdentityFileInvalidError(this.legacyKeyFile, 'it appeared while an identity was being created and could not be loaded');
      }
      this.identity = winner;
      return winner;
    }
    this.identity = identity;
    return identity;
  }

  /**
   * Get the current identity without creating a new one.
   */
  get(): IdentityInfo | null {
    if (this.identity) return this.identity;
    const loaded = this.loadFromDisk();
    if (loaded) {
      this.identity = loaded;
    }
    return this.identity;
  }

  /**
   * The unusable identity file found by the most recent load, or null. It is
   * set whether or not the OTHER file still yielded an identity — check get()
   * for that. A caller with a degradation surface (the server boot) reports it.
   */
  get problem(): IdentityFileInvalidError | null {
    return this.loadProblem;
  }

  /**
   * True when the canonical and the legacy file both hold a usable identity
   * and the two differ (as of the most recent load). The canonical one is in
   * use; the server boot reports the disagreement.
   */
  get identityFilesDisagree(): boolean {
    return this.filesDisagree;
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
   * Canonical first, then legacy. Both files are always visited so a
   * hex-encoded legacy file is repaired even when the canonical file answers.
   */
  private loadFromDisk(): IdentityInfo | null {
    this.loadProblem = null;
    this.filesDisagree = false;
    const canonical = this.loadFromCanonical();
    const legacy = this.loadFromLegacy();
    // Coherence invariant: when both files hold a usable identity it must be
    // the SAME identity. Checked on every load. A disagreement is reported,
    // never auto-resolved — picking a key is picking an address. The canonical
    // file keeps precedence, so every consumer of this manager still agrees.
    if (canonical && legacy && !canonical.publicKey.equals(legacy.publicKey)) {
      this.filesDisagree = true;
      this.reportOnce(this.canonicalKeyFile, 'files-disagree',
        `[identity] ${this.canonicalKeyFile} and ${this.legacyKeyFile} hold two different identities; using the first (fingerprint ${canonical.fingerprint}).`);
    }
    return canonical ?? legacy;
  }

  /**
   * Load from canonical identity.json (new format).
   * Only loads unencrypted keys — encrypted keys require the CanonicalIdentityManager
   * with a passphrase, which is handled at a higher level.
   */
  private loadFromCanonical(): IdentityInfo | null {
    return this.loadKeyFile(this.canonicalKeyFile);
  }

  /**
   * Load from legacy threadline/identity.json (old format).
   */
  private loadFromLegacy(): IdentityInfo | null {
    return this.loadKeyFile(this.legacyKeyFile);
  }

  /**
   * Read one identity file through the validating reader. The fingerprint and
   * the X25519 key are always derived from the validated keys, never taken
   * from the file.
   */
  private loadKeyFile(file: string): IdentityInfo | null {
    try {
      const loaded = readIdentityKeyFile(file, { repair: true });
      if (!loaded || loaded.encrypted || !loaded.privateKey) return null;
      if (loaded.repaired) {
        this.reportOnce(file, 'repaired', `[identity] ${file} stored its keys as hex; rewrote it as base64 (same key, same address).`);
      } else if (loaded.repairError) {
        this.reportOnce(file, 'repair-failed', `[identity] ${file} stores its keys as hex and could not be rewritten (${loaded.repairError}); using the decoded key for this run.`);
      }
      return {
        fingerprint: computeFingerprint(loaded.publicKey),
        publicKey: loaded.publicKey,
        privateKey: loaded.privateKey,
        x25519PublicKey: deriveX25519PublicKey(loaded.privateKey),
        createdAt: typeof loaded.raw.createdAt === 'string' ? loaded.raw.createdAt : '',
      };
    } catch (err) {
      const problem = err instanceof IdentityFileInvalidError
        ? err
        : new IdentityFileInvalidError(file, 'it could not be loaded');
      this.loadProblem ??= problem;
      this.reportOnce(file, problem.reason, `[identity] ${problem.message}`);
      return null;
    }
  }

  private reportOnce(file: string, reason: string, line: string): void {
    const key = `${file}::${reason}`;
    if (reportedProblems.has(key)) return;
    reportedProblems.add(key);
    if (reason === 'repaired') console.warn(line);
    else console.error(line);
  }

  /** @returns false when the file already existed (nothing was written). */
  private saveToDisk(identity: IdentityInfo): boolean {
    const data = JSON.stringify({
      fingerprint: identity.fingerprint,
      publicKey: identity.publicKey.toString('base64'),
      privateKey: identity.privateKey.toString('base64'),
      x25519PublicKey: identity.x25519PublicKey.toString('base64'),
      createdAt: identity.createdAt,
    }, null, 2);

    // Atomic, owner-only, create-only
    return createFileExclusiveOwnerOnly(this.legacyKeyFile, data);
  }
}
