/**
 * Encrypted secret storage and forward-secret sync protocol.
 *
 * At-rest encryption:
 *   - Master key stored in OS keychain (macOS Keychain, Linux Secret Service)
 *   - File fallback for headless servers (.instar/machine/secrets-master.key, 0600)
 *   - AES-256-GCM encryption of secret store
 *
 * Wire encryption (for sync between machines):
 *   - Ephemeral X25519 ECDH key exchange
 *   - HKDF-SHA256 key derivation
 *   - AES-256-GCM authenticated encryption
 *   - Forward secrecy: ephemeral keys discarded after each transfer
 *
 * Part of Phase 4 (secret sync via tunnel).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

// ── Constants ────────────────────────────────────────────────────────

const KEYCHAIN_SERVICE = 'instar-secret-store';
/** LEGACY machine-global account — the root of the 2026-06-05 key-bifurcation
 *  incident (one slot shared by every agent on the box, silently overwritable
 *  by any fresh-stateDir SecretStore). Read for ADOPTION only; never written. */
const KEYCHAIN_ACCOUNT_LEGACY = 'master-key';
const MASTER_KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // AES-256-GCM
const AUTH_TAG_LENGTH = 16;
const HKDF_INFO = 'instar-secret-sync-v1';
/** v2 at-rest store format magic: 'ISv2' | keyId(8) | iv(12) | tag(16) | ct.
 *  The keyId (sha256(key) prefix) makes wrong-key diagnosable vs corruption. */
const STORE_MAGIC_V2 = Buffer.from('ISv2', 'ascii');
const KEY_ID_LENGTH = 8;

/** Per-agent keychain account: scoped by the absolute stateDir so two agents
 *  on one machine can never clobber each other's master key. Readable in
 *  Keychain Access (the path IS the identity — debuggable, collision-free). */
export function perAgentKeychainAccount(stateDir: string): string {
  return `master-key:${path.resolve(stateDir)}`;
}

/** The 8-byte key fingerprint stored in the v2 header. */
export function keyIdOf(key: Buffer): Buffer {
  return crypto.createHash('sha256').update(key).digest().subarray(0, KEY_ID_LENGTH);
}

// ── Types ────────────────────────────────────────────────────────────

/** Injectable keychain operations (per service+account). Production uses the
 *  real OS keychain (macOS `security` / Linux `secret-tool`); tests inject a
 *  fake so the per-agent/adoption logic is unit-testable WITHOUT touching a
 *  real keychain (the VITEST file-key guard stays in force when this is not
 *  injected — an injected fake is, by definition, not the real keychain). */
export interface KeychainOps {
  read: (service: string, account: string) => Buffer | null;
  /** Returns true on success. */
  write: (service: string, account: string, key: Buffer) => boolean;
}

export interface SecretStoreConfig {
  /** State directory (.instar) */
  stateDir: string;
  /** Force file-based key storage (skip keychain) */
  forceFileKey?: boolean;
  /** Test seam — see KeychainOps. Absent in production (real keychain used). */
  keychainOps?: KeychainOps;
}

/** The decrypted secrets object (flat key-value or nested) */
export type Secrets = Record<string, unknown>;

/** Encrypted payload for wire transfer */
export interface EncryptedSecretPayload {
  /** Ephemeral X25519 public key (base64) */
  ephemeralPublicKey: string;
  /** AES-256-GCM initialization vector (base64) */
  iv: string;
  /** Encrypted ciphertext (base64) */
  ciphertext: string;
  /** AES-GCM authentication tag (base64) */
  tag: string;
}

// ── Master Key Management ────────────────────────────────────────────

/**
 * Store/retrieve the master key from the OS keychain.
 * Falls back to file-based storage if keychain is unavailable.
 */
export class MasterKeyManager {
  private stateDir: string;
  private forceFile: boolean;
  private keyFilePath: string;
  private kc: KeychainOps;

  constructor(stateDir: string, forceFile = false, keychainOps?: KeychainOps) {
    this.stateDir = stateDir;
    // Test runs are ALWAYS file-key-only — UNLESS a fake keychain is injected
    // (an injected KeychainOps is by definition not the real keychain, so the
    // pollution risk the guard exists for cannot occur). The real-keychain
    // guard (2026-06-05 incident: an integration test overwrote the then-
    // machine-global entry and broke the dev agent's vault) stays structural:
    // no test without an explicit fake can touch the OS keychain.
    const inTestRun = (!!process.env.VITEST || process.env.NODE_ENV === 'test') && !keychainOps;
    this.forceFile = forceFile || inTestRun;
    this.keyFilePath = path.join(stateDir, 'machine', 'secrets-master.key');
    this.kc = keychainOps ?? {
      read: (service, account) => this.readOsKeychain(service, account),
      write: (service, account, key) => this.writeOsKeychain(service, account, key),
    };
  }

  /**
   * Retrieve or generate the master key. Resolution order (vault-key-coherence,
   * CMT-1038 — the per-agent fix for the machine-global-slot bifurcation):
   *   1. the PER-AGENT keychain entry (`master-key:<stateDir>`);
   *   2. the LEGACY global entry (`master-key`) — ADOPTED on sight: copied into
   *      the per-agent account (the global entry is left in place for other
   *      not-yet-migrated agents; this code never writes it again);
   *   3. the per-agent file key (generating one — and writing the PER-AGENT
   *      keychain entry, never the global one — when none exists anywhere).
   */
  getMasterKey(): Buffer {
    if (!this.forceFile) {
      const account = perAgentKeychainAccount(this.stateDir);
      const own = this.tryRead(account);
      if (own) return own;
      const legacy = this.tryRead(KEYCHAIN_ACCOUNT_LEGACY);
      if (legacy) {
        // Adoption: persist under the per-agent account so this agent's key
        // resolution stops depending on the shared slot. Best-effort — a
        // failed write just means adoption retries on the next read.
        try { this.kc.write(KEYCHAIN_SERVICE, account, legacy); } catch { /* @silent-fallback-ok — retried next read */ }
        return legacy;
      }
    }

    // File fallback
    return this.getFileKey();
  }

  /**
   * Every key this agent could plausibly have encrypted its store with, primary
   * first: [resolved primary, the OTHER source's key if it exists and differs].
   * Read-only — alternates NEVER generate. Backs the dual-key read fallback
   * (a v1 store written before the sources diverged stays readable, loudly).
   */
  getCandidateKeys(): Array<{ key: Buffer; source: 'keychain' | 'file' }> {
    const out: Array<{ key: Buffer; source: 'keychain' | 'file' }> = [];
    const push = (key: Buffer | null, source: 'keychain' | 'file'): void => {
      if (key && !out.some((c) => c.key.equals(key))) out.push({ key, source });
    };
    if (this.forceFile) {
      push(this.getFileKey(), 'file');
      // Alternate: an existing keychain key (never generated) — covers a store
      // written under keychain resolution before forceFileKey was flipped on.
      push(this.tryRead(perAgentKeychainAccount(this.stateDir)), 'keychain');
      push(this.tryRead(KEYCHAIN_ACCOUNT_LEGACY), 'keychain');
      return out;
    }
    push(this.tryRead(perAgentKeychainAccount(this.stateDir)), 'keychain');
    push(this.tryRead(KEYCHAIN_ACCOUNT_LEGACY), 'keychain');
    // Existing file key as an alternate (do NOT generate one here — getFileKey
    // generates; alternates must be read-only).
    try {
      if (fs.existsSync(this.keyFilePath)) {
        push(Buffer.from(fs.readFileSync(this.keyFilePath, 'utf-8').trim(), 'hex'), 'file');
      }
    } catch { /* @silent-fallback-ok — unreadable alternate is simply absent */ }
    if (out.length === 0) push(this.getMasterKey(), this.forceFile ? 'file' : 'keychain');
    return out;
  }

  /** Whether the master key is stored in the OS keychain (vs file fallback). */
  get isKeychainBacked(): boolean {
    if (this.forceFile) return false;
    try {
      return (
        this.tryRead(perAgentKeychainAccount(this.stateDir)) !== null ||
        this.tryRead(KEYCHAIN_ACCOUNT_LEGACY) !== null
      );
    } catch {
      // @silent-fallback-ok — keychain unavailable, file fallback
      return false;
    }
  }

  private tryRead(account: string): Buffer | null {
    try { return this.kc.read(KEYCHAIN_SERVICE, account); }
    catch { return null; /* @silent-fallback-ok — keychain unavailable */ }
  }

  // ── OS keychain backends (account-parameterized) ────────────────

  private readOsKeychain(service: string, account: string): Buffer | null {
    if (process.platform === 'darwin') {
      try {
        const result = execFileSync('security', [
          'find-generic-password',
          '-s', service,
          '-a', account,
          '-w', // Print password only
        ], { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        return Buffer.from(result, 'base64');
      } catch {
        // @silent-fallback-ok — platform keychain read
        return null;
      }
    } else if (process.platform === 'linux') {
      try {
        const result = execFileSync('secret-tool', [
          'lookup',
          'service', service,
          'account', account,
        ], { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        return Buffer.from(result, 'base64');
      } catch {
        // @silent-fallback-ok — linux keychain read
        return null;
      }
    }
    return null; // Windows or unsupported — fall through to file
  }

  private writeOsKeychain(service: string, account: string, key: Buffer): boolean {
    if (process.platform === 'darwin') {
      try {
        // Delete existing entry first (ignore errors if it doesn't exist)
        try {
          execFileSync('security', [
            'delete-generic-password',
            '-s', service,
            '-a', account,
          ], { stdio: 'pipe', timeout: 5000 });
        } catch {
          // @silent-fallback-ok — entry may not exist
        }
        execFileSync('security', [
          'add-generic-password',
          '-s', service,
          '-a', account,
          '-w', key.toString('base64'),
        ], { stdio: 'pipe', timeout: 5000 });
        return true;
      } catch (err) {
        DegradationReporter.getInstance().report({
          feature: 'SecretStore.writeMacOSKeychain',
          primary: 'Persist master key to macOS keychain',
          fallback: 'Key only in memory — lost on restart',
          reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
          impact: 'Master key not persisted, may be lost',
        });
        return false;
      }
    } else if (process.platform === 'linux') {
      try {
        execFileSync('secret-tool', [
          'store',
          '--label', 'Instar Secret Store Master Key',
          'service', service,
          'account', account,
        ], {
          input: key.toString('base64'),
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return true;
      } catch (err) {
        DegradationReporter.getInstance().report({
          feature: 'SecretStore.writeLinuxKeychain',
          primary: 'Persist master key to Linux keychain',
          fallback: 'Key only in memory — lost on restart',
          reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
          impact: 'Master key not persisted, may be lost',
        });
        return false;
      }
    }
    return false;
  }

  // ── File fallback ───────────────────────────────────────────────

  private getFileKey(): Buffer {
    if (fs.existsSync(this.keyFilePath)) {
      const hex = fs.readFileSync(this.keyFilePath, 'utf-8').trim();
      return Buffer.from(hex, 'hex');
    }

    // Generate new key
    const key = crypto.randomBytes(MASTER_KEY_LENGTH);

    // Try to store under the PER-AGENT keychain account first (never the
    // legacy global slot — writing that slot is how the 2026-06-05 incident
    // broke every other vault on the machine).
    if (!this.forceFile) {
      try {
        if (this.kc.write(KEYCHAIN_SERVICE, perAgentKeychainAccount(this.stateDir), key)) return key;
      } catch { /* @silent-fallback-ok — fall through to file */ }
    }

    // Write to file with restrictive permissions
    const dir = path.dirname(this.keyFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.keyFilePath, key.toString('hex'), { mode: 0o600 });
    return key;
  }
}

// ── Secret Store (At-Rest) ───────────────────────────────────────────

export class SecretStore {
  private stateDir: string;
  private keyManager: MasterKeyManager;
  private encryptedPath: string;
  /** Which key source decrypted the LAST successful read() — observability for
   *  the dual-key fallback ('keychain' | 'file'; null before any read). */
  lastReadKeySource: 'keychain' | 'file' | null = null;

  constructor(config: SecretStoreConfig) {
    this.stateDir = config.stateDir;
    this.keyManager = new MasterKeyManager(config.stateDir, config.forceFileKey, config.keychainOps);
    this.encryptedPath = path.join(config.stateDir, 'secrets', 'config.secrets.enc');
  }

  /**
   * Read and decrypt secrets from the encrypted store. Returns empty object if
   * no secrets exist.
   *
   * Vault-key-coherence (CMT-1038): tries every candidate key (primary first,
   * then the OTHER source — keychain↔file) so a store written before the key
   * sources diverged stays READABLE instead of looking "empty" to half the
   * readers (the 2026-06-05 bifurcation incident). A v2 file's keyId header
   * names the required key, so wrong-key is a precise error distinct from
   * corruption. Success via a non-primary key emits a loud degradation report;
   * the next write() converges the store back to the primary key.
   */
  read(): Secrets {
    if (!fs.existsSync(this.encryptedPath)) {
      return {};
    }

    const raw = fs.readFileSync(this.encryptedPath);
    const candidates = this.keyManager.getCandidateKeys();

    // ── v2 format: 'ISv2' | keyId(8) | iv | tag | ct — the keyId names the key ──
    if (raw.length > STORE_MAGIC_V2.length + KEY_ID_LENGTH && raw.subarray(0, STORE_MAGIC_V2.length).equals(STORE_MAGIC_V2)) {
      const wantId = raw.subarray(STORE_MAGIC_V2.length, STORE_MAGIC_V2.length + KEY_ID_LENGTH);
      const body = raw.subarray(STORE_MAGIC_V2.length + KEY_ID_LENGTH);
      const match = candidates.find((c) => keyIdOf(c.key).equals(wantId));
      if (!match) {
        throw new Error(
          `SecretStore: store is encrypted with key id ${wantId.toString('hex')} — ` +
          `no resolvable key matches (have: ${candidates.map((c) => `${c.source}:${keyIdOf(c.key).toString('hex')}`).join(', ') || 'none'}). ` +
          `The vault is NOT empty; the matching master key is missing.`,
        );
      }
      const secrets = this.decryptAES(body, match.key); // auth failure here = real corruption (key matched)
      this.noteReadKeySource(match.source, candidates[0]?.source);
      return secrets;
    }

    // ── v1 (legacy, headerless): try candidates in order ──
    let lastErr: unknown = null;
    for (const c of candidates) {
      try {
        const secrets = this.decryptAES(raw, c.key);
        this.noteReadKeySource(c.source, candidates[0]?.source);
        return secrets;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(
      `SecretStore: no resolvable key decrypts the store (tried ${candidates.length}: ` +
      `${candidates.map((c) => `${c.source}:${keyIdOf(c.key).toString('hex')}`).join(', ') || 'none'}). ` +
      `The vault is NOT empty; the matching master key is missing. Last error: ` +
      `${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }

  /** Record the source that decrypted; loudly report a non-primary success. */
  private noteReadKeySource(used: 'keychain' | 'file', primary: 'keychain' | 'file' | undefined): void {
    this.lastReadKeySource = used;
    if (primary && used !== primary) {
      DegradationReporter.getInstance().report({
        feature: 'SecretStore.dualKeyRead',
        primary: `Decrypt the vault with the primary (${primary}) master key`,
        fallback: `Decrypted with the ${used} key instead`,
        reason: 'Why: the keychain and file master keys have DIVERGED for this agent (the 2026-06-05 bifurcation class). The data is intact and readable.',
        impact: 'The next write() re-encrypts with the primary key (v2 format), converging the sources. If divergence persists, inspect the per-agent keychain entry and .instar/machine/secrets-master.key.',
      });
    }
  }

  /** Encrypt and write secrets to the store (v2 format — keyId header). */
  write(secrets: Secrets): void {
    const masterKey = this.keyManager.getMasterKey();
    const encrypted = Buffer.concat([STORE_MAGIC_V2, keyIdOf(masterKey), this.encryptAES(secrets, masterKey)]);

    const dir = path.dirname(this.encryptedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Atomic write via temp file
    const tmpPath = this.encryptedPath + '.tmp';
    fs.writeFileSync(tmpPath, encrypted, { mode: 0o600 });
    fs.renameSync(tmpPath, this.encryptedPath);
  }

  /** Get a specific secret by dot-notation path (e.g., 'telegram.token'). */
  get(keyPath: string): unknown {
    const secrets = this.read();
    return getNestedValue(secrets, keyPath);
  }

  /** Set a specific secret by dot-notation path. */
  set(keyPath: string, value: unknown): void {
    const secrets = this.read();
    setNestedValue(secrets, keyPath, value);
    this.write(secrets);
  }

  /** Delete a specific secret by dot-notation path. */
  delete(keyPath: string): void {
    const secrets = this.read();
    deleteNestedValue(secrets, keyPath);
    this.write(secrets);
  }

  /** Whether the secret store file exists. */
  get exists(): boolean {
    return fs.existsSync(this.encryptedPath);
  }

  /** Whether the master key is in the OS keychain. */
  get isKeychainBacked(): boolean {
    return this.keyManager.isKeychainBacked;
  }

  /** Delete the encrypted store file. */
  destroy(): void {
    if (fs.existsSync(this.encryptedPath)) {
      SafeFsExecutor.safeUnlinkSync(this.encryptedPath, { operation: 'src/core/SecretStore.ts:303' });
    }
  }

  // ── AES-256-GCM Helpers ────────────────────────────────────────

  private encryptAES(data: Secrets, key: Buffer): Buffer {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = Buffer.from(JSON.stringify(data), 'utf-8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Format: [iv (12)] [tag (16)] [ciphertext]
    return Buffer.concat([iv, tag, encrypted]);
  }

  private decryptAES(raw: Buffer, key: Buffer): Secrets {
    if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
      throw new Error('SecretStore: encrypted file is too short (corrupted?)');
    }

    const iv = raw.subarray(0, IV_LENGTH);
    const tag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf-8'));
  }
}

// ── Forward-Secret Wire Encryption ───────────────────────────────────

/**
 * Encrypt secrets for wire transfer using forward-secret ECDH.
 *
 * Protocol:
 * 1. Generate ephemeral X25519 key pair
 * 2. ECDH: ephemeral private + recipient's long-term public = shared secret
 * 3. HKDF-SHA256 to derive AES-256 key
 * 4. AES-256-GCM encrypt
 * 5. Return: { ephemeralPublicKey, iv, ciphertext, tag }
 *
 * The ephemeral private key is not retained — forward secrecy.
 */
export function encryptForSync(
  secrets: Secrets,
  recipientPublicKeyBase64: string,
): EncryptedSecretPayload {
  // Generate ephemeral X25519 key pair
  const ephemeral = crypto.generateKeyPairSync('x25519');
  const ephemeralPublicRaw = ephemeral.publicKey.export({ type: 'spki', format: 'der' });
  // X25519 SPKI DER: 12-byte header + 32-byte key
  const ephemeralPublicBytes = ephemeralPublicRaw.subarray(ephemeralPublicRaw.length - 32);

  // Reconstruct recipient's X25519 public key from base64
  // Handles both raw 32-byte keys and full SPKI DER (44 bytes)
  const recipientPublicBytes = Buffer.from(recipientPublicKeyBase64, 'base64');
  const recipientSpki = recipientPublicBytes.length === 32
    ? buildX25519Spki(recipientPublicBytes)
    : recipientPublicBytes; // Already SPKI DER
  const recipientKey = crypto.createPublicKey({
    key: recipientSpki,
    format: 'der',
    type: 'spki',
  });

  // ECDH: shared secret
  const sharedSecret = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipientKey,
  });

  // HKDF: derive AES-256 key
  const salt = ephemeralPublicBytes;
  const derivedKey = crypto.hkdfSync('sha256', sharedSecret, salt, HKDF_INFO, 32);

  // AES-256-GCM encrypt
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(derivedKey), iv);
  const plaintext = Buffer.from(JSON.stringify(secrets), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ephemeralPublicKey: ephemeralPublicBytes.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: encrypted.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/**
 * Decrypt secrets received via wire transfer.
 *
 * Protocol:
 * 1. ECDH: own private key + sender's ephemeral public = shared secret
 * 2. HKDF-SHA256 to derive AES-256 key
 * 3. AES-256-GCM decrypt
 */
export function decryptFromSync(
  payload: EncryptedSecretPayload,
  ownPrivateKey: crypto.KeyObject,
): Secrets {
  // Reconstruct sender's ephemeral public key
  const ephemeralPublicBytes = Buffer.from(payload.ephemeralPublicKey, 'base64');
  const ephemeralKey = crypto.createPublicKey({
    key: buildX25519Spki(ephemeralPublicBytes),
    format: 'der',
    type: 'spki',
  });

  // ECDH: shared secret
  const sharedSecret = crypto.diffieHellman({
    privateKey: ownPrivateKey,
    publicKey: ephemeralKey,
  });

  // HKDF: derive AES-256 key
  const salt = ephemeralPublicBytes;
  const derivedKey = crypto.hkdfSync('sha256', sharedSecret, salt, HKDF_INFO, 32);

  // AES-256-GCM decrypt
  const iv = Buffer.from(payload.iv, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(derivedKey), iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf-8'));
}

// ── Account-credential sealing (WS5.2 Mechanism A — AAD-bound) ───────
//
// CRITICAL (spec §3.1, R3): `encryptForSync`/`decryptFromSync` above CANNOT
// carry an AAD binding — `decryptFromSync` will decrypt ANY payload sealed to a
// machine's long-term X25519 key, with no concept of recipient/account/epoch.
// A captured Mechanism-A blob replayed through that path would decrypt happily,
// defeating the entire binding. Therefore credential-class payloads use this
// DISTINCT pair, which:
//   1. derives its AES key under a SEPARATE HKDF info string, so a blob sealed
//      by `encryptForSync` can NEVER decrypt here and vice-versa (cryptographic
//      domain separation — defense in depth on top of the wire-verb split);
//   2. binds the AAD (recipient fingerprint, account id, mandate id, single-use
//      grant id, pairing epoch) into AES-256-GCM via `setAAD`, so any mismatch
//      fails the tag check; AND
//   3. `decryptAccountCredential` FAILS CLOSED (throws) on an absent or
//      mismatched AAD BEFORE attempting decryption — never silently degrading.

/** HKDF info string for account-credential sealing — DISTINCT from secret-sync. */
const ACCOUNT_CRED_HKDF_INFO = 'instar-account-credential-v1';

/**
 * Additional-authenticated-data binding a sealed credential to exactly one
 * (recipient machine, account, mandate, single-use grant, key-rotation epoch).
 * Every field is load-bearing: a payload sealed with one AAD cannot be consumed
 * under any other (recipient swap, account swap, replay, post-rotation reuse).
 */
export interface AccountCredentialAAD {
  /** Routing fingerprint of the machine this blob is sealed FOR (recipient binding, S1/S2). */
  recipientFingerprint: string;
  /** SubscriptionAccount.id the credential belongs to (account binding). */
  accountId: string;
  /** Authorizing coordination-mandate id (R1). */
  mandateId: string;
  /** Single-use grant id — a consumed grant must be rejected on replay (R3, §8.1). */
  grantId: string;
  /** Recipient X25519 key-rotation generation (R4b) — old blobs die on de-pair rotation. */
  pairingEpoch: number;
}

/** Encrypted account-credential payload (AAD carried in clear, authenticated by GCM). */
export interface EncryptedAccountCredentialPayload {
  /** Ephemeral X25519 public key (base64). */
  ephemeralPublicKey: string;
  /** AES-256-GCM initialization vector (base64). */
  iv: string;
  /** Encrypted ciphertext (base64). */
  ciphertext: string;
  /** AES-GCM authentication tag (base64). */
  tag: string;
  /** The AAD this blob was sealed with — authenticated, not confidential. */
  aad: AccountCredentialAAD;
}

const ACCOUNT_CRED_AAD_FIELDS: ReadonlyArray<keyof AccountCredentialAAD> = [
  'recipientFingerprint',
  'accountId',
  'mandateId',
  'grantId',
  'pairingEpoch',
];

/**
 * Validate + canonicalize an AAD into a stable byte string for GCM binding.
 * Throws (fail-closed) if any field is absent or the wrong type — a malformed
 * AAD can never produce a usable key.
 */
function canonicalizeAccountCredentialAAD(aad: AccountCredentialAAD | undefined | null): Buffer {
  if (!aad || typeof aad !== 'object') {
    throw new Error('account-credential AAD missing or not an object (fail-closed)');
  }
  for (const f of ACCOUNT_CRED_AAD_FIELDS) {
    const v = aad[f];
    if (f === 'pairingEpoch') {
      if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
        throw new Error(`account-credential AAD field "${f}" must be a non-negative integer (fail-closed)`);
      }
    } else if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`account-credential AAD field "${f}" must be a non-empty string (fail-closed)`);
    }
  }
  // Reject any extra keys so a smuggled field can never ride along unauthenticated.
  const extra = Object.keys(aad).filter((k) => !ACCOUNT_CRED_AAD_FIELDS.includes(k as keyof AccountCredentialAAD));
  if (extra.length > 0) {
    throw new Error(`account-credential AAD has unexpected field(s): ${extra.join(', ')} (fail-closed)`);
  }
  // Stable, field-ordered canonical form (independent of input key order).
  const canonical = ACCOUNT_CRED_AAD_FIELDS.map((f) => `${f}=${String(aad[f])}`).join('\x1f');
  return Buffer.from(`${ACCOUNT_CRED_HKDF_INFO}|${canonical}`, 'utf-8');
}

/**
 * Seal a credential to a single recipient, bound to an AAD (WS5.2 R3 / I2).
 * NOT `encryptForSync` — that function cannot carry the AAD binding.
 */
export function encryptAccountCredential(
  secrets: Secrets,
  recipientPublicKeyBase64: string,
  aad: AccountCredentialAAD,
): EncryptedAccountCredentialPayload {
  const aadBytes = canonicalizeAccountCredentialAAD(aad);

  const ephemeral = crypto.generateKeyPairSync('x25519');
  const ephemeralPublicRaw = ephemeral.publicKey.export({ type: 'spki', format: 'der' });
  const ephemeralPublicBytes = ephemeralPublicRaw.subarray(ephemeralPublicRaw.length - 32);

  const recipientPublicBytes = Buffer.from(recipientPublicKeyBase64, 'base64');
  const recipientSpki = recipientPublicBytes.length === 32
    ? buildX25519Spki(recipientPublicBytes)
    : recipientPublicBytes;
  const recipientKey = crypto.createPublicKey({ key: recipientSpki, format: 'der', type: 'spki' });

  const sharedSecret = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientKey });
  // DISTINCT HKDF info → domain separation from secret-sync.
  const derivedKey = crypto.hkdfSync('sha256', sharedSecret, ephemeralPublicBytes, ACCOUNT_CRED_HKDF_INFO, 32);

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(derivedKey), iv);
  cipher.setAAD(aadBytes);
  const plaintext = Buffer.from(JSON.stringify(secrets), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ephemeralPublicKey: ephemeralPublicBytes.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: encrypted.toString('base64'),
    tag: tag.toString('base64'),
    // Return a clean, field-ordered copy (never the caller's object).
    aad: {
      recipientFingerprint: aad.recipientFingerprint,
      accountId: aad.accountId,
      mandateId: aad.mandateId,
      grantId: aad.grantId,
      pairingEpoch: aad.pairingEpoch,
    },
  };
}

/**
 * Decrypt an account credential, verifying the AAD matches expectation.
 * FAILS CLOSED (throws) when: the payload AAD or `expectedAAD` is absent or
 * malformed; the two AADs differ; the recipient X25519 key has rotated since
 * sealing (R4b); or the GCM tag does not authenticate. NOT `decryptFromSync`,
 * which has no AAD concept and would decrypt a replayed blob.
 */
export function decryptAccountCredential(
  payload: EncryptedAccountCredentialPayload,
  ownPrivateKey: crypto.KeyObject,
  expectedAAD: AccountCredentialAAD,
): Secrets {
  if (!payload || typeof payload !== 'object') {
    throw new Error('account-credential payload missing (fail-closed)');
  }
  // Canonicalize BOTH (each validates) and compare BEFORE any crypto work.
  const expectedBytes = canonicalizeAccountCredentialAAD(expectedAAD);
  const payloadBytes = canonicalizeAccountCredentialAAD(payload.aad);
  if (!crypto.timingSafeEqual(expectedBytes, payloadBytes)) {
    throw new Error('account-credential AAD mismatch (fail-closed)');
  }

  const ephemeralPublicBytes = Buffer.from(payload.ephemeralPublicKey, 'base64');
  const ephemeralKey = crypto.createPublicKey({
    key: buildX25519Spki(ephemeralPublicBytes),
    format: 'der',
    type: 'spki',
  });
  const sharedSecret = crypto.diffieHellman({ privateKey: ownPrivateKey, publicKey: ephemeralKey });
  const derivedKey = crypto.hkdfSync('sha256', sharedSecret, ephemeralPublicBytes, ACCOUNT_CRED_HKDF_INFO, 32);

  const iv = Buffer.from(payload.iv, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(derivedKey), iv);
  decipher.setAAD(expectedBytes);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf-8'));
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Build X25519 SPKI DER from raw 32-byte public key. */
function buildX25519Spki(publicKeyRaw: Buffer): Buffer {
  // X25519 SPKI header (12 bytes): 30 2a 30 05 06 03 2b 65 6e 03 21 00
  const header = Buffer.from('302a300506032b656e032100', 'hex');
  return Buffer.concat([header, publicKeyRaw]);
}

/** Get nested value from object using dot notation. */
function getNestedValue(obj: Record<string, unknown>, keyPath: string): unknown {
  const parts = keyPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Set nested value in object using dot notation. */
function setNestedValue(obj: Record<string, unknown>, keyPath: string, value: unknown): void {
  const parts = keyPath.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

/** Delete nested value from object using dot notation. */
function deleteNestedValue(obj: Record<string, unknown>, keyPath: string): void {
  const parts = keyPath.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
      return; // Path doesn't exist
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  delete current[parts[parts.length - 1]];
}
