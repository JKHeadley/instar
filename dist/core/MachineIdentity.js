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
// ── Constants ────────────────────────────────────────────────────────
const MACHINE_DIR = 'machine';
const MACHINES_DIR = 'machines';
const IDENTITY_FILE = 'identity.json';
const SIGNING_KEY_FILE = 'signing-key.pem';
const ENCRYPTION_KEY_FILE = 'encryption-key.pem';
const REGISTRY_FILE = 'registry.json';
const KEY_FILE_MODE = 0o600;
const REGISTRY_VERSION = 1;
// ── Error Messages (human-readable) ──────────────────────────────────
const ERRORS = {
    KEYGEN_FAILED: (detail) => `Could not set up security for this machine. ${detail}\nTry: sudo chown -R $(whoami) .instar/machine/`,
    IDENTITY_EXISTS: 'This machine already has an identity. Use --force to regenerate (this will require re-pairing).',
    IDENTITY_NOT_FOUND: 'No machine identity found. Run `instar init` or `instar join` first.',
    REGISTRY_CORRUPT: 'Machine registry is corrupted. Run `instar doctor` for diagnosis.',
    MACHINE_NOT_FOUND: (id) => `Machine ${id} not found in registry.`,
    MACHINE_ALREADY_REVOKED: (name) => `Machine "${name}" is already revoked.`,
};
// ── Key Generation ───────────────────────────────────────────────────
/**
 * Generate an Ed25519 key pair for signing.
 * Returns { publicKey, privateKey } in PEM format.
 */
export function generateSigningKeyPair() {
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
export function generateEncryptionKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return { publicKey, privateKey };
}
/**
 * Generate a 128-bit machine ID: "m_" + 32 random hex chars.
 */
export function generateMachineId() {
    return `m_${crypto.randomBytes(16).toString('hex')}`;
}
/**
 * Detect a human-friendly name for this machine.
 * Uses hostname, falling back to a random name.
 */
export function detectMachineName() {
    const hostname = os.hostname();
    // Clean up hostname: remove .local suffix, lowercase
    const name = hostname.replace(/\.local$/i, '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    return name || `machine-${crypto.randomBytes(4).toString('hex')}`;
}
/**
 * Detect the platform string (e.g., "darwin-arm64", "linux-x64").
 */
export function detectPlatform() {
    return `${process.platform}-${process.arch}`;
}
/**
 * Detect available capabilities for this machine.
 */
export function detectCapabilities() {
    // All machines start with these. Tunnel/telegram presence
    // is determined by config, checked at runtime.
    return ['sessions', 'jobs', 'telegram', 'tunnel'];
}
// ── PEM Encoding Helpers ─────────────────────────────────────────────
/**
 * Extract the base64-encoded key data from a PEM string.
 */
export function pemToBase64(pem) {
    return pem
        .replace(/-----BEGIN [A-Z ]+-----/g, '')
        .replace(/-----END [A-Z ]+-----/g, '')
        .replace(/\s/g, '');
}
/**
 * Sign data with an Ed25519 private key (PEM format).
 * Returns the signature as a base64 string.
 */
export function sign(data, privateKeyPem) {
    const signature = crypto.sign(null, Buffer.from(data), privateKeyPem);
    return signature.toString('base64');
}
/**
 * Verify an Ed25519 signature against a public key (PEM format).
 */
export function verify(data, signature, publicKeyPem) {
    return crypto.verify(null, Buffer.from(data), publicKeyPem, Buffer.from(signature, 'base64'));
}
// ── Identity Manager ─────────────────────────────────────────────────
export class MachineIdentityManager {
    instarDir;
    constructor(instarDir) {
        this.instarDir = instarDir;
    }
    // ── Paths ────────────────────────────────────────────────────────
    get machineDir() {
        return path.join(this.instarDir, MACHINE_DIR);
    }
    get machinesDir() {
        return path.join(this.instarDir, MACHINES_DIR);
    }
    get identityPath() {
        return path.join(this.machineDir, IDENTITY_FILE);
    }
    get signingKeyPath() {
        return path.join(this.machineDir, SIGNING_KEY_FILE);
    }
    get encryptionKeyPath() {
        return path.join(this.machineDir, ENCRYPTION_KEY_FILE);
    }
    get registryPath() {
        return path.join(this.machinesDir, REGISTRY_FILE);
    }
    // ── Identity Lifecycle ───────────────────────────────────────────
    /**
     * Check if this machine has an identity.
     */
    hasIdentity() {
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
    async generateIdentity(options) {
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
        const identity = {
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
    loadIdentity() {
        if (!this.hasIdentity()) {
            throw new Error(ERRORS.IDENTITY_NOT_FOUND);
        }
        return JSON.parse(fs.readFileSync(this.identityPath, 'utf-8'));
    }
    /**
     * Load this machine's Ed25519 signing private key (PEM format).
     */
    loadSigningKey() {
        return fs.readFileSync(this.signingKeyPath, 'utf-8');
    }
    /**
     * Load this machine's X25519 encryption private key (PEM format).
     */
    loadEncryptionKey() {
        return fs.readFileSync(this.encryptionKeyPath, 'utf-8');
    }
    // ── Registry Management ──────────────────────────────────────────
    /**
     * Load the machine registry. Returns empty registry if file doesn't exist.
     */
    loadRegistry() {
        if (!fs.existsSync(this.registryPath)) {
            return { version: REGISTRY_VERSION, machines: {} };
        }
        try {
            const data = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
            if (typeof data.version !== 'number' || typeof data.machines !== 'object') {
                throw new Error(ERRORS.REGISTRY_CORRUPT);
            }
            return data;
        }
        catch (e) {
            if (e instanceof SyntaxError) {
                throw new Error(ERRORS.REGISTRY_CORRUPT);
            }
            throw e;
        }
    }
    /**
     * Save the machine registry to disk.
     */
    saveRegistry(registry) {
        fs.mkdirSync(this.machinesDir, { recursive: true });
        this.atomicWrite(this.registryPath, JSON.stringify(registry, null, 2));
    }
    /**
     * Register a machine in the registry.
     */
    registerMachine(identity, role = 'standby') {
        const registry = this.loadRegistry();
        const now = new Date().toISOString();
        registry.machines[identity.machineId] = {
            name: identity.name,
            status: 'active',
            role,
            pairedAt: now,
            lastSeen: now,
        };
        this.saveRegistry(registry);
    }
    /**
     * Update a machine's role in the registry.
     */
    updateRole(machineId, role) {
        const registry = this.loadRegistry();
        const entry = registry.machines[machineId];
        if (!entry)
            throw new Error(ERRORS.MACHINE_NOT_FOUND(machineId));
        entry.role = role;
        entry.lastSeen = new Date().toISOString();
        this.saveRegistry(registry);
    }
    /**
     * Update a machine's lastSeen timestamp.
     */
    touchMachine(machineId) {
        const registry = this.loadRegistry();
        const entry = registry.machines[machineId];
        if (!entry)
            throw new Error(ERRORS.MACHINE_NOT_FOUND(machineId));
        entry.lastSeen = new Date().toISOString();
        this.saveRegistry(registry);
    }
    /**
     * Update a machine's last known URL (tunnel URL for cross-machine relay).
     */
    updateMachineUrl(machineId, url) {
        const registry = this.loadRegistry();
        const entry = registry.machines[machineId];
        if (!entry)
            throw new Error(ERRORS.MACHINE_NOT_FOUND(machineId));
        entry.lastKnownUrl = url;
        entry.lastSeen = new Date().toISOString();
        this.saveRegistry(registry);
    }
    /**
     * Get a machine's last known URL for cross-machine relay.
     * Returns null if not known.
     */
    getMachineUrl(machineId) {
        const registry = this.loadRegistry();
        const entry = registry.machines[machineId];
        return entry?.lastKnownUrl ?? null;
    }
    /**
     * Revoke a machine. Marks it as revoked with reason.
     * Does NOT handle external secret rotation — caller must do that.
     */
    revokeMachine(machineId, revokedBy, reason) {
        const registry = this.loadRegistry();
        const entry = registry.machines[machineId];
        if (!entry)
            throw new Error(ERRORS.MACHINE_NOT_FOUND(machineId));
        if (entry.status === 'revoked')
            throw new Error(ERRORS.MACHINE_ALREADY_REVOKED(entry.name));
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
    removeLocalIdentity() {
        for (const file of [this.identityPath, this.signingKeyPath, this.encryptionKeyPath]) {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        }
    }
    /**
     * Get the currently awake machine from the registry.
     * Returns null if no machine is awake.
     */
    getAwakeMachine() {
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
    getActiveMachines() {
        const registry = this.loadRegistry();
        return Object.entries(registry.machines)
            .filter(([, entry]) => entry.status === 'active')
            .map(([machineId, entry]) => ({ machineId, entry }));
    }
    /**
     * Check if a machine is active (not revoked).
     */
    isMachineActive(machineId) {
        const registry = this.loadRegistry();
        const entry = registry.machines[machineId];
        return (entry?.status === 'active') || false;
    }
    // ── Remote Machine Identity ─────────────────────────────────────
    /**
     * Store a remote machine's public identity (received during pairing).
     * This lets us verify their signatures and encrypt data for them.
     */
    storeRemoteIdentity(identity) {
        const dir = path.join(this.machinesDir, identity.machineId);
        fs.mkdirSync(dir, { recursive: true });
        this.atomicWrite(path.join(dir, IDENTITY_FILE), JSON.stringify(identity, null, 2));
    }
    /**
     * Load a remote machine's public identity.
     * Returns null if not found.
     */
    loadRemoteIdentity(machineId) {
        const filePath = path.join(this.machinesDir, machineId, IDENTITY_FILE);
        if (!fs.existsSync(filePath))
            return null;
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        }
        catch {
            // @silent-fallback-ok — remote identity returns null
            return null;
        }
    }
    /**
     * Get a machine's Ed25519 signing public key in PEM format.
     * Works for both local and remote machines.
     */
    getSigningPublicKeyPem(machineId) {
        // Check local identity first
        if (this.hasIdentity()) {
            const local = this.loadIdentity();
            if (local.machineId === machineId) {
                return base64ToSigningPem(local.signingPublicKey);
            }
        }
        // Check remote identity
        const remote = this.loadRemoteIdentity(machineId);
        if (!remote)
            return null;
        return base64ToSigningPem(remote.signingPublicKey);
    }
    /**
     * Get a machine's X25519 encryption public key in PEM format.
     * Works for both local and remote machines.
     */
    getEncryptionPublicKeyPem(machineId) {
        // Check local identity first
        if (this.hasIdentity()) {
            const local = this.loadIdentity();
            if (local.machineId === machineId) {
                return base64ToEncryptionPem(local.encryptionPublicKey);
            }
        }
        // Check remote identity
        const remote = this.loadRemoteIdentity(machineId);
        if (!remote)
            return null;
        return base64ToEncryptionPem(remote.encryptionPublicKey);
    }
    // ── Helpers ──────────────────────────────────────────────────────
    /**
     * Write a file with restricted permissions (0600).
     */
    writeSecureFile(filePath, content) {
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
    atomicWrite(filePath, content) {
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
];
// ── PEM Reconstruction ──────────────────────────────────────────────
/**
 * Reconstruct Ed25519 SPKI PEM from base64-encoded key data.
 */
export function base64ToSigningPem(base64Key) {
    const lines = base64Key.match(/.{1,64}/g) || [base64Key];
    return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
}
/**
 * Reconstruct X25519 SPKI PEM from base64-encoded key data.
 */
export function base64ToEncryptionPem(base64Key) {
    const lines = base64Key.match(/.{1,64}/g) || [base64Key];
    return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
}
/**
 * Ensure the .gitignore file contains the required entries for multi-machine.
 * Appends missing entries without duplicating existing ones.
 */
export function ensureGitignore(projectDir) {
    const gitignorePath = path.join(projectDir, '.gitignore');
    let content = '';
    if (fs.existsSync(gitignorePath)) {
        content = fs.readFileSync(gitignorePath, 'utf-8');
    }
    const linesToAdd = GITIGNORE_ENTRIES.filter(line => {
        // Don't add comments if the actual entry already exists
        if (line.startsWith('#'))
            return !content.includes(line);
        return !content.includes(line);
    });
    if (linesToAdd.length > 0) {
        const append = (content.endsWith('\n') ? '' : '\n') + '\n' + linesToAdd.join('\n') + '\n';
        fs.writeFileSync(gitignorePath, content + append);
    }
}
//# sourceMappingURL=MachineIdentity.js.map