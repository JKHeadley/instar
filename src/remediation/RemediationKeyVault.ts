/**
 * RemediationKeyVault — per-context, per-scope HKDF leaf-key derivation for
 * the Self-Healing Remediator (Tier-1 / F-1).
 *
 * Drives the cryptographic foundation for the Remediator's five authority
 * surfaces (capability tokens, probe authentication, in-flight lockfiles,
 * cross-process attempt ledger, audit). Each surface gets a per-`(context,
 * scopeId)` leaf key via HKDF-SHA256 over:
 *
 *   master subkey (per-context, in keychain) +
 *   install nonce  (per-install,  in keychain) +
 *   info-field     (domain-separated tag + length-prefixed scopeId)
 *
 * The HKDF info-field format is verbatim from spec amendment A54:
 *
 *   info = "instar-remediation-v1:" || contextTag (16 bytes, '-' padded)
 *          || ":" || uint32be(len(scopeId)) || scopeId
 *
 * Audit-context derivation uses an empty scopeId (one shared machine-wide).
 *
 * Backend priority (A58):
 *   1. OS Keychain (macOS `security`, Linux `secret-tool`/libsecret).
 *   2. Hardware enclave (TPM 2.0 / Secure Enclave) — Tier-1 stub, falls
 *      through to next backend with explicit "not yet implemented" trace.
 *   3. Cloud KMS (AWS / GCP / Azure) — Tier-1 stub, same fall-through.
 *   4. Env-var passphrase + AES-256-GCM encrypted flatfile at
 *      `<stateDir>/remediation-keys.age` (`.age` suffix for forward-compat;
 *      F-1 uses Node's built-in AES-GCM, not the `age` library).
 *
 * Failure modes follow A62's operating-state matrix:
 *   - No backend available           → cannot start (throw).
 *   - Any context master missing     → throw with explicit context name.
 *   - Install nonce missing on a pre-existing install → fail-closed (throw).
 *   - Install nonce missing on a fresh install        → mint a new one.
 *
 * Spec reference: docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md
 * Amendments anchored here: A3, A20, A23, A39, A42, A51, A54, A58, A62.
 *
 * F-1 deliberately reuses the multi-backend abstraction from
 * `src/core/WorktreeKeyVault.ts` (A39 prior-art note) rather than
 * introducing a new system dependency.
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ── Constants ────────────────────────────────────────────────────────

const SECURE_FILE_MODE = 0o600;
const SCRYPT_PARAMS = { N: 1 << 16, r: 8, p: 1 } as const;
const SCRYPT_KEY_LEN = 32;
const HKDF_OUTPUT_LEN = 32; // 256-bit leaf keys (A54)
const INSTALL_NONCE_LEN = 32; // 256-bit (A39 / A51)
const MASTER_KEY_LEN = 32; // 256-bit per-context master subkey (A20 / A39)

const HKDF_INFO_PREFIX = Buffer.from('instar-remediation-v1:', 'utf-8');
const HKDF_SEPARATOR = Buffer.from(':', 'utf-8');

const KEYCHAIN_SERVICE = 'ai.instar.remediation';
const KEYCHAIN_NONCE_ACCOUNT = 'install-nonce';
// Per-context master subkey keychain accounts.
const KEYCHAIN_MASTER_ACCOUNTS: Record<RemediationContext, string> = {
  capability: 'capability',
  probe: 'probe',
  inflight: 'inflight',
  ledger: 'ledger',
  audit: 'audit',
};

// Fixed 16-byte right-`-`-padded tags per A54. Verbatim:
//   capability--------  probe-----------  inflight--------
//   ledger----------    audit-----------
const CONTEXT_TAG: Record<RemediationContext, Buffer> = {
  capability: Buffer.from('capability------', 'utf-8'),
  probe: Buffer.from('probe-----------', 'utf-8'),
  inflight: Buffer.from('inflight--------', 'utf-8'),
  ledger: Buffer.from('ledger----------', 'utf-8'),
  audit: Buffer.from('audit-----------', 'utf-8'),
};
// Sanity: every tag is exactly 16 bytes.
for (const [ctx, tag] of Object.entries(CONTEXT_TAG)) {
  if (tag.length !== 16) {
    throw new Error(`contextTag for "${ctx}" must be 16 bytes, got ${tag.length}`);
  }
}

// ── Public types ─────────────────────────────────────────────────────

export type RemediationContext =
  | 'capability'   // scopeId = runbookId
  | 'probe'        // scopeId = probeId
  | 'inflight'     // scopeId = surfaceId
  | 'ledger'       // scopeId = runbookId
  | 'audit';       // scopeId = null (one shared per machine)

export type RemediationKeyVaultBackend =
  | 'os-keychain'
  | 'hardware-enclave'
  | 'cloud-kms'
  | 'env-passphrase';

export interface VaultOptions {
  /** Allow env-passphrase fallback (forwarded to passphraseResolver). */
  allowEnvPassphraseFallback?: boolean;
  /** Resolver for env-passphrase mode. Returns passphrase or null/empty. */
  passphraseResolver?: () => Promise<string | null> | string | null;
  /** Force a specific backend (tests). */
  forceBackend?: RemediationKeyVaultBackend;
  /**
   * Force the available-backend-detection result without skipping the
   * normal preference order. Used by tests to simulate platform shape.
   */
  backendDetectorOverride?: {
    macOsKeychain?: boolean;
    linuxLibsecret?: boolean;
    hardwareEnclave?: boolean;
    cloudKms?: boolean;
  };
  /**
   * When true, refuse to mint a fresh install nonce if any per-context
   * master already exists — the caller is asserting this is NOT a fresh
   * install. Set by callers that track install state out-of-band.
   *
   * Default behavior: if no masters and no nonce exist, treat as fresh
   * install and mint both. If any master exists but nonce is missing,
   * fail-closed (per A62 + A51).
   */
  freshInstallGate?: boolean;
}

export class RemediationKeyVaultError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'RemediationKeyVaultError';
  }
}

// ── Backend probes ───────────────────────────────────────────────────

function macOsKeychainAvailable(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('security', ['list-keychains', '-d', 'user'], { stdio: 'pipe', timeout: 2000 });
    return true;
  } catch { return false; }
}

function linuxLibsecretAvailable(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    execFileSync('secret-tool', ['--version'], { stdio: 'pipe', timeout: 2000 });
    return !!process.env.DBUS_SESSION_BUS_ADDRESS;
  } catch { return false; }
}

/**
 * Hardware-enclave (TPM 2.0 / Secure Enclave) — Tier-1 stub.
 * Returns false unconditionally; F-1 falls through to the next backend.
 * F-2+ wires real detection (e.g., `tpm2_getcap`, macOS SE bridge).
 */
function hardwareEnclaveAvailable(): boolean {
  return false;
}

/**
 * Cloud KMS (AWS / GCP / Azure) — Tier-1 stub.
 * Returns false unconditionally; F-1 falls through to the next backend.
 * F-2+ reads from config (`remediation.kms.provider`) and detects.
 */
function cloudKmsAvailable(): boolean {
  return false;
}

// ── Keychain CLI wrappers (same b64-prefix convention as WorktreeKeyVault) ──

const KEYCHAIN_VALUE_PREFIX = 'b64:';

function encodeForKeychain(value: string): string {
  return KEYCHAIN_VALUE_PREFIX + Buffer.from(value, 'utf-8').toString('base64');
}

function decodeFromKeychain(stored: string | null): string | null {
  if (stored === null || stored === undefined) return null;
  if (stored.startsWith(KEYCHAIN_VALUE_PREFIX)) {
    try {
      return Buffer.from(stored.slice(KEYCHAIN_VALUE_PREFIX.length), 'base64').toString('utf-8');
    } catch {
      return null;
    }
  }
  // Hex-fallback for legacy values surfaced by `security -w` on multi-line content.
  if (/^[0-9a-f]+$/.test(stored) && stored.length >= 40 && stored.length % 2 === 0) {
    try { return Buffer.from(stored, 'hex').toString('utf-8'); } catch { return stored; }
  }
  return stored;
}

function macReadItem(account: string): string | null {
  try {
    const raw = execFileSync('security', [
      'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w',
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }).trim();
    return decodeFromKeychain(raw);
  } catch { return null; }
}

function macWriteItem(account: string, value: string): void {
  try {
    execFileSync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account], {
      stdio: 'pipe', timeout: 5000,
    });
  } catch { /* @silent-fallback-ok */ }
  execFileSync('security', [
    'add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w', encodeForKeychain(value),
  ], { stdio: 'pipe', timeout: 5000 });
}

function linuxReadItem(account: string): string | null {
  try {
    const raw = execFileSync('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'account', account], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
    }).trim();
    return decodeFromKeychain(raw);
  } catch { return null; }
}

function linuxWriteItem(account: string, value: string): void {
  execFileSync('secret-tool', ['store', '--label', `instar-remediation:${account}`,
    'service', KEYCHAIN_SERVICE, 'account', account], {
    input: encodeForKeychain(value), timeout: 5000,
  });
}

// ── Env-passphrase flatfile backend ──────────────────────────────────

interface FlatFilePayload {
  version: 1;
  kdf: 'scrypt';
  scryptParams: { N: number; r: number; p: number };
  salt: string; // base64
  iv: string;   // base64
  ciphertext: string; // base64
  authTag: string;    // base64
}

interface FlatFileSecrets {
  installNonceB64: string;
  masters: Partial<Record<RemediationContext, string /* base64 */>>;
}

async function deriveKeyFromPassphrase(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const maxmem = 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2;
    crypto.scrypt(passphrase, salt, SCRYPT_KEY_LEN, { ...SCRYPT_PARAMS, maxmem }, (err, derived) => {
      if (err) reject(err); else resolve(derived);
    });
  });
}

async function flatFileWrite(filePath: string, plaintext: string, passphrase: string): Promise<void> {
  const salt = crypto.randomBytes(16);
  const key = await deriveKeyFromPassphrase(passphrase, salt);
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const payload: FlatFilePayload = {
      version: 1,
      kdf: 'scrypt',
      scryptParams: SCRYPT_PARAMS,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ct.toString('base64'),
      authTag: authTag.toString('base64'),
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload), { mode: SECURE_FILE_MODE });
  } finally {
    key.fill(0);
  }
}

async function flatFileRead(filePath: string, passphrase: string): Promise<string> {
  const payload: FlatFilePayload = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (payload.version !== 1 || payload.kdf !== 'scrypt') {
    throw new RemediationKeyVaultError(
      `unsupported keyvault version: ${payload.version}/${payload.kdf}`,
      'flatfile-version-mismatch',
    );
  }
  const salt = Buffer.from(payload.salt, 'base64');
  const iv = Buffer.from(payload.iv, 'base64');
  const ct = Buffer.from(payload.ciphertext, 'base64');
  const authTag = Buffer.from(payload.authTag, 'base64');
  const key = await deriveKeyFromPassphrase(passphrase, salt);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf-8');
  } finally {
    key.fill(0);
  }
}

// ── HKDF info-field construction (A54, verbatim) ─────────────────────

/**
 * Build the HKDF `info` parameter per A54.
 *
 *   info = "instar-remediation-v1:" || contextTag(16) || ":" ||
 *          uint32be(len(scopeId)) || scopeId
 *
 * `scopeId` of `null` (audit context) is treated as the empty string —
 * length-prefix is 0 and no scope bytes follow. Domain separation is
 * still preserved by the contextTag.
 */
export function buildHkdfInfo(context: RemediationContext, scopeId: string | null): Buffer {
  const tag = CONTEXT_TAG[context];
  if (!tag) {
    throw new RemediationKeyVaultError(
      `unknown remediation context: "${String(context)}"`,
      'unknown-context',
    );
  }
  const scopeBytes = scopeId == null ? Buffer.alloc(0) : Buffer.from(scopeId, 'utf-8');
  if (scopeBytes.length > 0xffffffff) {
    throw new RemediationKeyVaultError('scopeId exceeds uint32 length cap', 'scope-too-long');
  }
  const lenPrefix = Buffer.alloc(4);
  lenPrefix.writeUInt32BE(scopeBytes.length, 0);
  return Buffer.concat([HKDF_INFO_PREFIX, tag, HKDF_SEPARATOR, lenPrefix, scopeBytes]);
}

// ── Public API ───────────────────────────────────────────────────────

export class RemediationKeyVault {
  private readonly backend: RemediationKeyVaultBackend;
  private readonly installNonce: Buffer;
  private readonly masters: Record<RemediationContext, Buffer>;
  private readonly stateDir: string;
  private readonly options: VaultOptions;

  private constructor(args: {
    backend: RemediationKeyVaultBackend;
    installNonce: Buffer;
    masters: Record<RemediationContext, Buffer>;
    stateDir: string;
    options: VaultOptions;
  }) {
    this.backend = args.backend;
    this.installNonce = Buffer.from(args.installNonce);
    this.masters = {
      capability: Buffer.from(args.masters.capability),
      probe: Buffer.from(args.masters.probe),
      inflight: Buffer.from(args.masters.inflight),
      ledger: Buffer.from(args.masters.ledger),
      audit: Buffer.from(args.masters.audit),
    };
    this.stateDir = args.stateDir;
    this.options = args.options;
  }

  /**
   * Load (or initialize on fresh install) the vault for the given state dir.
   * Backend selection follows A58's priority order: keychain → hardware
   * enclave (stub) → cloud KMS (stub) → env-passphrase flatfile.
   */
  static async forStateDir(stateDir: string, options: VaultOptions = {}): Promise<RemediationKeyVault> {
    const backend = selectBackend(options);
    if (backend === null) {
      throw new RemediationKeyVaultError(
        'cannot start — no secret backend available',
        'no-backend-available',
      );
    }

    if (backend === 'os-keychain') {
      const macOs = detectorSays(options, 'macOsKeychain', macOsKeychainAvailable());
      const read = macOs ? macReadItem : linuxReadItem;
      const write = macOs ? macWriteItem : linuxWriteItem;
      const { installNonce, masters } = await loadOrInitKeychain(read, write, options);
      return new RemediationKeyVault({
        backend, installNonce, masters, stateDir, options,
      });
    }

    if (backend === 'env-passphrase') {
      const flatFilePath = path.join(stateDir, 'remediation-keys.age');
      const { installNonce, masters } = await loadOrInitFlatFile(flatFilePath, options);
      return new RemediationKeyVault({
        backend, installNonce, masters, stateDir, options,
      });
    }

    // Tier-1 stubs — should not be reachable because their `*Available`
    // probes return false. If we get here, something has gone wrong with
    // the selection logic; fail-closed.
    throw new RemediationKeyVaultError(
      `backend "${backend}" is a Tier-1 stub and is not implemented; falling back was expected`,
      'tier1-stub-unreachable',
    );
  }

  /** Derive a 32-byte leaf key for the given (context, scopeId). */
  deriveLeafKey(context: RemediationContext, scopeId: string | null): Buffer {
    const master = this.masters[context];
    if (!master) {
      throw new RemediationKeyVaultError(
        `no master subkey loaded for context "${context}"`,
        'master-missing',
      );
    }
    const info = buildHkdfInfo(context, scopeId);
    // Node's crypto.hkdfSync caps `info` at 1024 bytes. Real scopeIds
    // (runbookId / probeId / surfaceId) are short identifiers; we enforce
    // a generous cap that leaves room for the 43-byte preamble (prefix +
    // tag + sep + lenPrefix).
    if (info.length > 1024) {
      throw new RemediationKeyVaultError(
        `HKDF info exceeds Node's 1024-byte cap (got ${info.length}); shorten scopeId`,
        'info-too-long',
      );
    }
    // HKDF-SHA256: salt = installNonce, ikm = master, info as built.
    // Node's crypto.hkdfSync returns ArrayBuffer; wrap in Buffer.
    const out = crypto.hkdfSync('sha256', master, this.installNonce, info, HKDF_OUTPUT_LEN);
    return Buffer.from(out);
  }

  /** Per-install nonce, used as HKDF salt across all derivations. */
  getInstallNonce(): Buffer {
    return Buffer.from(this.installNonce);
  }

  /** Which backend is in use. */
  getBackend(): RemediationKeyVaultBackend {
    return this.backend;
  }

  /**
   * Rotate a single context's master subkey. Invalidates every leaf derived
   * from that master; existing in-flight tokens signed by old leaves must be
   * verified through an overlap window owned by the caller (A20 / A39 spec).
   */
  async rotateContext(context: RemediationContext): Promise<void> {
    const fresh = crypto.randomBytes(MASTER_KEY_LEN);
    await this.persistMaster(context, fresh);
    // Replace in-memory master; zero the old buffer.
    const old = this.masters[context];
    this.masters[context] = fresh;
    if (old) old.fill(0);
  }

  /**
   * Rotate the install nonce. Invalidates all leaf keys across all contexts.
   * Callers MUST coordinate an overlap window with surfaces that hold cached
   * leaves (e.g., in-flight lockfiles must be re-signed).
   */
  async rotateInstallNonce(): Promise<void> {
    const fresh = crypto.randomBytes(INSTALL_NONCE_LEN);
    await this.persistInstallNonce(fresh);
    const old = this.installNonce;
    // Mutate in place so existing references see the new nonce.
    fresh.copy(this.installNonce, 0, 0, INSTALL_NONCE_LEN);
    old.fill(0); // best-effort; copy above overwrote it anyway
  }

  // ── persistence helpers ────────────────────────────────────────────

  private async persistMaster(context: RemediationContext, value: Buffer): Promise<void> {
    if (this.backend === 'os-keychain') {
      const macOs = detectorSays(this.options, 'macOsKeychain', macOsKeychainAvailable());
      const write = macOs ? macWriteItem : linuxWriteItem;
      write(KEYCHAIN_MASTER_ACCOUNTS[context], value.toString('base64'));
      return;
    }
    if (this.backend === 'env-passphrase') {
      await this.persistFlatFileWithMutation((secrets) => {
        secrets.masters[context] = value.toString('base64');
      });
      return;
    }
    throw new RemediationKeyVaultError(
      `persistMaster: unsupported backend "${this.backend}"`,
      'persist-backend-unsupported',
    );
  }

  private async persistInstallNonce(value: Buffer): Promise<void> {
    if (this.backend === 'os-keychain') {
      const macOs = detectorSays(this.options, 'macOsKeychain', macOsKeychainAvailable());
      const write = macOs ? macWriteItem : linuxWriteItem;
      write(KEYCHAIN_NONCE_ACCOUNT, value.toString('base64'));
      return;
    }
    if (this.backend === 'env-passphrase') {
      await this.persistFlatFileWithMutation((secrets) => {
        secrets.installNonceB64 = value.toString('base64');
      });
      return;
    }
    throw new RemediationKeyVaultError(
      `persistInstallNonce: unsupported backend "${this.backend}"`,
      'persist-backend-unsupported',
    );
  }

  private async persistFlatFileWithMutation(mutate: (s: FlatFileSecrets) => void): Promise<void> {
    const passphrase = await resolvePassphrase(this.options);
    if (!passphrase) {
      throw new RemediationKeyVaultError(
        'env-passphrase backend requires INSTAR_REMEDIATION_KEY_PASSPHRASE',
        'passphrase-missing',
      );
    }
    const flatFilePath = path.join(this.stateDir, 'remediation-keys.age');
    let secrets: FlatFileSecrets;
    if (fs.existsSync(flatFilePath)) {
      const decoded = await flatFileRead(flatFilePath, passphrase);
      secrets = JSON.parse(decoded) as FlatFileSecrets;
    } else {
      secrets = { installNonceB64: this.installNonce.toString('base64'), masters: {} };
    }
    mutate(secrets);
    await flatFileWrite(flatFilePath, JSON.stringify(secrets), passphrase);
  }
}

// ── Internal helpers ─────────────────────────────────────────────────

function selectBackend(options: VaultOptions): RemediationKeyVaultBackend | null {
  if (options.forceBackend) return options.forceBackend;
  const detected = {
    macOsKeychain: detectorSays(options, 'macOsKeychain', macOsKeychainAvailable()),
    linuxLibsecret: detectorSays(options, 'linuxLibsecret', linuxLibsecretAvailable()),
    hardwareEnclave: detectorSays(options, 'hardwareEnclave', hardwareEnclaveAvailable()),
    cloudKms: detectorSays(options, 'cloudKms', cloudKmsAvailable()),
  };
  if (detected.macOsKeychain || detected.linuxLibsecret) return 'os-keychain';
  if (detected.hardwareEnclave) return 'hardware-enclave';
  if (detected.cloudKms) return 'cloud-kms';
  if (options.allowEnvPassphraseFallback) return 'env-passphrase';
  return null;
}

function detectorSays(
  options: VaultOptions,
  key: keyof NonNullable<VaultOptions['backendDetectorOverride']>,
  fallback: boolean,
): boolean {
  const ov = options.backendDetectorOverride;
  if (ov && Object.prototype.hasOwnProperty.call(ov, key)) {
    return !!ov[key];
  }
  return fallback;
}

async function resolvePassphrase(options: VaultOptions): Promise<string | null> {
  if (options.passphraseResolver) {
    const value = await options.passphraseResolver();
    if (value && value.length > 0) return value;
  }
  const envValue = process.env.INSTAR_REMEDIATION_KEY_PASSPHRASE;
  if (envValue && envValue.length > 0) return envValue;
  return null;
}

async function loadOrInitKeychain(
  read: (account: string) => string | null,
  write: (account: string, value: string) => void,
  options: VaultOptions,
): Promise<{ installNonce: Buffer; masters: Record<RemediationContext, Buffer> }> {
  // Read existing masters.
  const existingMasters: Partial<Record<RemediationContext, Buffer>> = {};
  for (const ctx of Object.keys(KEYCHAIN_MASTER_ACCOUNTS) as RemediationContext[]) {
    const stored = read(KEYCHAIN_MASTER_ACCOUNTS[ctx]);
    if (stored !== null) {
      existingMasters[ctx] = Buffer.from(stored, 'base64');
    }
  }
  const anyMasterExists = Object.keys(existingMasters).length > 0;
  const allMastersExist =
    Object.keys(existingMasters).length === Object.keys(KEYCHAIN_MASTER_ACCOUNTS).length;

  // Read install nonce.
  const storedNonce = read(KEYCHAIN_NONCE_ACCOUNT);
  let installNonce: Buffer | null = storedNonce ? Buffer.from(storedNonce, 'base64') : null;

  // Failure mode (A51 / A62): install-nonce missing on a pre-existing install.
  if (!installNonce && anyMasterExists) {
    throw new RemediationKeyVaultError(
      'install nonce missing on existing install — fail-closed (A51)',
      'install-nonce-missing-existing-install',
    );
  }

  // Partial-master failure (A62): some masters exist, some don't.
  if (anyMasterExists && !allMastersExist) {
    const missing = (Object.keys(KEYCHAIN_MASTER_ACCOUNTS) as RemediationContext[])
      .filter((c) => !existingMasters[c]);
    throw new RemediationKeyVaultError(
      `partial master state — missing contexts: ${missing.join(', ')}`,
      'master-partial',
    );
  }

  // Fresh-install gate.
  if (!installNonce && !anyMasterExists) {
    if (options.freshInstallGate === false) {
      // Caller asserted not-fresh; refuse to mint.
      throw new RemediationKeyVaultError(
        'install nonce + masters absent but freshInstallGate=false — refusing to mint',
        'fresh-install-gate-refused',
      );
    }
    installNonce = crypto.randomBytes(INSTALL_NONCE_LEN);
    write(KEYCHAIN_NONCE_ACCOUNT, installNonce.toString('base64'));
  }

  // Mint any missing masters (only reached when no masters exist).
  const masters: Record<RemediationContext, Buffer> = {} as Record<RemediationContext, Buffer>;
  for (const ctx of Object.keys(KEYCHAIN_MASTER_ACCOUNTS) as RemediationContext[]) {
    if (existingMasters[ctx]) {
      masters[ctx] = existingMasters[ctx]!;
    } else {
      const fresh = crypto.randomBytes(MASTER_KEY_LEN);
      write(KEYCHAIN_MASTER_ACCOUNTS[ctx], fresh.toString('base64'));
      masters[ctx] = fresh;
    }
  }

  return { installNonce: installNonce!, masters };
}

async function loadOrInitFlatFile(
  flatFilePath: string,
  options: VaultOptions,
): Promise<{ installNonce: Buffer; masters: Record<RemediationContext, Buffer> }> {
  const passphrase = await resolvePassphrase(options);
  if (!passphrase) {
    throw new RemediationKeyVaultError(
      'env-passphrase backend requires INSTAR_REMEDIATION_KEY_PASSPHRASE',
      'passphrase-missing',
    );
  }
  if (passphrase.length < 12) {
    throw new RemediationKeyVaultError(
      'env-passphrase must be >= 12 characters',
      'passphrase-too-short',
    );
  }

  let secrets: FlatFileSecrets;
  const fileExists = fs.existsSync(flatFilePath);
  if (fileExists) {
    const decoded = await flatFileRead(flatFilePath, passphrase);
    secrets = JSON.parse(decoded) as FlatFileSecrets;
  } else {
    if (options.freshInstallGate === false) {
      throw new RemediationKeyVaultError(
        'remediation-keys.age absent but freshInstallGate=false — refusing to mint',
        'fresh-install-gate-refused',
      );
    }
    secrets = {
      installNonceB64: crypto.randomBytes(INSTALL_NONCE_LEN).toString('base64'),
      masters: {},
    };
  }

  // Validate / mint masters.
  let dirty = !fileExists;
  for (const ctx of Object.keys(KEYCHAIN_MASTER_ACCOUNTS) as RemediationContext[]) {
    if (!secrets.masters[ctx]) {
      if (fileExists) {
        // Pre-existing install with missing master — fail-closed.
        throw new RemediationKeyVaultError(
          `master for context "${ctx}" missing in existing flatfile`,
          'master-missing',
        );
      }
      secrets.masters[ctx] = crypto.randomBytes(MASTER_KEY_LEN).toString('base64');
      dirty = true;
    }
  }

  if (!secrets.installNonceB64) {
    if (fileExists) {
      throw new RemediationKeyVaultError(
        'install nonce missing in existing flatfile — fail-closed',
        'install-nonce-missing-existing-install',
      );
    }
    secrets.installNonceB64 = crypto.randomBytes(INSTALL_NONCE_LEN).toString('base64');
    dirty = true;
  }

  if (dirty) {
    await flatFileWrite(flatFilePath, JSON.stringify(secrets), passphrase);
  }

  const masters: Record<RemediationContext, Buffer> = {} as Record<RemediationContext, Buffer>;
  for (const ctx of Object.keys(KEYCHAIN_MASTER_ACCOUNTS) as RemediationContext[]) {
    masters[ctx] = Buffer.from(secrets.masters[ctx]!, 'base64');
  }
  return { installNonce: Buffer.from(secrets.installNonceB64, 'base64'), masters };
}
