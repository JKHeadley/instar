/**
 * SoulManager — Self-authored identity management for Instar agents.
 *
 * Manages `.instar/soul.md` with:
 * - Server-side trust enforcement (section-level write permissions)
 * - Pending queue for changes exceeding trust level
 * - Drift detection against init-time snapshot
 * - Audit trail via security ledger
 * - Integrity hashing for compaction recovery verification
 *
 * soul.md is reflective identity ("what I believe, what I'm wrestling with").
 * AGENT.md is operational identity ("how I work, what I do").
 * They are complementary, not competing.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SOUL_SECTION_TRUST } from './types.js';
// ── Trust Level Ordering ────────────────────────────────────────────
const TRUST_ORDER = {
    cautious: 0,
    supervised: 1,
    collaborative: 2,
    autonomous: 3,
};
function trustMeetsRequirement(current, required) {
    return TRUST_ORDER[current] >= TRUST_ORDER[required];
}
// ── Section Markers ─────────────────────────────────────────────────
const SECTION_HEADERS = {
    'core-values': '## Core Values',
    'growth-edge': '## Current Growth Edge',
    'convictions': '## Convictions',
    'open-questions': '## Open Questions',
    'integrations': '## Integrations',
    'evolution-history': '## Evolution History',
};
// ── Manager ─────────────────────────────────────────────────────────
export class SoulManager {
    stateDir;
    soulPath;
    initSnapshotPath;
    integrityPath;
    pendingPath;
    lockPath;
    securityLedgerPath;
    integrityManager;
    constructor(opts) {
        this.stateDir = opts.stateDir;
        this.soulPath = path.join(opts.stateDir, 'soul.md');
        this.initSnapshotPath = path.join(opts.stateDir, 'state', 'soul.init.md');
        this.integrityPath = path.join(opts.stateDir, 'state', 'soul-integrity.json');
        this.pendingPath = path.join(opts.stateDir, 'state', 'soul-pending.json');
        this.lockPath = path.join(opts.stateDir, 'state', 'soul.lock');
        this.securityLedgerPath = path.join(opts.stateDir, 'security.jsonl');
        this.integrityManager = opts.integrityManager ?? null;
    }
    // ── Public API ──────────────────────────────────────────────────
    /** Check if soul.md exists for this agent. */
    isEnabled() {
        return fs.existsSync(this.soulPath);
    }
    /** Read the full soul.md content. */
    readSoul() {
        if (!fs.existsSync(this.soulPath))
            return null;
        return fs.readFileSync(this.soulPath, 'utf-8');
    }
    /** Read only the public sections (Personality Seed + Core Values). */
    readPublicSections() {
        const content = this.readSoul();
        if (!content)
            return null;
        const sections = [];
        // Extract Personality Seed
        const seedSection = this.extractSection(content, '## Personality Seed');
        if (seedSection)
            sections.push('## Personality Seed\n\n' + seedSection);
        // Extract Core Values
        const valuesSection = this.extractSection(content, '## Core Values');
        if (valuesSection)
            sections.push('## Core Values\n\n' + valuesSection);
        return sections.length > 0 ? sections.join('\n\n---\n\n') : null;
    }
    /**
     * Apply a patch to soul.md with trust enforcement.
     *
     * Returns { status: 'applied' } if the write succeeded,
     * or { status: 'pending', pendingId } if the change was queued.
     */
    patch(request, trustLevel) {
        if (!this.isEnabled()) {
            throw new SoulError('soul.md is not enabled for this agent', 'not_enabled');
        }
        // Check trust level for section
        const requiredLevel = SOUL_SECTION_TRUST[request.section];
        const allowed = this.checkSectionAccess(request.section, trustLevel);
        if (!allowed) {
            // At supervised level, queue for review instead of rejecting
            if (trustLevel === 'cautious') {
                throw new SoulError(`Cautious trust level cannot modify ${request.section}. Change is blocked.`, 'trust_violation', { requiredLevel, currentLevel: trustLevel });
            }
            // Queue as pending
            const pendingId = this.addPending({
                section: request.section,
                operation: request.operation,
                content: request.content,
                source: request.source,
                trustLevel,
            });
            return {
                status: 'pending',
                section: request.section,
                trustLevel,
                pendingId,
            };
        }
        // Apply the change
        this.acquireLock();
        try {
            this.applyWrite(request);
            this.updateIntegrityHash();
            this.emitAuditEvent({
                section: request.section,
                operation: request.operation,
                trustLevel,
                source: request.source,
                diffSummary: this.summarizeDiff(request),
                threadlineSource: request.source === 'threadline' ? 'threadline' : null,
            });
        }
        finally {
            this.releaseLock();
        }
        return {
            status: 'applied',
            section: request.section,
            trustLevel,
        };
    }
    /**
     * Check if a section can be written at the given trust level.
     *
     * At Collaborative+ level, all sections are writable.
     * At Supervised, protected sections go to pending queue.
     * At Cautious, only integrations and evolution-history are writable.
     */
    checkSectionAccess(section, trustLevel) {
        // Autonomous and collaborative can write everything
        if (trustLevel === 'autonomous' || trustLevel === 'collaborative') {
            return true;
        }
        const requiredLevel = SOUL_SECTION_TRUST[section];
        return trustMeetsRequirement(trustLevel, requiredLevel);
    }
    // ── Pending Queue ───────────────────────────────────────────────
    /** Add a change to the pending queue. */
    addPending(opts) {
        const pending = this.loadPending();
        const nextNum = pending.length + 1;
        const id = `PND-${String(nextNum).padStart(3, '0')}`;
        const change = {
            id,
            section: opts.section,
            operation: opts.operation,
            content: opts.content,
            source: opts.source,
            trustLevel: opts.trustLevel,
            createdAt: new Date().toISOString(),
            status: 'pending',
        };
        pending.push(change);
        this.savePending(pending);
        return id;
    }
    /** Get all pending changes. */
    getPending(status) {
        const all = this.loadPending();
        if (!status)
            return all;
        return all.filter(p => p.status === status);
    }
    /** Approve a pending change — apply it to soul.md. */
    approvePending(id) {
        const pending = this.loadPending();
        const change = pending.find(p => p.id === id);
        if (!change) {
            throw new SoulError(`Pending change ${id} not found`, 'not_found');
        }
        if (change.status !== 'pending') {
            throw new SoulError(`Pending change ${id} is already ${change.status}`, 'invalid_state');
        }
        // Apply the write
        this.acquireLock();
        try {
            this.applyWrite({
                section: change.section,
                operation: change.operation,
                content: change.content,
                source: change.source,
            });
            this.updateIntegrityHash();
            this.emitAuditEvent({
                section: change.section,
                operation: change.operation,
                trustLevel: change.trustLevel,
                source: change.source,
                diffSummary: `Approved pending ${id}: ${this.summarizeDiff(change)}`,
                threadlineSource: change.source === 'threadline' ? 'threadline' : null,
            });
        }
        finally {
            this.releaseLock();
        }
        // Update pending status
        change.status = 'approved';
        change.resolvedAt = new Date().toISOString();
        this.savePending(pending);
        return {
            status: 'applied',
            section: change.section,
            trustLevel: change.trustLevel,
        };
    }
    /** Reject a pending change with optional reason. */
    rejectPending(id, reason) {
        const pending = this.loadPending();
        const change = pending.find(p => p.id === id);
        if (!change) {
            throw new SoulError(`Pending change ${id} not found`, 'not_found');
        }
        if (change.status !== 'pending') {
            throw new SoulError(`Pending change ${id} is already ${change.status}`, 'invalid_state');
        }
        change.status = 'rejected';
        change.resolvedAt = new Date().toISOString();
        change.rejectionReason = reason;
        this.savePending(pending);
        this.emitAuditEvent({
            section: change.section,
            operation: change.operation,
            trustLevel: change.trustLevel,
            source: change.source,
            diffSummary: `Rejected pending ${id}: ${reason ?? 'no reason given'}`,
            threadlineSource: null,
        });
    }
    // ── Drift Detection ─────────────────────────────────────────────
    /** Analyze drift between current soul.md and init snapshot. */
    analyzeDrift() {
        const initExists = fs.existsSync(this.initSnapshotPath);
        if (!initExists || !this.isEnabled()) {
            return {
                sections: [],
                anyAboveThreshold: false,
                lastReviewedAt: null,
                initSnapshotExists: initExists,
            };
        }
        const current = fs.readFileSync(this.soulPath, 'utf-8');
        const init = fs.readFileSync(this.initSnapshotPath, 'utf-8');
        const thresholds = {
            'core-values': 60,
            'convictions': 60,
            'growth-edge': 100, // No threshold — expected to change
            'open-questions': 100,
            'integrations': 100, // Append-only, no threshold
            'evolution-history': 100,
        };
        const sections = [];
        for (const [section, header] of Object.entries(SECTION_HEADERS)) {
            const currentText = this.extractSection(current, header) ?? '';
            const initText = this.extractSection(init, header) ?? '';
            const divergence = this.calculateDivergence(currentText, initText);
            const threshold = thresholds[section];
            sections.push({
                section,
                divergencePercent: divergence,
                aboveThreshold: divergence > threshold,
            });
        }
        return {
            sections,
            anyAboveThreshold: sections.some(s => s.aboveThreshold),
            lastReviewedAt: this.getLastDriftReview(),
            initSnapshotExists: true,
        };
    }
    /** Record that drift was reviewed (resets the review timer). */
    markDriftReviewed() {
        const integrityData = this.loadIntegrity();
        integrityData.lastDriftReview = new Date().toISOString();
        this.saveIntegrity(integrityData);
    }
    // ── Integrity ───────────────────────────────────────────────────
    /** Verify soul.md integrity against stored hash or HMAC (v0.22+). */
    verifyIntegrity() {
        if (!this.isEnabled()) {
            return { valid: true, reason: 'soul.md not enabled' };
        }
        // Prefer v0.22 HMAC IntegrityManager if available
        if (this.integrityManager) {
            const result = this.integrityManager.verify(this.soulPath);
            if (!result.valid) {
                return { valid: false, reason: `HMAC verification failed: ${result.reason}` };
            }
            return { valid: true };
        }
        // Fallback: SHA-256 hash check
        const integrity = this.loadIntegrity();
        if (!integrity.hash) {
            return { valid: false, reason: 'no integrity hash stored' };
        }
        const currentHash = this.hashFile(this.soulPath);
        if (currentHash !== integrity.hash) {
            return { valid: false, reason: 'hash mismatch — soul.md may have been modified outside normal channels' };
        }
        return { valid: true };
    }
    /**
     * Get content safe for compaction recovery injection.
     * Only returns Personality Seed + Core Values after integrity check.
     */
    getCompactionContent() {
        if (!this.isEnabled())
            return null;
        const integrity = this.verifyIntegrity();
        if (!integrity.valid) {
            // Fallback: inject only the Personality Seed from the init snapshot
            if (fs.existsSync(this.initSnapshotPath)) {
                const init = fs.readFileSync(this.initSnapshotPath, 'utf-8');
                const seed = this.extractSection(init, '## Personality Seed');
                return seed ? `## Personality Seed\n\n${seed}` : null;
            }
            return null;
        }
        return this.readPublicSections();
    }
    // ── Initialization ──────────────────────────────────────────────
    /**
     * Initialize soul.md for the first time.
     * Creates soul.md, soul.init.md, and integrity hash.
     */
    initialize(content) {
        fs.mkdirSync(path.dirname(this.initSnapshotPath), { recursive: true });
        // Write soul.md
        fs.writeFileSync(this.soulPath, content);
        // Write init snapshot (immutable reference)
        fs.writeFileSync(this.initSnapshotPath, content);
        // Store integrity hash
        this.updateIntegrityHash();
    }
    // ── Private Helpers ─────────────────────────────────────────────
    applyWrite(request) {
        let content = fs.readFileSync(this.soulPath, 'utf-8');
        const header = SECTION_HEADERS[request.section];
        switch (request.operation) {
            case 'replace': {
                content = this.replaceSection(content, header, request.content);
                break;
            }
            case 'append': {
                content = this.appendToSection(content, header, request.content);
                break;
            }
            case 'remove': {
                content = this.removeFromSection(content, header, request.content);
                break;
            }
        }
        fs.writeFileSync(this.soulPath, content);
    }
    extractSection(content, header) {
        const headerIndex = content.indexOf(header);
        if (headerIndex === -1)
            return null;
        const afterHeader = content.substring(headerIndex + header.length);
        // Find the next section (## or ---) or end of file
        const nextSection = afterHeader.search(/\n---\n|\n## /);
        const sectionContent = nextSection === -1
            ? afterHeader
            : afterHeader.substring(0, nextSection);
        return sectionContent.trim();
    }
    replaceSection(content, header, newContent) {
        const headerIndex = content.indexOf(header);
        if (headerIndex === -1)
            return content;
        const afterHeader = content.substring(headerIndex + header.length);
        const nextSection = afterHeader.search(/\n---\n|\n## /);
        const before = content.substring(0, headerIndex + header.length);
        const after = nextSection === -1 ? '' : afterHeader.substring(nextSection);
        return before + '\n\n' + newContent + '\n' + after;
    }
    appendToSection(content, header, newContent) {
        const headerIndex = content.indexOf(header);
        if (headerIndex === -1)
            return content;
        const afterHeader = content.substring(headerIndex + header.length);
        const nextSection = afterHeader.search(/\n---\n|\n## /);
        const before = content.substring(0, headerIndex + header.length);
        const existingContent = nextSection === -1
            ? afterHeader
            : afterHeader.substring(0, nextSection);
        const after = nextSection === -1 ? '' : afterHeader.substring(nextSection);
        return before + existingContent.trimEnd() + '\n\n' + newContent + '\n' + after;
    }
    removeFromSection(content, header, toRemove) {
        const headerIndex = content.indexOf(header);
        if (headerIndex === -1)
            return content;
        const afterHeader = content.substring(headerIndex + header.length);
        const nextSection = afterHeader.search(/\n---\n|\n## /);
        const sectionContent = nextSection === -1
            ? afterHeader
            : afterHeader.substring(0, nextSection);
        const before = content.substring(0, headerIndex + header.length);
        const after = nextSection === -1 ? '' : afterHeader.substring(nextSection);
        const cleaned = sectionContent.replace(toRemove, '').replace(/\n{3,}/g, '\n\n');
        return before + cleaned + after;
    }
    calculateDivergence(current, init) {
        if (init.length === 0 && current.length === 0)
            return 0;
        if (init.length === 0 && current.length > 0)
            return 100;
        if (current === init)
            return 0;
        // Simple character-level Levenshtein-inspired metric
        // More practical: line-based diff percentage
        const currentLines = current.split('\n').filter(l => l.trim());
        const initLines = new Set(init.split('\n').filter(l => l.trim()));
        if (initLines.size === 0)
            return currentLines.length > 0 ? 100 : 0;
        let changed = 0;
        for (const line of currentLines) {
            if (!initLines.has(line))
                changed++;
        }
        // Also count removed lines
        const currentSet = new Set(currentLines);
        for (const line of initLines) {
            if (!currentSet.has(line))
                changed++;
        }
        const totalLines = Math.max(currentLines.length, initLines.size);
        return Math.round((changed / totalLines) * 100);
    }
    // ── File Lock ─────────────────────────────────────────────────
    acquireLock() {
        const maxWait = 5000;
        const start = Date.now();
        while (fs.existsSync(this.lockPath)) {
            // Check if lock is stale (> 30 seconds)
            try {
                const stat = fs.statSync(this.lockPath);
                if (Date.now() - stat.mtimeMs > 30000) {
                    fs.unlinkSync(this.lockPath);
                    break;
                }
            }
            catch {
                break; // Lock was released
            }
            if (Date.now() - start > maxWait) {
                throw new SoulError('Could not acquire soul.md write lock', 'conflict');
            }
            // Busy wait briefly (this is a local file lock, not high-frequency)
            const waitUntil = Date.now() + 50;
            while (Date.now() < waitUntil) { /* spin */ }
        }
        fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
        fs.writeFileSync(this.lockPath, String(process.pid));
    }
    releaseLock() {
        try {
            fs.unlinkSync(this.lockPath);
        }
        catch {
            // Already released
        }
    }
    // ── Integrity Hash ──────────────────────────────────────────────
    hashFile(filePath) {
        const content = fs.readFileSync(filePath, 'utf-8');
        return crypto.createHash('sha256').update(content).digest('hex');
    }
    updateIntegrityHash() {
        if (!this.isEnabled())
            return;
        // Sign via v0.22 HMAC IntegrityManager if available
        if (this.integrityManager) {
            try {
                this.integrityManager.sign(this.soulPath);
            }
            catch { /* non-fatal */ }
        }
        // Also maintain legacy SHA-256 hash (backwards compatibility)
        const hash = this.hashFile(this.soulPath);
        const data = this.loadIntegrity();
        data.hash = hash;
        data.updatedAt = new Date().toISOString();
        this.saveIntegrity(data);
    }
    loadIntegrity() {
        if (!fs.existsSync(this.integrityPath))
            return {};
        try {
            return JSON.parse(fs.readFileSync(this.integrityPath, 'utf-8'));
        }
        catch {
            return {};
        }
    }
    saveIntegrity(data) {
        fs.mkdirSync(path.dirname(this.integrityPath), { recursive: true });
        fs.writeFileSync(this.integrityPath, JSON.stringify(data, null, 2));
    }
    getLastDriftReview() {
        return this.loadIntegrity().lastDriftReview ?? null;
    }
    // ── Pending Persistence ─────────────────────────────────────────
    loadPending() {
        if (!fs.existsSync(this.pendingPath))
            return [];
        try {
            return JSON.parse(fs.readFileSync(this.pendingPath, 'utf-8'));
        }
        catch {
            return [];
        }
    }
    savePending(pending) {
        fs.mkdirSync(path.dirname(this.pendingPath), { recursive: true });
        fs.writeFileSync(this.pendingPath, JSON.stringify(pending, null, 2));
    }
    // ── Audit Trail ─────────────────────────────────────────────────
    emitAuditEvent(opts) {
        const event = {
            event: 'soul.write',
            timestamp: new Date().toISOString(),
            section: opts.section,
            operation: opts.operation,
            trustLevel: opts.trustLevel,
            source: opts.source,
            diffSummary: opts.diffSummary,
            threadlineSource: opts.threadlineSource,
        };
        try {
            fs.appendFileSync(this.securityLedgerPath, JSON.stringify(event) + '\n');
        }
        catch {
            // Non-fatal — audit is best-effort
        }
    }
    summarizeDiff(request) {
        const contentPreview = request.content.length > 100
            ? request.content.substring(0, 100) + '...'
            : request.content;
        return `${request.operation} ${request.section}: ${contentPreview}`;
    }
}
// ── Error Class ───────────────────────────────────────────────────────
export class SoulError extends Error {
    code;
    details;
    constructor(message, code, details) {
        super(message);
        this.name = 'SoulError';
        this.code = code;
        this.details = details;
    }
}
//# sourceMappingURL=SoulManager.js.map