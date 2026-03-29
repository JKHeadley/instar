/**
 * AuditTrail — Tamper-evident logging for LLM merge operations.
 *
 * Logs:
 *   - Every LLM invocation (prompt hash, model, timestamp)
 *   - Resolution decisions (chosen side, confidence, file)
 *   - Validation results (post-merge checks)
 *   - Redaction events (count, types — never the values)
 *   - Security events (injection attempts, auth failures)
 *
 * Log entries are chained: each entry includes a hash of the previous
 * entry, creating a tamper-evident audit chain.
 *
 * From INTELLIGENT_SYNC_SPEC Section 5.6 and Phase 6 requirements.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
// ── Constants ────────────────────────────────────────────────────────
const AUDIT_DIR = 'audit';
const CURRENT_LOG = 'current.jsonl';
const GENESIS_HASH = '0'.repeat(64);
const DEFAULT_MAX_ENTRIES = 1000;
// ── AuditTrail ───────────────────────────────────────────────────────
export class AuditTrail {
    stateDir;
    machineId;
    auditDir;
    maxEntries;
    lastHash;
    constructor(config) {
        this.stateDir = config.stateDir;
        this.machineId = config.machineId;
        this.maxEntries = config.maxEntriesPerFile ?? DEFAULT_MAX_ENTRIES;
        this.auditDir = path.join(config.stateDir, 'state', AUDIT_DIR);
        if (!fs.existsSync(this.auditDir)) {
            fs.mkdirSync(this.auditDir, { recursive: true });
        }
        // Load the last hash from the current log
        this.lastHash = this.loadLastHash();
    }
    // ── Logging ───────────────────────────────────────────────────────
    /**
     * Log an LLM invocation event.
     */
    logLLMInvocation(data) {
        return this.append('llm-invocation', data, data.sessionId);
    }
    /**
     * Log a resolution decision.
     */
    logResolution(data) {
        return this.append('resolution', data, data.sessionId);
    }
    /**
     * Log a validation result.
     */
    logValidation(data) {
        return this.append('validation', data, data.sessionId);
    }
    /**
     * Log a redaction event (never log the actual values).
     */
    logRedaction(data) {
        return this.append('redaction', data, data.sessionId);
    }
    /**
     * Log a security event.
     */
    logSecurity(data) {
        return this.append('security', data, data.sessionId);
    }
    /**
     * Log a handoff event.
     */
    logHandoff(data) {
        return this.append('handoff', data, data.sessionId);
    }
    /**
     * Log a branch event.
     */
    logBranch(data) {
        return this.append('branch', data, data.sessionId);
    }
    /**
     * Log an access denied event.
     */
    logAccessDenied(data) {
        return this.append('access-denied', data, data.sessionId);
    }
    // ── Querying ──────────────────────────────────────────────────────
    /**
     * Query audit entries with filters.
     */
    query(filter) {
        const entries = this.loadEntries();
        let filtered = entries;
        if (filter?.type) {
            filtered = filtered.filter(e => e.type === filter.type);
        }
        if (filter?.machineId) {
            filtered = filtered.filter(e => e.machineId === filter.machineId);
        }
        if (filter?.sessionId) {
            filtered = filtered.filter(e => e.sessionId === filter.sessionId);
        }
        if (filter?.after) {
            filtered = filtered.filter(e => e.timestamp > filter.after);
        }
        if (filter?.before) {
            filtered = filtered.filter(e => e.timestamp < filter.before);
        }
        if (filter?.limit) {
            filtered = filtered.slice(-filter.limit);
        }
        return filtered;
    }
    /**
     * Get audit statistics.
     */
    stats() {
        const entries = this.loadEntries();
        const byType = {};
        const byMachine = {};
        for (const entry of entries) {
            byType[entry.type] = (byType[entry.type] ?? 0) + 1;
            byMachine[entry.machineId] = (byMachine[entry.machineId] ?? 0) + 1;
        }
        return {
            totalEntries: entries.length,
            byType,
            byMachine,
            firstEntry: entries[0]?.timestamp,
            lastEntry: entries[entries.length - 1]?.timestamp,
        };
    }
    // ── Integrity Verification ────────────────────────────────────────
    /**
     * Verify the integrity of the audit chain.
     * Checks that each entry's previousHash matches the prior entry's entryHash.
     */
    verifyIntegrity() {
        const entries = this.loadEntries();
        if (entries.length === 0) {
            return { intact: true, entriesChecked: 0 };
        }
        // First entry should chain from genesis
        if (entries[0].previousHash !== GENESIS_HASH) {
            return {
                intact: false,
                entriesChecked: 1,
                brokenAt: 0,
                breakDetails: `First entry does not chain from genesis hash`,
            };
        }
        for (let i = 0; i < entries.length; i++) {
            // Verify the entry's own hash
            const computed = this.computeEntryHash(entries[i]);
            if (computed !== entries[i].entryHash) {
                return {
                    intact: false,
                    entriesChecked: i + 1,
                    brokenAt: i,
                    breakDetails: `Entry ${entries[i].id} has been tampered with (hash mismatch)`,
                };
            }
            // Verify chain link (skip first entry, already checked)
            if (i > 0 && entries[i].previousHash !== entries[i - 1].entryHash) {
                return {
                    intact: false,
                    entriesChecked: i + 1,
                    brokenAt: i,
                    breakDetails: `Chain broken at entry ${entries[i].id} — previousHash does not match prior entry`,
                };
            }
        }
        return { intact: true, entriesChecked: entries.length };
    }
    // ── Private Helpers ───────────────────────────────────────────────
    /**
     * Append an entry to the audit log.
     */
    append(type, data, sessionId) {
        const entry = {
            id: `audit_${crypto.randomBytes(8).toString('hex')}`,
            type,
            timestamp: new Date().toISOString(),
            machineId: this.machineId,
            sessionId,
            data,
            previousHash: this.lastHash,
            entryHash: '', // Computed below
        };
        entry.entryHash = this.computeEntryHash(entry);
        this.lastHash = entry.entryHash;
        // Write to current log
        const logPath = this.currentLogPath();
        fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
        // Check if rotation is needed
        this.maybeRotate();
        return entry;
    }
    /**
     * Compute the SHA-256 hash of an entry (excluding the entryHash field).
     */
    computeEntryHash(entry) {
        const hashable = {
            id: entry.id,
            type: entry.type,
            timestamp: entry.timestamp,
            machineId: entry.machineId,
            userId: entry.userId,
            sessionId: entry.sessionId,
            data: entry.data,
            previousHash: entry.previousHash,
        };
        return crypto.createHash('sha256')
            .update(JSON.stringify(hashable))
            .digest('hex');
    }
    /**
     * Load the last hash from the current log.
     */
    loadLastHash() {
        const entries = this.loadEntries();
        if (entries.length === 0)
            return GENESIS_HASH;
        return entries[entries.length - 1].entryHash;
    }
    /**
     * Load all entries from the current log.
     */
    loadEntries() {
        const logPath = this.currentLogPath();
        try {
            const content = fs.readFileSync(logPath, 'utf-8');
            return content.trim().split('\n')
                .filter(line => line.trim())
                .map(line => JSON.parse(line));
        }
        catch {
            // @silent-fallback-ok — log file may not exist yet; empty array is the natural default
            return [];
        }
    }
    /**
     * Current log file path.
     */
    currentLogPath() {
        return path.join(this.auditDir, CURRENT_LOG);
    }
    /**
     * Rotate log if it exceeds max entries.
     */
    maybeRotate() {
        const entries = this.loadEntries();
        if (entries.length < this.maxEntries)
            return;
        // Rotate: rename current to timestamped archive
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const archiveName = `audit-${timestamp}.jsonl`;
        const archivePath = path.join(this.auditDir, archiveName);
        try {
            fs.renameSync(this.currentLogPath(), archivePath);
        }
        catch {
            // Rotation failed — continue with current file
        }
    }
}
//# sourceMappingURL=AuditTrail.js.map