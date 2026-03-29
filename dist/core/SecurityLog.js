/**
 * Security event log with hash-chain integrity.
 *
 * Append-only JSONL log where each entry includes a prevHash field
 * containing the SHA-256 hash of the previous entry. This makes
 * retroactive tampering detectable — altering any entry breaks
 * the chain for all subsequent entries.
 *
 * Part of Phase 1 (machine identity infrastructure).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';
// ── Constants ────────────────────────────────────────────────────────
const GENESIS_HASH = 'GENESIS';
const LOG_FILE = 'security.jsonl';
// ── SecurityLog ──────────────────────────────────────────────────────
export class SecurityLog {
    logPath;
    lastHash;
    initialized = false;
    constructor(logsDir) {
        this.logPath = path.join(logsDir, LOG_FILE);
        this.lastHash = GENESIS_HASH;
    }
    /**
     * Initialize the log by reading the last entry's hash.
     * Must be called before appending. Idempotent.
     */
    initialize() {
        if (this.initialized)
            return;
        fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
        if (fs.existsSync(this.logPath)) {
            const content = fs.readFileSync(this.logPath, 'utf-8').trim();
            if (content) {
                const lines = content.split('\n');
                const lastLine = lines[lines.length - 1];
                this.lastHash = hashEntry(lastLine);
            }
        }
        this.initialized = true;
    }
    /**
     * Append a security event to the log.
     */
    append(eventData) {
        this.initialize();
        // Rotate before building the entry — rotation changes the last hash
        if (maybeRotateJsonl(this.logPath)) {
            this.initialized = false;
            this.initialize();
        }
        const entry = {
            timestamp: new Date().toISOString(),
            prevHash: this.lastHash,
            ...eventData,
        };
        const line = JSON.stringify(entry);
        fs.appendFileSync(this.logPath, line + '\n');
        this.lastHash = hashEntry(line);
        return entry;
    }
    /**
     * Read all log entries.
     */
    readAll() {
        if (!fs.existsSync(this.logPath))
            return [];
        const content = fs.readFileSync(this.logPath, 'utf-8').trim();
        if (!content)
            return [];
        return content.split('\n').map(line => JSON.parse(line));
    }
    /**
     * Verify the integrity of the hash chain.
     * Returns { valid: true } if the chain is intact, or
     * { valid: false, brokenAt: index } if tampering is detected.
     */
    verifyChain() {
        if (!fs.existsSync(this.logPath))
            return { valid: true };
        const content = fs.readFileSync(this.logPath, 'utf-8').trim();
        if (!content)
            return { valid: true };
        const lines = content.split('\n');
        let expectedPrevHash = GENESIS_HASH;
        for (let i = 0; i < lines.length; i++) {
            const entry = JSON.parse(lines[i]);
            if (entry.prevHash !== expectedPrevHash) {
                return { valid: false, brokenAt: i };
            }
            expectedPrevHash = hashEntry(lines[i]);
        }
        return { valid: true };
    }
    /**
     * Get the number of entries in the log.
     */
    get length() {
        if (!fs.existsSync(this.logPath))
            return 0;
        const content = fs.readFileSync(this.logPath, 'utf-8').trim();
        if (!content)
            return 0;
        return content.split('\n').length;
    }
    /**
     * Get the path to the log file.
     */
    get path() {
        return this.logPath;
    }
}
// ── Helpers ──────────────────────────────────────────────────────────
/**
 * Compute the SHA-256 hash of a JSON line.
 */
function hashEntry(jsonLine) {
    return `sha256:${crypto.createHash('sha256').update(jsonLine).digest('hex')}`;
}
//# sourceMappingURL=SecurityLog.js.map