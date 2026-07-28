/**
 * Machine identity management for multi-machine coordination.
 *
 * Each machine gets a persistent cryptographic identity:
 * - Ed25519 key pair for signing (commits, API requests)
 * - X25519 key pair for encryption (secret sync, pairing)
 * - 128-bit random machine ID
 * - Human-friendly name
 *
 * This is Phase 1 of the multi-machine spec.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MachineIdentity, MachineRegistry, MachineRegistryEntry, MachineRole, MachineCapability, MachineHardware } from './types.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { assignNickname, isValidNickname } from './NicknameAssigner.js';

// ── Constants ────────────────────────────────────────────────────────

const MACHINE_DIR = 'machine';
const MACHINES_DIR = 'machines';
const IDENTITY_FILE = 'identity.json';
const SIGNING_KEY_FILE = 'signing-key.pem';
// Pre-canonical-rename name some machine identities were keyed under; loadSigningKey
// falls back to it so a legacy-keyed agent's lease coordinator still attaches.
const LEGACY_SIGNING_KEY_FILE = 'signing-private.pem';
const ENCRYPTION_KEY_FILE = 'encryption-key.pem';
// Pre-canonical-rename name; loadEncryptionKey falls back to it for the same reason
// loadSigningKey does (the mesh transport loads BOTH keys at lease/transport setup).
const LEGACY_ENCRYPTION_KEY_FILE = 'encryption-private.pem';
const REGISTRY_FILE = 'registry.json';
const KEY_FILE_MODE = 0o600;
const REGISTRY_VERSION = 1;

// ── Error Messages (human-readable) ──────────────────────────────────

const ERRORS = {
  KEYGEN_FAILED: (detail: string) =>
    `Could not set up security for this machine. ${detail}\nTry: sudo chown -R $(whoami) .instar/machine/`,
  IDENTITY_EXISTS: 'This machine already has an identity. Use --force to regenerate (this will require re-pairing).',
  IDENTITY_NOT_FOUND: 'No machine identity found. Run `instar init` or `instar join` first.',
  REGISTRY_CORRUPT: 'Machine registry is corrupted. Run `instar doctor` for diagnosis.',
  MACHINE_NOT_FOUND: (id: string) => `Machine ${id} not found in registry.`,
  MACHINE_ALREADY_REVOKED: (name: string) => `Machine "${name}" is already revoked.`,
} as const;

// ── Key Generation ───────────────────────────────────────────────────

/**
 * Generate an Ed25519 key pair for signing.
 * Returns { publicKey, privateKey } in PEM format.
 */
export function generateSigningKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

/**
 * Generate an X25519 key pair for encryption (ECDH key agreement).
 * Returns { publicKey, privateKey } in PEM format.
 */
export function generateEncryptionKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

/**
 * Generate a 128-bit machine ID: "m_" + 32 random hex chars.
 */
export function generateMachineId(): string {
  return `m_${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * Detect a human-friendly name for this machine.
 * Uses hostname, falling back to a random name.
 */
export function detectMachineName(): string {
  const hostname = os.hostname();
  // Clean up hostname: remove .local suffix, lowercase
  const name = hostname.replace(/\.local$/i, '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return name || `machine-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Detect the platform string (e.g., "darwin-arm64", "linux-x64").
 */
export function detectPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * Detect available capabilities for this machine.
 */
export function detectCapabilities(): MachineCapability[] {
  // All machines start with these. Tunnel/telegram presence
  // is determined by config, checked at runtime.
  return ['sessions', 'jobs', 'telegram', 'tunnel'];
}

// ── PEM Encoding Helpers ─────────────────────────────────────────────

/**
 * Extract the base64-encoded key data from a PEM string.
 */
export function pemToBase64(pem: string): string {
  return pem
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s/g, '');
}

/**
 * Sign data with an Ed25519 private key (PEM format).
 * Returns the signature as a base64 string.
 */
export function sign(data: Buffer | string, privateKeyPem: string): string {
  const signature = crypto.sign(null, Buffer.from(data), privateKeyPem);
  return signature.toString('base64');
}

/**
 * Verify an Ed25519 signature against a public key (PEM format).
 */
export function verify(data: Buffer | string, signature: string, publicKeyPem: string): boolean {
  return crypto.verify(null, Buffer.from(data), publicKeyPem, Buffer.from(signature, 'base64'));
}

// ── Identity Manager ─────────────────────────────────────────────────

export class MachineIdentityManager {
  private instarDir: string;

  constructor(instarDir: string) {
    this.instarDir = instarDir;
  }

  /** The state dir this manager is rooted at (for co-located stores, e.g. pairing sessions). */
  get baseDir(): string {
    return this.instarDir;
  }

  // ── Paths ────────────────────────────────────────────────────────

  private get machineDir(): string {
    return path.join(this.instarDir, MACHINE_DIR);
  }

  private get machinesDir(): string {
    return path.join(this.instarDir, MACHINES_DIR);
  }

  get identityPath(): string {
    return path.join(this.machineDir, IDENTITY_FILE);
  }

  get signingKeyPath(): string {
    return path.join(this.machineDir, SIGNING_KEY_FILE);
  }

  get encryptionKeyPath(): string {
    return path.join(this.machineDir, ENCRYPTION_KEY_FILE);
  }

  get registryPath(): string {
    return path.join(this.machinesDir, REGISTRY_FILE);
  }

  // ── Identity Lifecycle ───────────────────────────────────────────

  /**
   * Check if this machine has an identity.
   */
  hasIdentity(): boolean {
    return fs.existsSync(this.identityPath);
  }

  /**
   * Generate and persist a new machine identity.
   * Creates key pairs, identity.json, and self-registers in the registry.
   *
   * @param options.name - Override auto-detected machine name
   * @param options.force - Overwrite existing identity
   * @param options.role - Initial role (default: 'awake' for first machine)
   */
  async generateIdentity(options?: {
    name?: string;
    force?: boolean;
    role?: MachineRole;
  }): Promise<MachineIdentity> {
    if (this.hasIdentity() && !options?.force) {
      throw new Error(ERRORS.IDENTITY_EXISTS);
    }

    // Ensure directories exist
    fs.mkdirSync(this.machineDir, { recursive: true });
    fs.mkdirSync(this.machinesDir, { recursive: true });

    // Generate keys
    const signing = generateSigningKeyPair();
    const encryption = generateEncryptionKeyPair();
    const machineId = generateMachineId();

    // Build identity
    const identity: MachineIdentity = {
      machineId,
      signingPublicKey: pemToBase64(signing.publicKey),
      encryptionPublicKey: pemToBase64(encryption.publicKey),
      name: options?.name ?? detectMachineName(),
      platform: detectPlatform(),
      createdAt: new Date().toISOString(),
      capabilities: detectCapabilities(),
    };

    // Write private keys with restricted permissions
    this.writeSecureFile(this.signingKeyPath, signing.privateKey);
    this.writeSecureFile(this.encryptionKeyPath, encryption.privateKey);

    // Write identity (public data — committed to git)
    fs.writeFileSync(this.identityPath, JSON.stringify(identity, null, 2));

    // Self-register in the machine registry
    const role = options?.role ?? 'awake';
    this.registerMachine(identity, role);

    return identity;
  }

  /**
   * Load this machine's identity from disk.
   */
  loadIdentity(): MachineIdentity {
    if (!this.hasIdentity()) {
      throw new Error(ERRORS.IDENTITY_NOT_FOUND);
    }
    return JSON.parse(fs.readFileSync(this.identityPath, 'utf-8'));
  }

  /**
   * Load this machine's Ed25519 signing private key (PEM format).
   */
  loadSigningKey(): string {
    try {
      return fs.readFileSync(this.signingKeyPath, 'utf-8');
    } catch (err) {
      // Legacy fallback: machine identities created before the canonical rename
      // wrote the signing key as 'signing-private.pem' (not 'signing-key.pem').
      // Without this, such an agent throws ENOENT here — which aborts the whole
      // lease-coordinator setup (found live 2026-05-31: the mini, keyed under the
      // legacy name, never attached its LeaseCoordinator → never resolved the
      // holder → MeshRpc rejected cross-machine transfer as not-router).
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        const legacy = path.join(this.machineDir, LEGACY_SIGNING_KEY_FILE);
        if (fs.existsSync(legacy)) return fs.readFileSync(legacy, 'utf-8');
      }
      throw err;
    }
  }

  /**
   * Load this machine's X25519 encryption private key (PEM format).
   */
  loadEncryptionKey(): string {
    try {
      return fs.readFileSync(this.encryptionKeyPath, 'utf-8');
    } catch (err) {
      // Same legacy fallback as loadSigningKey: identities created before the
      // canonical rename wrote the encryption key as 'encryption-private.pem'.
      // The mesh lease/transport setup loads this key too — found live
      // 2026-05-31: with the signing key resolved, the mini's transport setup
      // still threw ENOENT on the canonical 'encryption-key.pem', so the
      // legacy-keyed machine's transport couldn't fully initialize.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        const legacy = path.join(this.machineDir, LEGACY_ENCRYPTION_KEY_FILE);
        if (fs.existsSync(legacy)) return fs.readFileSync(legacy, 'utf-8');
      }
      throw err;
    }
  }

  // ── Registry Management ──────────────────────────────────────────

  /**
   * Load the machine registry. Returns empty registry if file doesn't exist.
   */
  loadRegistry(): MachineRegistry {
    if (!fs.existsSync(this.registryPath)) {
      return { version: REGISTRY_VERSION, machines: {} };
    }
    try {
      const data = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
      if (typeof data.version !== 'number' || typeof data.machines !== 'object') {
        throw new Error(ERRORS.REGISTRY_CORRUPT);
      }
      return data;
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error(ERRORS.REGISTRY_CORRUPT);
      }
      throw e;
    }
  }

  /**
   * Save the machine registry to disk.
   */
  saveRegistry(registry: MachineRegistry): void {
    fs.mkdirSync(this.machinesDir, { recursive: true });
    this.atomicWrite(this.registryPath, JSON.stringify(registry, null, 2));
  }

  /**
   * Ensure this machine has a registry entry, registering it with the given
   * role if missing. Safe to call on every startup — it's a no-op when the
   * machine is already present. Without this, a registry wiped by sync
   * corruption or a manual cleanup would brick the coordinator on boot,
   * since `updateRole` hard-throws on unknown machines.
   */
  ensureSelfRegistered(identity: MachineIdentity, role: MachineRole = 'standby'): boolean {
    const registry = this.loadRegistry();
    if (registry.machines[identity.machineId]) return false;

    console.warn(
      `[MachineIdentity] Machine ${identity.machineId} (${identity.name}) missing from registry — self-registering with role "${role}".`
    );
    this.registerMachine(identity, role);
    return true;
  }

  /**
   * Register a machine in the registry.
   */
  registerMachine(identity: MachineIdentity, role: MachineRole = 'standby'): void {
    const registry = this.loadRegistry();
    const now = new Date().toISOString();

    // Nickname (Session Pool §L2): keep an already-assigned nickname (idempotent
    // re-register), else auto-assign a friendly, collision-free one derived from
    // the machine's own properties. Collision set = every OTHER machine's nickname.
    const existing = registry.machines[identity.machineId];

    // Sticky revocation (2026-06-07 Mac Mini resurrection, topic 21816): a revoked
    // machine must NOT be silently brought back to 'active' by a re-register
    // (re-join / re-pair / post-update self-registration). The merge path already
    // keeps revocation sticky (mergeRegistry.mergeEntry); this is the OTHER door —
    // a direct re-register would clobber `status` to 'active' via the spread below.
    // Staying revoked across updates is the requirement; the only path back to
    // active is an explicit un-revoke. Refuse loudly and leave the entry untouched.
    if (existing && (existing.status === 'revoked' || existing.revokedAt)) {
      console.warn(
        `[MachineIdentity] Refusing to re-register revoked machine ${identity.machineId} `
        + `(${identity.name}) as active — it stays revoked across updates. Un-revoke explicitly to restore.`,
      );
      return;
    }
    const existingNicknames = Object.entries(registry.machines)
      .filter(([id]) => id !== identity.machineId)
      .map(([, e]) => e.nickname)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    const nickname =
      existing?.nickname ??
      assignNickname({ identityName: identity.name, platform: identity.platform, existingNicknames });

    registry.machines[identity.machineId] = {
      ...(existing ?? {}),
      name: identity.name,
      nickname,
      status: 'active',
      role,
      pairedAt: existing?.pairedAt ?? now,
      lastSeen: now,
    };

    this.saveRegistry(registry);
  }

  /**
   * Set a machine's user-facing nickname (Session Pool §L2). Validates the
   * format and pool-uniqueness (case-insensitive, excluding the machine itself);
   * a collision is REJECTED (not silently suffixed) so the caller sees the
   * conflict. Nickname is metadata only — renaming never moves a session or
   * changes lease/ownership state.
   *
   * @throws if the machine is unknown, the nickname is malformed, or it collides.
   */
  updateNickname(machineId: string, nickname: string): void {
    const trimmed = typeof nickname === 'string' ? nickname.trim() : '';
    if (!isValidNickname(trimmed)) {
      throw new Error(`Invalid nickname '${nickname}' — must be 1–40 chars of letters, digits, spaces, hyphens.`);
    }
    const registry = this.loadRegistry();
    const entry = registry.machines[machineId];
    if (!entry) throw new Error(ERRORS.MACHINE_NOT_FOUND(machineId));

    const lower = trimmed.toLowerCase();
    for (const [id, e] of Object.entries(registry.machines)) {
      if (id !== machineId && (e.nickname || '').trim().toLowerCase() === lower) {
        throw new Error(`Nickname '${trimmed}' is already used by machine ${id}.`);
      }
    }

    entry.nickname = trimmed;
    entry.lastSeen = new Date().toISOString();
    this.saveRegistry(registry);
  }

  /**
   * Resolve a user-typed nickname to a machineId (Session Pool §L4 placement /
   * transfer command resolution). Case-insensitive, trimmed, exact match over
   * ACTIVE machines. Returns null if unknown — the caller surfaces the valid
   * nicknames and refuses to mis-route (never a silent fallthrough).
   * Nicknames are pool-unique (updateNickname enforces it), so a match is unique.
   */
  resolveNickname(nickname: string): string | null {
    const target = (typeof nickname === 'string' ? nickname : '').trim().toLowerCase();
    if (!target) return null;
    const registry = this.loadRegistry();
    for (const [machineId, entry] of Object.entries(registry.machines)) {
      if (entry.status === 'active' && (entry.nickname || '').trim().toLowerCase() === target) {
        return machineId;
      }
    }
    return null;
  }

  /**
   * Record this machine's self-attested hardware properties into its OWN registry
   * entry (Session Pool §L2). The CALLER captures the hardware (e.g. via
   * MachinePoolRegistry.captureHardware()) and passes it, so this manager stays
   * free of `os`/registry-assembly concerns. Idempotent: only writes when the
   * hardware actually changed (avoids a registry churn/sync on every boot). The
   * entry must exist (the machine self-registers first). No-op for an unknown id.
   */
  recordSelfHardware(machineId: string, hardware: MachineHardware): boolean {
    const registry = this.loadRegistry();
    const entry = registry.machines[machineId];
    if (!entry) return false;
    if (JSON.stringify(entry.hardware ?? null) === JSON.stringify(hardware)) return false; // unchanged
    entry.hardware = hardware;
    entry.lastSeen = new Date().toISOString();
    this.saveRegistry(registry);
    return true;
  }

  /**
   * Update a machine's role in the registry.
   */
  updateRole(machineId: string, role: MachineRole): void {
    const registry = this.loadRegistry();
    const entry = registry.machines[machineId];
    if (!entry) throw new Error(ERRORS.MACHINE_NOT_FOUND(machineId));

    entry.role = role;
    entry.lastSeen = new Date().toISOString();
    this.saveRegistry(registry);
  }

  /**
   * Update a machine's lastSeen timestamp.
   */
  touchMachine(machineId: string): void {
    const registry = this.loadRegistry();
    const entry = registry.machines[machineId];
    if (!entry) throw new Error(ERRORS.MACHINE_NOT_FOUND(machineId));

    entry.lastSeen = new Date().toISOString();
    this.saveRegistry(registry);
  }

  /**
   * Update a machine's last known URL (tunnel URL for cross-machine relay).
   */
  updateMachineUrl(machineId: string, url: string): void {
    const registry = this.loadRegistry();
    const entry = registry.machines[machineId];
    if (!entry) throw new Error(ERRORS.MACHINE_NOT_FOUND(machineId));

    entry.lastKnownUrl = url;
    entry.lastSeen = new Date().toISOString();
    this.saveRegistry(registry);
  }

  /**
   * Get a machine's last known URL for cross-machine relay.
   * Returns null if not known.
   */
  getMachineUrl(machineId: string): string | null {
    const registry = this.loadRegistry();
    const entry = registry.machines[machineId];
    return entry?.lastKnownUrl ?? null;
  }

  /**
   * multi-transport-mesh-comms — write this machine's advertised endpoint set into
   * its registry entry. Rides the SAME authenticated registry-sync path as
   * lastKnownUrl (syncSequence + authoredUnderEpoch + per-author replay guards),
   * so a peer can only advertise endpoints under its own verified identity. The
   * accept-ack's responder-identity verification is the load-bearing defense: a
   * spoofed/bogus endpoint becomes a FAILED rope, never a trusted one.
   */
  updateMachineEndpoints(machineId: string, endpoints: import('./types.js').MeshEndpoint[]): void {
    const registry = this.loadRegistry();
    const entry = registry.machines[machineId];
    if (!entry) throw new Error(ERRORS.MACHINE_NOT_FOUND(machineId));
    entry.endpoints = endpoints;
    entry.lastSeen = new Date().toISOString();
    this.saveRegistry(registry);
  }

  /** multi-transport-mesh-comms — read a machine's advertised endpoint set (or undefined). */
  getMachineEndpoints(machineId: string): import('./types.js').MeshEndpoint[] | undefined {
    const registry = this.loadRegistry();
    return registry.machines[machineId]?.endpoints;
  }

  /**
   * routing-control-room-spend Increment C (FD-6 rung 2, pool half) — publish
   * this machine's created/adopted "💰 Routing & Spend Alerts" topic id as a
   * content-free field on its registry entry (rides the SAME replicated
   * registry-sync path as lastKnownUrl/endpoints).
   */
  updateRoutingSpendAlertTopic(machineId: string, topicId: number): void {
    const registry = this.loadRegistry();
    const entry = registry.machines[machineId];
    if (!entry) throw new Error(ERRORS.MACHINE_NOT_FOUND(machineId));
    entry.routingSpendAlertTopicId = topicId;
    entry.lastSeen = new Date().toISOString();
    this.saveRegistry(registry);
  }

  /**
   * Read the pool-published alerts-topic id from ANY (non-revoked) machine
   * entry — first hit wins; a new serving-lease holder INHERITS the id instead
   * of re-creating. Returns undefined when no machine has published one.
   */
  readAnyRoutingSpendAlertTopic(): number | undefined {
    const registry = this.loadRegistry();
    for (const entry of Object.values(registry.machines)) {
      if (entry.revokedAt) continue;
      const id = entry.routingSpendAlertTopicId;
      if (typeof id === 'number' && Number.isFinite(id)) return id;
    }
    return undefined;
  }

  /**
   * Revoke a machine. Marks it as revoked with reason.
   * Does NOT handle external secret rotation — caller must do that.
   */
  revokeMachine(machineId: string, revokedBy: string, reason: string): void {
    const registry = this.loadRegistry();
    const entry = registry.machines[machineId];
    if (!entry) throw new Error(ERRORS.MACHINE_NOT_FOUND(machineId));
    if (entry.status === 'revoked') throw new Error(ERRORS.MACHINE_ALREADY_REVOKED(entry.name));

    entry.status = 'revoked';
    entry.role = 'standby';
    entry.revokedAt = new Date().toISOString();
    entry.revokedBy = revokedBy;
    entry.revokeReason = reason;
    this.saveRegistry(registry);
  }

  /**
   * Remove this machine's identity and keys (for `instar leave`).
   */
  removeLocalIdentity(): void {
    for (const file of [this.identityPath, this.signingKeyPath, this.encryptionKeyPath]) {
      if (fs.existsSync(file)) {
        SafeFsExecutor.safeUnlinkSync(file, { operation: 'src/core/MachineIdentity.ts:389' });
      }
    }
  }

  /**
   * Get the currently awake machine from the registry.
   * Returns null if no machine is awake.
   */
  getAwakeMachine(): { machineId: string; entry: MachineRegistryEntry } | null {
    const registry = this.loadRegistry();
    for (const [machineId, entry] of Object.entries(registry.machines)) {
      if (entry.status === 'active' && entry.role === 'awake') {
        return { machineId, entry };
      }
    }
    return null;
  }

  /**
   * Get all active (non-revoked) machines.
   */
  getActiveMachines(): Array<{ machineId: string; entry: MachineRegistryEntry }> {
    const registry = this.loadRegistry();
    return Object.entries(registry.machines)
      .filter(([, entry]) => entry.status === 'active')
      .map(([machineId, entry]) => ({ machineId, entry }));
  }

  /**
   * Check if a machine is active (not revoked).
   */
  isMachineActive(machineId: string): boolean {
    const registry = this.loadRegistry();
    const entry = registry.machines[machineId];
    return (entry?.status === 'active') || false;
  }

  // ── Remote Machine Identity ─────────────────────────────────────

  /**
   * Store a remote machine's public identity (received during pairing).
   * This lets us verify their signatures and encrypt data for them.
   */
  storeRemoteIdentity(identity: MachineIdentity): void {
    const dir = path.join(this.machinesDir, identity.machineId);
    fs.mkdirSync(dir, { recursive: true });
    this.atomicWrite(
      path.join(dir, IDENTITY_FILE),
      JSON.stringify(identity, null, 2),
    );
  }

  /**
   * Load a remote machine's public identity.
   * Returns null if not found.
   */
  loadRemoteIdentity(machineId: string): MachineIdentity | null {
    const filePath = path.join(this.machinesDir, machineId, IDENTITY_FILE);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      // @silent-fallback-ok — remote identity returns null
      return null;
    }
  }

  /**
   * Get a machine's Ed25519 signing public key in PEM format.
   * Works for both local and remote machines.
   */
  getSigningPublicKeyPem(machineId: string): string | null {
    // Check local identity first
    if (this.hasIdentity()) {
      const local = this.loadIdentity();
      if (local.machineId === machineId) {
        return base64ToSigningPem(local.signingPublicKey);
      }
    }

    // Check remote identity
    const remote = this.loadRemoteIdentity(machineId);
    if (!remote) return null;
    return base64ToSigningPem(remote.signingPublicKey);
  }

  /**
   * Get a machine's X25519 encryption public key in PEM format.
   * Works for both local and remote machines.
   */
  getEncryptionPublicKeyPem(machineId: string): string | null {
    // Check local identity first
    if (this.hasIdentity()) {
      const local = this.loadIdentity();
      if (local.machineId === machineId) {
        return base64ToEncryptionPem(local.encryptionPublicKey);
      }
    }

    // Check remote identity
    const remote = this.loadRemoteIdentity(machineId);
    if (!remote) return null;
    return base64ToEncryptionPem(remote.encryptionPublicKey);
  }

  // ── Helpers ──────────────────────────────────────────────────────

  /**
   * Write a file with restricted permissions (0600).
   */
  private writeSecureFile(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    // Write to temp file then rename (atomic)
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, content, { mode: KEY_FILE_MODE });
    fs.renameSync(tmpPath, filePath);
  }

  /**
   * Atomic write: write to temp file then rename.
   */
  private atomicWrite(filePath: string, content: string): void {
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filePath);
  }
}

// ── Gitignore Management ─────────────────────────────────────────────

const GITIGNORE_ENTRIES = [
  '# Machine secrets (NEVER commit)',
  '.instar/machine/signing-key.pem',
  '.instar/machine/encryption-key.pem',
  '.instar/secrets/',
  '.instar/pairing/',
  '# Sandbox-safe worktrees (per-machine; multi-GB foreign-repo contents)',
  '.worktrees/',
  '# Judgment-call provenance rows (machine-local decision context — never commit)',
  'state/judgment-provenance/',
];

// ── PEM Reconstruction ──────────────────────────────────────────────

/**
 * Reconstruct Ed25519 SPKI PEM from base64-encoded key data.
 */
export function base64ToSigningPem(base64Key: string): string {
  const lines = base64Key.match(/.{1,64}/g) || [base64Key];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

/**
 * Reconstruct X25519 SPKI PEM from base64-encoded key data.
 */
export function base64ToEncryptionPem(base64Key: string): string {
  const lines = base64Key.match(/.{1,64}/g) || [base64Key];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

/**
 * Ensure the .gitignore file contains the required entries for multi-machine.
 * Appends missing entries without duplicating existing ones.
 */
export function ensureGitignore(projectDir: string): void {
  const gitignorePath = path.join(projectDir, '.gitignore');
  let content = '';

  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, 'utf-8');
  }

  const linesToAdd = GITIGNORE_ENTRIES.filter(line => {
    // Don't add comments if the actual entry already exists
    if (line.startsWith('#')) return !content.includes(line);
    return !content.includes(line);
  });

  if (linesToAdd.length > 0) {
    const append = (content.endsWith('\n') ? '' : '\n') + '\n' + linesToAdd.join('\n') + '\n';
    fs.writeFileSync(gitignorePath, content + append);
  }
}
