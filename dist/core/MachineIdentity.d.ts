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
import type { MachineIdentity, MachineRegistry, MachineRegistryEntry, MachineRole, MachineCapability } from './types.js';
/**
 * Generate an Ed25519 key pair for signing.
 * Returns { publicKey, privateKey } in PEM format.
 */
export declare function generateSigningKeyPair(): {
    publicKey: string;
    privateKey: string;
};
/**
 * Generate an X25519 key pair for encryption (ECDH key agreement).
 * Returns { publicKey, privateKey } in PEM format.
 */
export declare function generateEncryptionKeyPair(): {
    publicKey: string;
    privateKey: string;
};
/**
 * Generate a 128-bit machine ID: "m_" + 32 random hex chars.
 */
export declare function generateMachineId(): string;
/**
 * Detect a human-friendly name for this machine.
 * Uses hostname, falling back to a random name.
 */
export declare function detectMachineName(): string;
/**
 * Detect the platform string (e.g., "darwin-arm64", "linux-x64").
 */
export declare function detectPlatform(): string;
/**
 * Detect available capabilities for this machine.
 */
export declare function detectCapabilities(): MachineCapability[];
/**
 * Extract the base64-encoded key data from a PEM string.
 */
export declare function pemToBase64(pem: string): string;
/**
 * Sign data with an Ed25519 private key (PEM format).
 * Returns the signature as a base64 string.
 */
export declare function sign(data: Buffer | string, privateKeyPem: string): string;
/**
 * Verify an Ed25519 signature against a public key (PEM format).
 */
export declare function verify(data: Buffer | string, signature: string, publicKeyPem: string): boolean;
export declare class MachineIdentityManager {
    private instarDir;
    constructor(instarDir: string);
    private get machineDir();
    private get machinesDir();
    get identityPath(): string;
    get signingKeyPath(): string;
    get encryptionKeyPath(): string;
    get registryPath(): string;
    /**
     * Check if this machine has an identity.
     */
    hasIdentity(): boolean;
    /**
     * Generate and persist a new machine identity.
     * Creates key pairs, identity.json, and self-registers in the registry.
     *
     * @param options.name - Override auto-detected machine name
     * @param options.force - Overwrite existing identity
     * @param options.role - Initial role (default: 'awake' for first machine)
     */
    generateIdentity(options?: {
        name?: string;
        force?: boolean;
        role?: MachineRole;
    }): Promise<MachineIdentity>;
    /**
     * Load this machine's identity from disk.
     */
    loadIdentity(): MachineIdentity;
    /**
     * Load this machine's Ed25519 signing private key (PEM format).
     */
    loadSigningKey(): string;
    /**
     * Load this machine's X25519 encryption private key (PEM format).
     */
    loadEncryptionKey(): string;
    /**
     * Load the machine registry. Returns empty registry if file doesn't exist.
     */
    loadRegistry(): MachineRegistry;
    /**
     * Save the machine registry to disk.
     */
    saveRegistry(registry: MachineRegistry): void;
    /**
     * Register a machine in the registry.
     */
    registerMachine(identity: MachineIdentity, role?: MachineRole): void;
    /**
     * Update a machine's role in the registry.
     */
    updateRole(machineId: string, role: MachineRole): void;
    /**
     * Update a machine's lastSeen timestamp.
     */
    touchMachine(machineId: string): void;
    /**
     * Update a machine's last known URL (tunnel URL for cross-machine relay).
     */
    updateMachineUrl(machineId: string, url: string): void;
    /**
     * Get a machine's last known URL for cross-machine relay.
     * Returns null if not known.
     */
    getMachineUrl(machineId: string): string | null;
    /**
     * Revoke a machine. Marks it as revoked with reason.
     * Does NOT handle external secret rotation — caller must do that.
     */
    revokeMachine(machineId: string, revokedBy: string, reason: string): void;
    /**
     * Remove this machine's identity and keys (for `instar leave`).
     */
    removeLocalIdentity(): void;
    /**
     * Get the currently awake machine from the registry.
     * Returns null if no machine is awake.
     */
    getAwakeMachine(): {
        machineId: string;
        entry: MachineRegistryEntry;
    } | null;
    /**
     * Get all active (non-revoked) machines.
     */
    getActiveMachines(): Array<{
        machineId: string;
        entry: MachineRegistryEntry;
    }>;
    /**
     * Check if a machine is active (not revoked).
     */
    isMachineActive(machineId: string): boolean;
    /**
     * Store a remote machine's public identity (received during pairing).
     * This lets us verify their signatures and encrypt data for them.
     */
    storeRemoteIdentity(identity: MachineIdentity): void;
    /**
     * Load a remote machine's public identity.
     * Returns null if not found.
     */
    loadRemoteIdentity(machineId: string): MachineIdentity | null;
    /**
     * Get a machine's Ed25519 signing public key in PEM format.
     * Works for both local and remote machines.
     */
    getSigningPublicKeyPem(machineId: string): string | null;
    /**
     * Get a machine's X25519 encryption public key in PEM format.
     * Works for both local and remote machines.
     */
    getEncryptionPublicKeyPem(machineId: string): string | null;
    /**
     * Write a file with restricted permissions (0600).
     */
    private writeSecureFile;
    /**
     * Atomic write: write to temp file then rename.
     */
    private atomicWrite;
}
/**
 * Reconstruct Ed25519 SPKI PEM from base64-encoded key data.
 */
export declare function base64ToSigningPem(base64Key: string): string;
/**
 * Reconstruct X25519 SPKI PEM from base64-encoded key data.
 */
export declare function base64ToEncryptionPem(base64Key: string): string;
/**
 * Ensure the .gitignore file contains the required entries for multi-machine.
 * Appends missing entries without duplicating existing ones.
 */
export declare function ensureGitignore(projectDir: string): void;
//# sourceMappingURL=MachineIdentity.d.ts.map