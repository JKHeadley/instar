/**
 * IdentityManager — Manages Ed25519 identity keys for relay agents.
 *
 * Generates, stores, and loads identity keypairs from disk.
 * Part of Threadline Relay Phase 1.
 */
import type { AgentFingerprint } from '../relay/types.js';
export interface IdentityInfo {
    fingerprint: AgentFingerprint;
    publicKey: Buffer;
    privateKey: Buffer;
    x25519PublicKey: Buffer;
    createdAt: string;
}
export declare class IdentityManager {
    private readonly stateDir;
    private readonly keyFile;
    private identity;
    constructor(stateDir: string);
    /**
     * Get or create the agent's identity.
     * Generates a new keypair on first use, loads from disk on subsequent uses.
     */
    getOrCreate(): IdentityInfo;
    /**
     * Get the current identity without creating a new one.
     */
    get(): IdentityInfo | null;
    /**
     * Check if an identity exists.
     */
    exists(): boolean;
    /**
     * Get the directory where keys are stored.
     */
    get keyDir(): string;
    private loadFromDisk;
    private saveToDisk;
}
//# sourceMappingURL=IdentityManager.d.ts.map