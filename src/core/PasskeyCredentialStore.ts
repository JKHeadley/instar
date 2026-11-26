/**
 * PasskeyCredentialStore — custody for agent-held Google passkeys
 * (spec docs/specs/agent-held-google-passkey.md §3.1).
 *
 * Each credential is the agent's OWN WebAuthn key pair registered on a Google
 * account, stored as exportable software key material. A leak is treated like a
 * leak of the account's password, so custody is deliberately separate from the
 * shared vault:
 *
 *   - A SEPARATE encrypted file (`.instar/secrets/passkeys/store.enc`) using the
 *     shared vault's AES-GCM envelope and master key (no new crypto). Older builds
 *     only read `secrets/config.secrets.enc`, so they can never sync, list, back up
 *     or show this file; nothing here enters secret sync, `secret-get.mjs`, the
 *     generic SecretManager or the session boot block.
 *   - Entry key `<emailKey>:<machineId>`, where `emailKey` is an HMAC of the
 *     canonical email under a random per-store key kept INSIDE the encrypted file.
 *     That keeps emails out of file and index names. It is pseudonymisation, not
 *     secrecy: cross-machine messages carry the email itself, and each receiver
 *     derives its own local key.
 *   - Every write takes a cross-process lock, re-reads under the lock, writes a
 *     unique temp file, renames, then verifies by read-back.
 *   - Machine-scope guard: `load()` returns a credential only when it is not
 *     quarantined AND (it was minted on this machine OR a committed adoption
 *     record for this machine exists). The guard runs before anything can reach
 *     a browser.
 *   - Crash-safe mint: an exported credential waits in an encrypted pending record
 *     until the verified store write; a leftover is resumed (never re-minted),
 *     expires after 24h, and is deleted on revoke.
 *   - A names-only index (`index.json`: emailKey, machineId, provenance, custody
 *     state; no email, no key material) is rebuilt on every write so routes and
 *     ticks never decrypt the store.
 *
 * Honest threat model (§1.1): code running as the agent's OS user can in principle
 * decrypt this file. These rules stop ACCIDENTAL exposure; the separate-OS-user
 * signing broker is the real boundary and is required before the fleet rung.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { SecretStore, type KeychainOps } from './SecretStore.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export const PASSKEY_DIR = path.join('secrets', 'passkeys');
const STORE_FILE = path.join(PASSKEY_DIR, 'store.enc');
const PENDING_DIR = path.join(PASSKEY_DIR, 'pending');
const INDEX_FILE = path.join(PASSKEY_DIR, 'index.json');
const SCHEMA_VERSION = 1;
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

const LOCK_OPTIONS = {
  stale: 10_000,
  retries: { retries: 20, factor: 1.3, minTimeout: 25, maxTimeout: 500 },
} as const;

/**
 * Synchronous lock with bounded retries (proper-lockfile's lockSync has no retry
 * option). Used only for the one-time store creation.
 */
function lockSyncWithRetry(target: string): () => void {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      return lockfile.lockSync(target, { stale: LOCK_OPTIONS.stale });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ELOCKED' || Date.now() > deadline) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

/** The exported WebAuthn credential plus custody metadata. */
export interface PasskeyRecord {
  credentialId: string;
  rpId: string;
  privateKey: string;
  userHandle: string;
  signCount: number;
  canonicalEmail: string;
  mintedOnMachineId: string;
  mintedByAgent: string;
  mintedAt: string;
  googleCreatedAt?: string;
  provenance: 'minted' | 'legacy-adopted';
  quarantined: boolean;
  schemaVersion: number;
}

export type CustodyState = 'present' | 'quarantined' | 'legacy-adopted';

export interface PasskeyIndexEntry {
  emailKey: string;
  machineId: string;
  provenance: PasskeyRecord['provenance'];
  custodyState: CustodyState;
}

/** A committed operator adoption of a legacy (prototype) key for one machine. */
export interface AdoptionRecord {
  machineId: string;
  committedAt: string;
}

interface StoreContents {
  hmacKey: string;
  entries: Record<string, PasskeyRecord>;
  adoptions: Record<string, AdoptionRecord>;
  tombstones: Record<string, { deletedAt: string }>;
  [k: string]: unknown;
}

export type LoadRefusal = 'absent' | 'quarantined' | 'machine-scope' | 'machine-id-changed';

export type LoadResult =
  | { ok: true; record: PasskeyRecord }
  | { ok: false; reason: LoadRefusal };

/** Normalise an email the same way everywhere (lowercase, trimmed). */
export function canonicalEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface PasskeyCredentialStoreOptions {
  stateDir: string;
  /** This machine's id; the machine-scope guard compares against it. */
  machineId: string;
  forceFileKey?: boolean;
  keychainOps?: KeychainOps;
  now?: () => number;
}

export class PasskeyCredentialStore {
  private readonly stateDir: string;
  private readonly machineId: string;
  private readonly vault: SecretStore;
  private readonly now: () => number;
  private readonly forceFileKey?: boolean;
  private readonly keychainOps?: KeychainOps;

  constructor(opts: PasskeyCredentialStoreOptions) {
    this.stateDir = opts.stateDir;
    this.machineId = opts.machineId;
    this.now = opts.now ?? Date.now;
    this.forceFileKey = opts.forceFileKey;
    this.keychainOps = opts.keychainOps;
    this.vault = new SecretStore({
      stateDir: opts.stateDir,
      forceFileKey: opts.forceFileKey,
      keychainOps: opts.keychainOps,
      storeFile: STORE_FILE,
    });
  }

  // ── Keys ─────────────────────────────────────────────────────────────

  /** The pseudonymous key for an email on THIS store. Never sent to other machines. */
  emailKey(email: string): string {
    this.ensureInitialized();
    return this.emailKeyWith(this.readContents().hmacKey, email);
  }

  private emailKeyWith(hmacKey: string, email: string): string {
    return crypto.createHmac('sha256', Buffer.from(hmacKey, 'hex')).update(canonicalEmail(email)).digest('hex');
  }

  private entryKey(hmacKey: string, email: string, machineId: string): string {
    return `${this.emailKeyWith(hmacKey, email)}:${machineId}`;
  }

  // ── Reads ────────────────────────────────────────────────────────────

  /** Names-only listing from the index; never decrypts. */
  listIndex(): PasskeyIndexEntry[] {
    const p = path.join(this.stateDir, INDEX_FILE);
    if (!fs.existsSync(p)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { entries?: PasskeyIndexEntry[] };
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      // @silent-fallback-ok — the names-only index is a derived convenience file, never
      // authority: an unreadable one reads as empty and is rewritten from the encrypted
      // store on the next mutation. Nothing is decided from this listing.
      return [];
    }
  }

  /** Whether a credential for (email, this machine) is held. Decrypts once. */
  has(email: string): boolean {
    const c = this.readContents();
    return Boolean(c.entries[this.entryKey(c.hmacKey, email, this.machineId)]);
  }

  /**
   * Load the credential for (email, this machine), enforcing the machine-scope
   * guard. The caller passes the result straight into the browser worker; this is
   * the ONLY supported way to obtain key material.
   */
  load(email: string): LoadResult {
    const c = this.readContents();
    const key = this.entryKey(c.hmacKey, email, this.machineId);
    const rec = c.entries[key];
    if (!rec) {
      // A record filed under this email for a DIFFERENT machine id means the
      // local id changed (reinstall / identity recovery): a named state, never a load.
      const prefix = `${this.emailKeyWith(c.hmacKey, email)}:`;
      const foreign = Object.keys(c.entries).some((k) => k.startsWith(prefix));
      return { ok: false, reason: foreign ? 'machine-id-changed' : 'absent' };
    }
    if (rec.quarantined) return { ok: false, reason: 'quarantined' };
    const adopted = c.adoptions[key]?.machineId === this.machineId;
    if (rec.mintedOnMachineId !== this.machineId && !adopted) {
      return { ok: false, reason: 'machine-scope' };
    }
    return { ok: true, record: { ...rec } };
  }

  // ── Writes (all locked, verified by read-back) ───────────────────────

  /**
   * Store a credential for this machine. `quarantined` records are held but can
   * never be loaded until `release()` after a verified proof. Throws if the
   * read-back does not show the write.
   */
  async put(record: Omit<PasskeyRecord, 'schemaVersion' | 'canonicalEmail'> & { canonicalEmail: string }): Promise<void> {
    const email = canonicalEmail(record.canonicalEmail);
    await this.mutate((c) => {
      const key = this.entryKey(c.hmacKey, email, this.machineId);
      c.entries[key] = { ...record, canonicalEmail: email, schemaVersion: SCHEMA_VERSION };
      delete c.tombstones[key];
    });
    const back = this.readContents();
    const key = this.entryKey(back.hmacKey, email, this.machineId);
    if (back.entries[key]?.credentialId !== record.credentialId) {
      throw new Error('PasskeyCredentialStore: write did not verify on read-back');
    }
  }

  /** Clear the quarantine flag (after an identity- and assertion-verified proof). */
  async release(email: string): Promise<void> {
    await this.mutate((c) => {
      const rec = c.entries[this.entryKey(c.hmacKey, email, this.machineId)];
      if (!rec) throw new Error('PasskeyCredentialStore: no record to release');
      rec.quarantined = false;
    });
    const back = this.readContents();
    if (back.entries[this.entryKey(back.hmacKey, email, this.machineId)]?.quarantined !== false) {
      throw new Error('PasskeyCredentialStore: release did not verify on read-back');
    }
  }

  /** Record an operator-confirmed adoption of a legacy key for this machine. */
  async commitAdoption(email: string): Promise<void> {
    await this.mutate((c) => {
      const key = this.entryKey(c.hmacKey, email, this.machineId);
      const rec = c.entries[key];
      if (!rec) throw new Error('PasskeyCredentialStore: no record to adopt');
      if (rec.provenance !== 'legacy-adopted') throw new Error('PasskeyCredentialStore: only legacy-adopted records can be adopted');
      c.adoptions[key] = { machineId: this.machineId, committedAt: new Date(this.now()).toISOString() };
    });
    const back = this.readContents();
    if (back.adoptions[this.entryKey(back.hmacKey, email, this.machineId)]?.machineId !== this.machineId) {
      throw new Error('PasskeyCredentialStore: adoption did not verify on read-back');
    }
  }

  /**
   * Delete every credential this store holds for the email (under ANY machine id —
   * a record filed under an old local id after a reinstall is removed too), its
   * pending record and adoptions, and leave tombstones. Returns what the read-back
   * verified, so a caller never reports "revoked" for a location it could not check.
   */
  async remove(email: string): Promise<{ entryAbsent: boolean; pendingAbsent: boolean; tombstone: boolean; removedKeys: number }> {
    let emailKeyValue = '';
    let removedKeys = 0;
    await this.mutate((c) => {
      emailKeyValue = this.emailKeyWith(c.hmacKey, email);
      const prefix = `${emailKeyValue}:`;
      const keys = new Set([
        ...Object.keys(c.entries).filter((k) => k.startsWith(prefix)),
        this.entryKey(c.hmacKey, email, this.machineId),
      ]);
      for (const key of keys) {
        if (c.entries[key]) removedKeys++;
        delete c.entries[key];
        delete c.adoptions[key];
        c.tombstones[key] = { deletedAt: new Date(this.now()).toISOString() };
      }
    });
    this.deletePending(emailKeyValue);
    const back = this.readContents();
    const prefix = `${this.emailKeyWith(back.hmacKey, email)}:`;
    return {
      entryAbsent: !Object.keys(back.entries).some((k) => k.startsWith(prefix)),
      pendingAbsent: !fs.existsSync(this.pendingPath(emailKeyValue)),
      tombstone: Boolean(back.tombstones[this.entryKey(back.hmacKey, email, this.machineId)]),
      removedKeys,
    };
  }

  // ── Pending (crash-safe mint) ────────────────────────────────────────

  private pendingPath(emailKeyValue: string): string {
    return path.join(this.stateDir, PENDING_DIR, `${emailKeyValue}.enc`);
  }

  /** Hold an exported credential encrypted on disk until the verified store write. */
  writePending(record: PasskeyRecord): void {
    const ek = this.emailKey(record.canonicalEmail);
    this.pendingVault(ek).write({ record, writtenAt: this.now() });
  }

  /** Read a leftover pending record (resume at "store"; never re-mint). */
  readPending(email: string): PasskeyRecord | null {
    const ek = this.emailKey(email);
    if (!fs.existsSync(this.pendingPath(ek))) return null;
    const data = this.pendingVault(ek).read() as { record?: PasskeyRecord };
    return data.record ?? null;
  }

  private deletePending(emailKeyValue: string): void {
    const p = this.pendingPath(emailKeyValue);
    if (fs.existsSync(p)) {
      SafeFsExecutor.safeUnlinkSync(p, { operation: 'src/core/PasskeyCredentialStore.ts:deletePending' });
    }
  }

  /** Delete the pending record for an email (after a verified store write). */
  clearPending(email: string): void {
    this.deletePending(this.emailKey(email));
  }

  /**
   * Delete pending records older than the TTL. An UNREADABLE record is never
   * deleted (a transient keychain or decrypt failure must not destroy the only
   * copy of a key already registered on Google); it is reported instead.
   */
  sweepExpiredPending(): { removed: string[]; unreadable: string[] } {
    const dir = path.join(this.stateDir, PENDING_DIR);
    if (!fs.existsSync(dir)) return { removed: [], unreadable: [] };
    const removed: string[] = [];
    const unreadable: string[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.enc')) continue;
      const ek = f.slice(0, -'.enc'.length);
      let writtenAt: number;
      try {
        writtenAt = Number((this.pendingVault(ek).read() as { writtenAt?: number }).writtenAt);
      } catch {
        unreadable.push(ek);
        continue;
      }
      if (!Number.isFinite(writtenAt)) { unreadable.push(ek); continue; }
      if (this.now() - writtenAt >= PENDING_TTL_MS) {
        this.deletePending(ek);
        removed.push(ek);
      }
    }
    return { removed, unreadable };
  }

  // ── Internals ────────────────────────────────────────────────────────

  private pendingVault(emailKeyValue: string): SecretStore {
    return new SecretStore({
      stateDir: this.stateDir,
      forceFileKey: this.forceFileKey,
      keychainOps: this.keychainOps,
      storeFile: path.join(PENDING_DIR, `${emailKeyValue}.enc`),
    });
  }

  private readContents(): StoreContents {
    const raw = this.vault.read() as Partial<StoreContents>;
    return {
      hmacKey: typeof raw.hmacKey === 'string' ? raw.hmacKey : '',
      entries: (raw.entries as StoreContents['entries']) ?? {},
      adoptions: (raw.adoptions as StoreContents['adoptions']) ?? {},
      tombstones: (raw.tombstones as StoreContents['tombstones']) ?? {},
    };
  }

  /**
   * Create the store with a fresh HMAC key if absent. Every email key is derived
   * from that HMAC key, so it must exist before the first key is computed.
   */
  private ensureInitialized(): void {
    const file = path.join(this.stateDir, STORE_FILE);
    if (fs.existsSync(file)) return;
    const dir = path.join(this.stateDir, PASSKEY_DIR);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Create under the directory lock so two processes that both find the store
    // absent cannot each mint a different HMAC key (the loser's derived keys would
    // never match again). Re-check existence inside the lock.
    const release = lockSyncWithRetry(dir);
    try {
      if (!fs.existsSync(file)) {
        this.vault.write({ hmacKey: crypto.randomBytes(32).toString('hex'), entries: {}, adoptions: {}, tombstones: {} });
      }
    } finally {
      release();
    }
  }

  /** Locked read-modify-write; creates the store (with a fresh HMAC key) on first use. */
  private async mutate(fn: (c: StoreContents) => void): Promise<void> {
    this.ensureInitialized();
    // The lock is on the passkeys DIRECTORY (always present once initialised), the
    // same lock ensureInitialized takes, so creation and mutation are serialised.
    const release = await lockfile.lock(path.join(this.stateDir, PASSKEY_DIR), LOCK_OPTIONS);
    try {
      const c = this.readContents();
      if (!c.hmacKey) c.hmacKey = crypto.randomBytes(32).toString('hex');
      fn(c);
      this.vault.write(c);
      this.writeIndex(c);
    } finally {
      await release();
    }
  }

  private writeIndex(c: StoreContents): void {
    const entries: PasskeyIndexEntry[] = Object.entries(c.entries).map(([key, rec]) => {
      const [emailKeyValue, machineId] = key.split(':');
      const custodyState: CustodyState = rec.quarantined
        ? 'quarantined'
        : rec.provenance === 'legacy-adopted' ? 'legacy-adopted' : 'present';
      return { emailKey: emailKeyValue, machineId, provenance: rec.provenance, custodyState };
    });
    const p = path.join(this.stateDir, INDEX_FILE);
    const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ updatedAt: new Date(this.now()).toISOString(), entries }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, p);
  }
}
