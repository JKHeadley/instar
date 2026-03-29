/**
 * ManifestIntegrity — HMAC-SHA256 signing and verification for capability-manifest.json.
 *
 * Uses a machine-local secret stored in .instar/state/.manifest-key (generated once at
 * `instar init`, never transmitted, added to .gitignore).
 *
 * On every write: compute HMAC over all entries, store as `_hmac` field.
 * On every read: verify HMAC before trusting data.
 * On verification failure: log warning, trigger alert, fall back to rescan.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
const KEY_FILENAME = '.manifest-key';
const KEY_LENGTH = 32; // 256-bit key
export class ManifestIntegrity {
    stateDir;
    keyPath;
    constructor(stateDir) {
        this.stateDir = stateDir;
        this.keyPath = path.join(stateDir, KEY_FILENAME);
    }
    /**
     * Generate a new signing key if one doesn't exist.
     * Called during `instar init`.
     * Returns true if a new key was generated, false if one already existed.
     */
    ensureKey() {
        if (fs.existsSync(this.keyPath)) {
            return false;
        }
        const key = crypto.randomBytes(KEY_LENGTH).toString('hex');
        fs.mkdirSync(path.dirname(this.keyPath), { recursive: true });
        fs.writeFileSync(this.keyPath, key, { mode: 0o600 });
        return true;
    }
    /**
     * Read the signing key. Returns null if no key exists.
     */
    getKey() {
        if (!fs.existsSync(this.keyPath)) {
            return null;
        }
        return fs.readFileSync(this.keyPath, 'utf-8').trim();
    }
    /**
     * Deterministic JSON serialization with sorted keys at all levels.
     */
    static sortedStringify(obj) {
        if (obj === null || typeof obj !== 'object') {
            return JSON.stringify(obj);
        }
        if (Array.isArray(obj)) {
            return '[' + obj.map(item => ManifestIntegrity.sortedStringify(item)).join(',') + ']';
        }
        const sortedKeys = Object.keys(obj).sort();
        const pairs = sortedKeys.map(key => JSON.stringify(key) + ':' + ManifestIntegrity.sortedStringify(obj[key]));
        return '{' + pairs.join(',') + '}';
    }
    /**
     * Compute HMAC-SHA256 over the manifest entries (excluding the _hmac field itself).
     */
    computeHmac(manifest) {
        const key = this.getKey();
        if (!key) {
            throw new Error('No manifest signing key found. Run `instar init` to generate one.');
        }
        // Create a deterministic serialization of everything except _hmac
        const { _hmac, ...rest } = manifest;
        const payload = ManifestIntegrity.sortedStringify(rest);
        return crypto.createHmac('sha256', key).update(payload).digest('hex');
    }
    /**
     * Sign a manifest object. Adds `_hmac` field in-place and returns it.
     */
    sign(manifest) {
        const hmac = this.computeHmac(manifest);
        return { ...manifest, _hmac: hmac };
    }
    /**
     * Verify a signed manifest. Returns true if the HMAC matches.
     */
    verify(manifest) {
        const key = this.getKey();
        if (!key) {
            // No key = can't verify. This happens on first run before init.
            return true;
        }
        const storedHmac = manifest._hmac;
        if (!storedHmac || typeof storedHmac !== 'string') {
            // No HMAC present = unsigned manifest (pre-upgrade or first creation)
            return false;
        }
        const computed = this.computeHmac(manifest);
        // Constant-time comparison to prevent timing attacks
        return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(storedHmac, 'hex'));
    }
    /**
     * Read and verify a manifest file. Returns the parsed manifest and verification status.
     */
    readAndVerify(manifestPath) {
        if (!fs.existsSync(manifestPath)) {
            return { manifest: null, verified: false, error: 'File not found' };
        }
        try {
            const content = fs.readFileSync(manifestPath, 'utf-8');
            const manifest = JSON.parse(content);
            const verified = this.verify(manifest);
            return { manifest, verified };
        }
        catch (err) {
            return {
                manifest: null,
                verified: false,
                error: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }
    /**
     * Write a signed manifest to disk. Signs before writing.
     */
    writeAndSign(manifestPath, manifest) {
        const signed = this.sign(manifest);
        fs.writeFileSync(manifestPath, JSON.stringify(signed, null, 2));
    }
    /**
     * Check if a signing key exists.
     */
    hasKey() {
        return fs.existsSync(this.keyPath);
    }
    /**
     * Rotate the signing key. Generates a new key, re-signs the manifest file if it exists.
     * Returns the path to the old key backup.
     */
    rotateKey(manifestPath) {
        const oldKey = this.getKey();
        const backupPath = oldKey ? `${this.keyPath}.bak.${Date.now()}` : null;
        if (oldKey && backupPath) {
            fs.writeFileSync(backupPath, oldKey, { mode: 0o600 });
        }
        // Generate new key
        const newKey = crypto.randomBytes(KEY_LENGTH).toString('hex');
        fs.writeFileSync(this.keyPath, newKey, { mode: 0o600 });
        // Re-sign the manifest if it exists
        if (manifestPath && fs.existsSync(manifestPath)) {
            try {
                const content = fs.readFileSync(manifestPath, 'utf-8');
                const manifest = JSON.parse(content);
                this.writeAndSign(manifestPath, manifest);
            }
            catch {
                // If re-signing fails, the manifest will fail verification and trigger rescan
            }
        }
        return backupPath;
    }
}
//# sourceMappingURL=ManifestIntegrity.js.map