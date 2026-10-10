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
import { detectJoinedMesh, describeMintRefusal, type JoinedMeshVerdict } from './JoinedMeshDetector.js';
import {
  IdentityFileInvalidError,
  createFileExclusiveOwnerOnly,
  readIdentityKeyFile,
  writeFileAtomicOwnerOnly,
} from '../../identity/IdentityKeyFile.js';
import { withIdentityLock } from '../../core/AgentIdentityLock.js';
import type { AgentFingerprint } from '../relay/types.js';

/**
 * Thrown when minting is refused because this home joined an existing mesh (or carries a
 * registry it cannot read — a2a-single-agent-identity §1.1 refuses there too).
 *
 * Spec: docs/specs/agent-identity-continuity-on-expansion.md §2, Frontloaded Decision 2 —
 * fail closed, loudly. A machine that cannot obtain the agent's identity must NOT invent one:
 * a silent twin is worse than a machine that plainly says it could not join properly. Since
 * a2a-single-agent-identity §1.2 the identity is ADOPTED from a sibling automatically; the
 * server boots `identity-not-provisioned` and the adoption loop fills the void.
 */
export class IdentityNotProvisionedError extends Error {
  readonly code = 'identity-not-provisioned';
  readonly peerMachineCount: number;
  /** The detector verdict that refused the mint — names the reason and the lever. */
  readonly verdict: JoinedMeshVerdict | null;
  constructor(peerMachineCount: number, verdict: JoinedMeshVerdict | null = null) {
    super(
      verdict && !verdict.joined && !verdict.mintAllowed
        ? `This machine has no agent identity and its machine registry refuses a mint (${describeMintRefusal(verdict)}). ` +
            'Minting here could split the agent into two identities sharing a name, so it is refused; ' +
            'the identity is adopted from a sibling when one is reachable.'
        : 'This machine joined an existing agent mesh but has no agent identity. Minting one here ' +
            'would split the agent into two identities sharing a name, so it is refused. The ' +
            'identity is adopted from a sibling machine automatically (or run `instar identity adopt --from <machine>`).',
    );
    this.name = 'IdentityNotProvisionedError';
    this.peerMachineCount = peerMachineCount;
    this.verdict = verdict;
  }
}

/**
 * The last fingerprint THIS machine actually published, read from `threadline/agent-info.json`
 * — the one local memory §1.3 pins adoption on. Null when the file is absent or carries none.
 * (The file is rewritten at every boot in the routing formula; since §1.1 a boot with no
 * identity leaves it untouched, so it keeps the last value this machine really used.)
 */
export function readLastKnownFingerprint(stateDir: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, 'threadline', 'agent-info.json'), 'utf-8')) as { fingerprint?: unknown };
    return typeof raw.fingerprint === 'string' && /^[0-9a-f]{32}$/.test(raw.fingerprint) ? raw.fingerprint : null;
  } catch {
    return null;
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
  private mirrorRepaired: { backupPath: string } | null = null;

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
    // The discriminator is an on-disk fact (a registry naming another machine). Since
    // a2a-single-agent-identity §1.1 every uncertain reading (an unreadable registry, rows with
    // no own machine id) resolves toward REFUSING: a registry file's existence is pairing
    // evidence, and minting over it is how a rebuilt sibling recreated the split. The one
    // case this costs (a standalone agent with a corrupt registry) is loud and names its lever.
    const joined = detectJoinedMesh(this.stateDir);
    if (!joined.mintAllowed) {
      throw new IdentityNotProvisionedError(joined.joined ? joined.peerMachineCount : 0, joined);
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
   * The reload lever (a2a-single-agent-identity §1.2): drop the in-memory identity and
   * re-read disk. Used after an adoption/CLI install so the running process picks up the new
   * key WITHOUT a restart. Returns the identity now on disk (null when none — the machine then
   * re-enters `identity-not-provisioned`, which the caller counts as an adopt→lose cycle).
   */
  reload(): IdentityInfo | null {
    this.identity = null;
    this.loadProblem = null;
    this.filesDisagree = false;
    return this.get();
  }

  /**
   * Read the identity ON DISK through the single reader, bypassing the in-process cache.
   * The §1.2 observe handler and the §2.2 detector read THIS so a file moved aside by the
   * CLI on a running server reads as `not-provisioned` immediately.
   */
  static readFromDisk(stateDir: string): IdentityInfo | null {
    const m = new IdentityManager(stateDir);
    return m.loadFromDisk();
  }

  /**
   * True when the most recent load repaired the legacy mirror (§1.5): the two files
   * disagreed, the canonical one won, and `threadline/identity.json` was rewritten to match
   * with the old file backed up beside it. The caller reports ONE degradation row and restarts
   * a listener daemon running under the superseded key.
   */
  get legacyMirrorRepaired(): { backupPath: string } | null {
    return this.mirrorRepaired;
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
    // the SAME identity. Checked on every load. The canonical file wins (as
    // before) AND — a2a-single-agent-identity §1.5 — the legacy file is a MIRROR
    // repaired at first load: rewritten to match, under the identity lock,
    // atomically, old file backed up as `threadline/identity.json.superseded-<ISO>`.
    // (Before §1.5 the disagreement was only reported and the listener daemon,
    // which loads the legacy path, kept speaking under the old key — the 2026-10-09
    // manual fix left exactly that state and an `[identity]` ERROR at every boot.)
    if (canonical && legacy && !canonical.publicKey.equals(legacy.publicKey)) {
      this.filesDisagree = true;
      const repaired = this.repairLegacyMirror(canonical);
      if (repaired) {
        this.mirrorRepaired = repaired;
        this.filesDisagree = false;
        this.reportOnce(this.legacyKeyFile, 'mirror-repaired',
          `[identity] ${this.legacyKeyFile} held a different identity than ${this.canonicalKeyFile}; rewrote it to match (fingerprint ${canonical.fingerprint}); the old file is kept at ${repaired.backupPath}.`);
      } else {
        this.reportOnce(this.canonicalKeyFile, 'files-disagree',
          `[identity] ${this.canonicalKeyFile} and ${this.legacyKeyFile} hold two different identities; using the first (fingerprint ${canonical.fingerprint}); the mirror could not be repaired.`);
      }
    }
    return canonical ?? legacy;
  }

  /**
   * §1.5 — rewrite the legacy file to mirror the canonical identity. Backup first (rename,
   * never unlink), then the single atomic owner-only write, all under the identity lock.
   * Returns null (and leaves both files untouched) on any failure.
   */
  private repairLegacyMirror(canonical: IdentityInfo): { backupPath: string } | null {
    const backupPath = `${this.legacyKeyFile}.superseded-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      return withIdentityLock(this.stateDir, () => {
        // Re-check under the lock: another process may have repaired it already.
        const now = readIdentityKeyFile(this.legacyKeyFile, { repair: false });
        if (!now) return null;
        if (now.publicKey.equals(canonical.publicKey)) return { backupPath: '' };
        fs.renameSync(this.legacyKeyFile, backupPath);
        const data = JSON.stringify({
          fingerprint: canonical.fingerprint,
          publicKey: canonical.publicKey.toString('base64'),
          privateKey: canonical.privateKey.toString('base64'),
          x25519PublicKey: canonical.x25519PublicKey.toString('base64'),
          createdAt: canonical.createdAt || new Date().toISOString(),
          mirrorOf: 'identity.json',
          repairedAt: new Date().toISOString(),
        }, null, 2);
        writeFileAtomicOwnerOnly(this.legacyKeyFile, data);
        return { backupPath };
      }, { waitMs: 5_000 });
    } catch (err) {
      // @silent-fallback-ok: a repair that cannot be made leaves the pre-§1.5 behaviour (the
      // canonical file is used, the disagreement is reported). Logged so it is visible.
      console.warn(`[identity] legacy mirror repair skipped: ${err instanceof Error ? err.message : String(err)}`);
      try {
        // If the rename happened but the write failed, put the original back.
        if (fs.existsSync(backupPath) && !fs.existsSync(this.legacyKeyFile)) fs.renameSync(backupPath, this.legacyKeyFile);
      } catch { /* nothing more to do */ }
      return null;
    }
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
    if (reason === 'repaired' || reason === 'mirror-repaired') console.warn(line);
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
