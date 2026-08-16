/**
 * TelemetryHeartbeat — Opt-in anonymous usage telemetry for Instar.
 *
 * Two telemetry channels:
 *   1. Heartbeat (legacy) — Basic version/uptime/usage counts
 *   2. Baseline — Rich job metrics for cross-agent intelligence
 *
 * Both are default OFF. No PII. No conversation content. Agent owners opt in explicitly.
 *
 * What is NEVER sent:
 *   - Agent names, prompts, or configuration
 *   - Conversation content or memory data
 *   - File paths, environment variables, or secrets
 *   - IP addresses (not logged server-side)
 *   - Security-posture feature flags
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { TelemetryAuth } from './TelemetryAuth.js';
const DEFAULT_ENDPOINT = 'https://instar-telemetry.sagemind-ai.workers.dev/v1/heartbeat';
const BASELINE_ENDPOINT = 'https://instar-telemetry.sagemind-ai.workers.dev/v1/telemetry';
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const SEND_TIMEOUT_MS = 3000; // Fire-and-forget, never block agent operation
const HEARTBEAT_VERSION = 1;
const BASELINE_LOG_RETENTION_DAYS = 30;
export class TelemetryHeartbeat extends EventEmitter {
    config;
    interval = null;
    baselineInterval = null;
    installId;
    startTime;
    counters;
    agentCountFn = null;
    // Baseline telemetry
    auth;
    collector = null;
    lastBaselineSubmission = null;
    lastBaselineError = null;
    consentChecker = null;
    constructor(telemetryConfig, stateDir, projectDir, version) {
        super();
        this.config = {
            enabled: telemetryConfig.enabled,
            level: telemetryConfig.level ?? 'basic',
            intervalMs: telemetryConfig.intervalMs ?? DEFAULT_INTERVAL_MS,
            endpoint: telemetryConfig.endpoint ?? DEFAULT_ENDPOINT,
            stateDir,
            projectDir,
            version,
        };
        this.installId = this.computeInstallId();
        this.startTime = Date.now();
        this.counters = {
            jobsRun: 0,
            sessionsSpawned: 0,
            skillsInvoked: 0,
            lastReset: Date.now(),
        };
        this.auth = new TelemetryAuth(stateDir);
    }
    /**
     * Set the TelemetryCollector for Baseline submissions.
     * Must be called after construction when scheduler/ledger are available.
     */
    setCollector(collector) {
        this.collector = collector;
    }
    /**
     * Set a consent checker for Baseline submissions.
     * When set, Baseline submissions only proceed if the checker returns true.
     * This integrates with the FeatureRegistry consent framework.
     */
    setConsentChecker(checker) {
        this.consentChecker = checker;
    }
    /**
     * Start the periodic heartbeat and Baseline submission cycles.
     * Sends first heartbeat after a short delay (not immediately on boot).
     */
    start() {
        if (!this.config.enabled)
            return;
        // First heartbeat after 60 seconds (let the server stabilize)
        setTimeout(() => {
            this.sendHeartbeat().catch(() => { });
        }, 60_000);
        this.interval = setInterval(() => {
            this.sendHeartbeat().catch(() => { });
        }, this.config.intervalMs);
        // Don't prevent process exit
        if (this.interval.unref)
            this.interval.unref();
        // Baseline: start with random jitter (0-6h) for first submission, then every 6h
        if (this.auth.isProvisioned() && this.collector) {
            const jitterMs = Math.floor(Math.random() * this.config.intervalMs);
            const firstDelay = Math.max(120_000, jitterMs); // At least 2 min to stabilize
            setTimeout(() => {
                this.sendBaselineSubmission().catch(() => { }); // @silent-fallback-ok — telemetry failure must never affect agent operation
                this.baselineInterval = setInterval(() => {
                    this.sendBaselineSubmission().catch(() => { }); // @silent-fallback-ok — telemetry failure must never affect agent operation
                }, this.config.intervalMs);
                if (this.baselineInterval?.unref)
                    this.baselineInterval.unref();
            }, firstDelay);
        }
    }
    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        if (this.baselineInterval) {
            clearInterval(this.baselineInterval);
            this.baselineInterval = null;
        }
    }
    /**
     * Register a function that returns the current agent count.
     * Called lazily at heartbeat time.
     */
    setAgentCountProvider(fn) {
        this.agentCountFn = fn;
    }
    // ── Recording Methods (called by other modules) ──────────────────
    recordJobRun() {
        this.counters.jobsRun++;
    }
    recordSessionSpawned() {
        this.counters.sessionsSpawned++;
    }
    recordSkillInvoked() {
        this.counters.skillsInvoked++;
    }
    // ── Heartbeat Construction & Sending ─────────────────────────────
    buildPayload() {
        const payload = {
            v: HEARTBEAT_VERSION,
            id: this.installId,
            ts: new Date().toISOString(),
            instar: this.config.version,
            node: process.version.replace('v', ''),
            os: os.platform(),
            arch: os.arch(),
            agents: this.agentCountFn?.() ?? 0,
            uptime_hours: Math.round((Date.now() - this.startTime) / 3600000 * 10) / 10,
        };
        // Usage-level metrics (aggregate counts only)
        if (this.config.level === 'usage') {
            payload.jobs_run_24h = this.counters.jobsRun;
            payload.sessions_spawned_24h = this.counters.sessionsSpawned;
            payload.skills_invoked_24h = this.counters.skillsInvoked;
        }
        return payload;
    }
    async sendHeartbeat() {
        if (!this.config.enabled)
            return false;
        const payload = this.buildPayload();
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
            const response = await fetch(this.config.endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            clearTimeout(timeout);
            // Log locally for transparency
            this.logHeartbeat(payload, response.ok);
            // Reset 24h counters periodically
            if (Date.now() - this.counters.lastReset > 24 * 60 * 60 * 1000) {
                this.counters.jobsRun = 0;
                this.counters.sessionsSpawned = 0;
                this.counters.skillsInvoked = 0;
                this.counters.lastReset = Date.now();
            }
            this.emit('heartbeat', { success: response.ok, payload });
            return response.ok;
        }
        catch {
            // @silent-fallback-ok — fire-and-forget; telemetry failure must never affect agent operation
            this.logHeartbeat(payload, false);
            this.emit('heartbeat', { success: false, payload });
            return false;
        }
    }
    // ── Baseline Telemetry ─────────────────────────────────────────────
    /**
     * Send a Baseline telemetry submission with HMAC signing.
     * Fire-and-forget — failure never affects agent operation.
     */
    async sendBaselineSubmission() {
        if (!this.config.enabled || !this.collector || !this.auth.isProvisioned())
            return false;
        // Check FeatureRegistry consent if a checker is wired
        if (this.consentChecker && !this.consentChecker()) {
            this.lastBaselineError = 'consent_not_granted';
            return false;
        }
        const installationId = this.auth.getInstallationId();
        if (!installationId)
            return false;
        const now = new Date();
        const windowEnd = now;
        const windowStart = new Date(now.getTime() - this.config.intervalMs);
        try {
            const payload = this.collector.collect(installationId, windowStart, windowEnd);
            const payloadJson = JSON.stringify(payload);
            const payloadBytes = Buffer.from(payloadJson, 'utf-8');
            // Check 100KB payload limit
            if (payloadBytes.length > 100_000) {
                console.log(`[Baseline] Payload exceeds 100KB (${payloadBytes.length}), skipping`);
                this.lastBaselineError = 'payload_too_large';
                return false;
            }
            const timestamp = Math.floor(Date.now() / 1000).toString();
            const signature = this.auth.sign(installationId, timestamp, payloadBytes);
            if (!signature) {
                this.lastBaselineError = 'signing_failed';
                return false;
            }
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
            const headers = {
                'Content-Type': 'application/json',
                'X-Instar-Signature': `hmac-sha256=${signature}`,
                'X-Instar-Timestamp': timestamp,
            };
            // Include key fingerprint for server-side binding verification
            const fingerprint = this.auth.getKeyFingerprint();
            if (fingerprint) {
                headers['X-Instar-Key-Fingerprint'] = fingerprint;
            }
            const response = await fetch(BASELINE_ENDPOINT, {
                method: 'POST',
                headers,
                body: payloadJson,
                signal: controller.signal,
            });
            clearTimeout(timeout);
            // Log full payload for transparency
            this.logBaselineSubmission(payload, response.status);
            if (response.ok) {
                this.lastBaselineSubmission = now;
                this.lastBaselineError = null;
            }
            else {
                try {
                    const body = await response.json();
                    this.lastBaselineError = body.error ?? `http_${response.status}`;
                }
                catch {
                    // @silent-fallback-ok — response body parse failure is non-critical; status code suffices
                    this.lastBaselineError = `http_${response.status}`;
                }
            }
            this.emit('baseline', { success: response.ok, payload });
            return response.ok;
        }
        catch (err) {
            // @silent-fallback-ok — telemetry failure must never affect agent operation
            this.lastBaselineError = 'network_error';
            this.emit('baseline', { success: false });
            return false;
        }
    }
    /**
     * Log full Baseline submission payload for user transparency.
     * 30-day rolling retention.
     */
    logBaselineSubmission(payload, responseStatus) {
        try {
            const logDir = path.join(this.config.stateDir, 'telemetry');
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
            const logFile = path.join(logDir, 'submissions.jsonl');
            const entry = {
                timestamp: new Date().toISOString(),
                payload,
                endpoint: 'v1/telemetry',
                responseStatus,
            };
            fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
            // Rotate entries older than 30 days
            this.rotateBaselineLog(logFile);
        }
        catch {
            // Logging failure is not critical
        }
    }
    /**
     * Remove submission log entries older than 30 days.
     */
    rotateBaselineLog(logFile) {
        try {
            const content = fs.readFileSync(logFile, 'utf-8').trim();
            if (!content)
                return;
            const cutoff = new Date(Date.now() - BASELINE_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
            const lines = content.split('\n');
            const fresh = lines.filter(line => {
                try {
                    const entry = JSON.parse(line);
                    return entry.timestamp && entry.timestamp >= cutoff;
                }
                catch {
                    // @silent-fallback-ok — malformed log line is safely skipped during filtering
                    return false;
                }
            });
            if (fresh.length < lines.length) {
                fs.writeFileSync(logFile, fresh.join('\n') + (fresh.length > 0 ? '\n' : ''));
            }
        }
        catch {
            // Rotation failure is not critical
        }
    }
    /**
     * Get Baseline-specific status for the /telemetry/status endpoint.
     */
    getBaselineStatus() {
        const nextWindow = this.lastBaselineSubmission
            ? new Date(this.lastBaselineSubmission.getTime() + this.config.intervalMs).toISOString()
            : null;
        return {
            provisioned: this.auth.isProvisioned(),
            installationIdPrefix: this.auth.getInstallationIdPrefix(),
            lastSubmission: this.lastBaselineSubmission?.toISOString() ?? null,
            nextWindow,
            lastErrorCode: this.lastBaselineError,
            hasCollector: this.collector !== null,
        };
    }
    /**
     * Read the latest Baseline submission from the transparency log.
     */
    getLatestBaselineSubmission() {
        try {
            const logFile = path.join(this.config.stateDir, 'telemetry', 'submissions.jsonl');
            if (!fs.existsSync(logFile))
                return null;
            const content = fs.readFileSync(logFile, 'utf-8').trim();
            if (!content)
                return null;
            const lines = content.split('\n');
            const lastLine = lines[lines.length - 1];
            return JSON.parse(lastLine);
        }
        catch {
            // @silent-fallback-ok — missing or corrupt log file returns null gracefully
            return null;
        }
    }
    /**
     * Read all Baseline submissions from the transparency log.
     */
    getBaselineSubmissions(limit = 50, offset = 0) {
        try {
            const logFile = path.join(this.config.stateDir, 'telemetry', 'submissions.jsonl');
            if (!fs.existsSync(logFile))
                return [];
            const content = fs.readFileSync(logFile, 'utf-8').trim();
            if (!content)
                return [];
            const lines = content.split('\n');
            // Most recent first
            const reversed = lines.reverse();
            return reversed.slice(offset, offset + limit).map(line => JSON.parse(line));
        }
        catch {
            // @silent-fallback-ok — missing or corrupt log file returns empty array gracefully
            return [];
        }
    }
    /**
     * Get the TelemetryAuth instance (for enable/disable operations).
     */
    getAuth() {
        return this.auth;
    }
    // ── Internal Helpers ─────────────────────────────────────────────
    /**
     * Compute a stable, anonymous installation ID.
     * Hash of machine ID + project directory = unique per install, not reversible.
     */
    computeInstallId() {
        const machineId = this.getMachineId();
        const hash = createHash('sha256')
            .update(machineId)
            .update(this.config.projectDir)
            .digest('hex')
            .slice(0, 16); // 16 hex chars = 64 bits of entropy (plenty for dedup)
        return hash;
    }
    getMachineId() {
        // Try reading machine-id (Linux)
        try {
            return fs.readFileSync('/etc/machine-id', 'utf-8').trim();
        }
        catch { } // @silent-fallback-ok — /etc/machine-id absent on non-Linux; falls through to macOS method
        // macOS: use hardware UUID
        try {
            const output = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf-8' });
            const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
            if (match)
                return match[1];
        }
        catch { } // @silent-fallback-ok — ioreg unavailable on non-macOS; falls through to hostname fallback
        // Fallback: hostname + homedir (less unique but still useful)
        return `${os.hostname()}-${os.homedir()}`;
    }
    /**
     * Log heartbeats locally so users can verify exactly what's being sent.
     * Transparency is a core design principle.
     */
    logHeartbeat(payload, success) {
        try {
            const logDir = path.join(this.config.stateDir, 'telemetry');
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
            const logFile = path.join(logDir, 'heartbeats.jsonl');
            const entry = { ...payload, _sent: success, _at: new Date().toISOString() };
            fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
        }
        catch {
            // Logging failure is not critical
        }
    }
    // ── Status / Inspection ──────────────────────────────────────────
    getStatus() {
        return {
            enabled: this.config.enabled,
            level: this.config.level,
            installId: this.installId,
            intervalMs: this.config.intervalMs,
            endpoint: this.config.endpoint,
            counters: { ...this.counters },
            baseline: this.getBaselineStatus(),
        };
    }
}
//# sourceMappingURL=TelemetryHeartbeat.js.map