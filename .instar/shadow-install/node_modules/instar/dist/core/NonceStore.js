/**
 * Nonce store for replay prevention.
 *
 * Triple-layer anti-replay:
 * 1. Timestamp: 30-second window
 * 2. Nonce: unique per request, persisted to disk
 * 3. Sequence number: monotonic per peer
 *
 * Nonces are pruned continuously (every 5 minutes) and on startup.
 *
 * Part of Phase 4 (secret sync infrastructure).
 */
import fs from 'node:fs';
import path from 'node:path';
// ── Constants (defaults) ─────────────────────────────────────────────
const NONCE_FILE = 'nonces.jsonl';
const DEFAULT_NONCE_MAX_AGE_MS = 60_000; // 60 seconds
const DEFAULT_TIMESTAMP_WINDOW_MS = 30_000; // 30-second window
const DEFAULT_PRUNE_INTERVAL_MS = 5 * 60_000; // 5 minutes
// ── NonceStore ───────────────────────────────────────────────────────
export class NonceStore {
    stateDir;
    nonces = new Set();
    sequences = {};
    pruneTimer = null;
    initialized = false;
    timestampWindowMs;
    nonceMaxAgeMs;
    pruneIntervalMs;
    constructor(stateDir, config) {
        this.stateDir = stateDir;
        this.timestampWindowMs = config?.timestampWindowMs ?? DEFAULT_TIMESTAMP_WINDOW_MS;
        this.nonceMaxAgeMs = config?.nonceMaxAgeMs ?? DEFAULT_NONCE_MAX_AGE_MS;
        this.pruneIntervalMs = config?.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    }
    /**
     * Initialize: load persisted nonces and prune old ones.
     * Must be called before use. Idempotent.
     */
    initialize() {
        if (this.initialized)
            return;
        fs.mkdirSync(this.stateDir, { recursive: true });
        this.loadFromDisk();
        this.prune();
        // Start continuous pruning
        this.pruneTimer = setInterval(() => this.prune(), this.pruneIntervalMs);
        if (this.pruneTimer.unref)
            this.pruneTimer.unref(); // Don't keep process alive
        this.initialized = true;
    }
    /**
     * Stop the prune timer. Call on shutdown.
     */
    destroy() {
        if (this.pruneTimer) {
            clearInterval(this.pruneTimer);
            this.pruneTimer = null;
        }
    }
    /**
     * Validate a request's anti-replay fields.
     * Returns { valid: true } or { valid: false, reason }.
     *
     * @param timestamp - ISO string or epoch ms
     * @param nonce - Unique nonce for this request
     * @param sequence - Monotonic sequence number
     * @param peerId - The sending machine's ID
     */
    validate(timestamp, nonce, sequence, peerId) {
        this.initialize();
        // 1. Timestamp window
        const ts = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp;
        const age = Math.abs(Date.now() - ts);
        if (age > this.timestampWindowMs) {
            return { valid: false, reason: `Timestamp outside ${this.timestampWindowMs / 1000}s window (age: ${Math.round(age / 1000)}s)` };
        }
        // 2. Nonce uniqueness
        if (this.nonces.has(nonce)) {
            return { valid: false, reason: 'Nonce already seen (replay detected)' };
        }
        // 3. Sequence number (monotonic per peer)
        const lastSeq = this.sequences[peerId] ?? -1;
        if (sequence <= lastSeq) {
            return { valid: false, reason: `Sequence ${sequence} <= last seen ${lastSeq} from ${peerId}` };
        }
        // All checks passed — record the nonce and sequence
        this.nonces.add(nonce);
        this.sequences[peerId] = sequence;
        this.persistNonce(nonce);
        return { valid: true };
    }
    /**
     * Get the next sequence number to use when sending to a peer.
     * Returns the last seen + 1, or 0 if never communicated.
     */
    getNextSequence(peerId) {
        this.initialize();
        return (this.sequences[peerId] ?? -1) + 1;
    }
    /**
     * Get the current nonce count (for diagnostics).
     */
    get size() {
        return this.nonces.size;
    }
    /**
     * Prune expired nonces from memory and rewrite the file.
     */
    prune() {
        const cutoff = Date.now() - this.nonceMaxAgeMs;
        const filePath = this.noncePath;
        if (!fs.existsSync(filePath))
            return;
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        if (!content)
            return;
        const lines = content.split('\n');
        const surviving = [];
        const survivingNonces = new Set();
        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (entry.timestamp >= cutoff) {
                    surviving.push(line);
                    survivingNonces.add(entry.nonce);
                }
            }
            catch {
                // Skip corrupt entries
            }
        }
        // Rewrite file with only surviving entries
        fs.writeFileSync(filePath, surviving.join('\n') + (surviving.length ? '\n' : ''));
        this.nonces = survivingNonces;
    }
    // ── Private ──────────────────────────────────────────────────────
    get noncePath() {
        return path.join(this.stateDir, NONCE_FILE);
    }
    loadFromDisk() {
        const filePath = this.noncePath;
        if (!fs.existsSync(filePath))
            return;
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        if (!content)
            return;
        for (const line of content.split('\n')) {
            try {
                const entry = JSON.parse(line);
                this.nonces.add(entry.nonce);
            }
            catch {
                // Skip corrupt entries
            }
        }
    }
    persistNonce(nonce) {
        const entry = { nonce, timestamp: Date.now() };
        fs.appendFileSync(this.noncePath, JSON.stringify(entry) + '\n');
    }
}
//# sourceMappingURL=NonceStore.js.map