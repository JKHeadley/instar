/**
 * IdentityManager — Manages Ed25519 identity keys for relay agents.
 *
 * Generates, stores, and loads identity keypairs from disk.
 * Part of Threadline Relay Phase 1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { generateIdentityKeyPair } from '../ThreadlineCrypto.js';
import { computeFingerprint, deriveX25519PublicKey } from './MessageEncryptor.js';
export class IdentityManager {
    stateDir;
    keyFile;
    identity = null;
    constructor(stateDir) {
        this.stateDir = stateDir;
        this.keyFile = path.join(stateDir, 'threadline', 'identity.json');
    }
    /**
     * Get or create the agent's identity.
     * Generates a new keypair on first use, loads from disk on subsequent uses.
     */
    getOrCreate() {
        if (this.identity)
            return this.identity;
        // Try loading from disk
        const loaded = this.loadFromDisk();
        if (loaded) {
            this.identity = loaded;
            return loaded;
        }
        // Generate new identity
        const keypair = generateIdentityKeyPair();
        const identity = {
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
    get() {
        if (this.identity)
            return this.identity;
        const loaded = this.loadFromDisk();
        if (loaded) {
            this.identity = loaded;
        }
        return this.identity;
    }
    /**
     * Check if an identity exists.
     */
    exists() {
        return this.identity !== null || fs.existsSync(this.keyFile);
    }
    /**
     * Get the directory where keys are stored.
     */
    get keyDir() {
        return path.dirname(this.keyFile);
    }
    // ── Private ─────────────────────────────────────────────────────
    loadFromDisk() {
        try {
            if (!fs.existsSync(this.keyFile))
                return null;
            const raw = JSON.parse(fs.readFileSync(this.keyFile, 'utf-8'));
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
        }
        catch {
            return null;
        }
    }
    saveToDisk(identity) {
        const dir = path.dirname(this.keyFile);
        fs.mkdirSync(dir, { recursive: true });
        const data = JSON.stringify({
            fingerprint: identity.fingerprint,
            publicKey: identity.publicKey.toString('base64'),
            privateKey: identity.privateKey.toString('base64'),
            x25519PublicKey: identity.x25519PublicKey.toString('base64'),
            createdAt: identity.createdAt,
        }, null, 2);
        // Atomic write
        const tmpPath = `${this.keyFile}.${process.pid}.tmp`;
        fs.writeFileSync(tmpPath, data, { mode: 0o600 });
        fs.renameSync(tmpPath, this.keyFile);
    }
}
//# sourceMappingURL=IdentityManager.js.map