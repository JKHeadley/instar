/**
 * FeatureRegistry — Central registry for opt-in features with discovery state tracking.
 *
 * Part of the Consent & Discovery Framework (Phase 1: Feature Registry).
 *
 * Architecture:
 *   - FeatureDefinition: Static metadata defined in code (never changes at runtime)
 *   - FeatureState: Per-user dynamic state stored in SQLite (discovery.db)
 *   - Bootstrap: Existing enabled features start as discoveryState: 'enabled'
 *
 * The registry separates definitions from state following the LaunchDarkly pattern:
 * definitions are always available, state syncs best-effort.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
/** Max declines before a feature goes permanently quiet (server-enforced) */
const MAX_DECLINES = 3;
// ── Valid Transitions ────────────────────────────────────────────────
const VALID_TRANSITIONS = {
    undiscovered: ['aware'],
    aware: ['interested', 'deferred', 'declined'],
    interested: ['enabled'],
    deferred: ['aware'],
    declined: ['aware'],
    enabled: ['disabled'],
    disabled: ['enabled'],
};
/** Tiers requiring a consent record before enabling */
const CONSENT_REQUIRED_TIERS = new Set(['network', 'self-governing']);
const SCHEMA_VERSION = '4';
// ── Registry ─────────────────────────────────────────────────────────
export class FeatureRegistry {
    db = null;
    dbPath;
    stateDir;
    definitions = new Map();
    hmacKey = null;
    constructor(stateDir, opts) {
        this.stateDir = stateDir;
        this.dbPath = path.join(stateDir, 'discovery.db');
        this.hmacKey = opts?.hmacKey ?? null;
    }
    /**
     * Set the HMAC key for consent record signing (can be set after construction).
     */
    setHmacKey(key) {
        this.hmacKey = key;
    }
    // ── Lifecycle ────────────────────────────────────────────────────
    /**
     * Open the database and create schema if needed.
     */
    async open() {
        if (this.db)
            return;
        const BetterSqlite3 = (await import('better-sqlite3')).default;
        const dir = path.dirname(this.dbPath);
        fs.mkdirSync(dir, { recursive: true });
        this.db = new BetterSqlite3(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('busy_timeout = 5000');
        this.createSchema();
    }
    /**
     * Close the database cleanly.
     */
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
    isReady() {
        return this.db !== null;
    }
    // ── Feature Registration ─────────────────────────────────────────
    /**
     * Register a feature definition. Called at startup to populate the registry.
     */
    register(definition) {
        this.definitions.set(definition.id, definition);
    }
    /**
     * Get a feature definition by ID.
     */
    getDefinition(id) {
        return this.definitions.get(id);
    }
    /**
     * Get all registered definitions.
     */
    getAllDefinitions() {
        return Array.from(this.definitions.values());
    }
    // ── State Management ─────────────────────────────────────────────
    /**
     * Get the state for a specific feature and user.
     * Creates a default 'undiscovered' state if none exists.
     */
    getState(featureId, userId = 'default') {
        if (!this.db)
            return null;
        const def = this.definitions.get(featureId);
        if (!def)
            return null;
        const row = this.db.prepare('SELECT * FROM feature_state WHERE user_id = ? AND feature_id = ?').get(userId, featureId);
        if (row) {
            return {
                userId: row.user_id,
                featureId: row.feature_id,
                enabled: !!row.enabled,
                discoveryState: row.discovery_state,
                lastSurfacedAt: row.last_surfaced_at,
                surfaceCount: row.surface_count,
                lastDeclinedAt: row.last_declined_at,
                consentRecordId: row.consent_record_id,
                declineCount: row.decline_count ?? 0,
                declinedAtVersion: row.declined_at_version ?? null,
            };
        }
        // Return default state without persisting — lazy creation
        return {
            userId,
            featureId,
            enabled: false,
            discoveryState: 'undiscovered',
            lastSurfacedAt: null,
            surfaceCount: 0,
            lastDeclinedAt: null,
            consentRecordId: null,
            declineCount: 0,
            declinedAtVersion: null,
        };
    }
    /**
     * Get combined definition + state for a feature.
     */
    getFeatureInfo(featureId, userId = 'default') {
        const definition = this.definitions.get(featureId);
        if (!definition)
            return null;
        const state = this.getState(featureId, userId);
        if (!state)
            return null;
        return { definition, state };
    }
    /**
     * Get all features with their states for a user.
     */
    getAllFeatures(userId = 'default') {
        return this.getAllDefinitions().map(def => ({
            definition: def,
            state: this.getState(def.id, userId),
        }));
    }
    /**
     * Get features filtered by discovery state(s).
     */
    getFeaturesByState(states, userId = 'default') {
        return this.getAllFeatures(userId).filter(f => states.includes(f.state.discoveryState));
    }
    /**
     * Get lightweight summaries of all features.
     */
    getSummaries(userId = 'default') {
        return this.getAllDefinitions().map(def => {
            const state = this.getState(def.id, userId);
            return {
                id: def.id,
                name: def.name,
                category: def.category,
                consentTier: def.consentTier,
                enabled: state?.enabled ?? false,
                discoveryState: state?.discoveryState ?? 'undiscovered',
            };
        });
    }
    /**
     * Get valid transitions for a feature's current state.
     */
    getValidTransitions(featureId, userId = 'default') {
        const state = this.getState(featureId, userId);
        if (!state)
            return [];
        return VALID_TRANSITIONS[state.discoveryState] ?? [];
    }
    // ── State Mutations ──────────────────────────────────────────────
    /**
     * Upsert feature state directly (used for bootstrapping).
     */
    setState(featureId, userId, updates) {
        if (!this.db)
            return null;
        if (!this.definitions.has(featureId))
            return null;
        const current = this.getState(featureId, userId);
        const merged = { ...current, ...updates, featureId, userId };
        this.db.prepare(`
      INSERT INTO feature_state (user_id, feature_id, enabled, discovery_state, last_surfaced_at, surface_count, last_declined_at, consent_record_id, decline_count, declined_at_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, feature_id) DO UPDATE SET
        enabled = excluded.enabled,
        discovery_state = excluded.discovery_state,
        last_surfaced_at = excluded.last_surfaced_at,
        surface_count = excluded.surface_count,
        last_declined_at = excluded.last_declined_at,
        consent_record_id = excluded.consent_record_id,
        decline_count = excluded.decline_count,
        declined_at_version = excluded.declined_at_version,
        updated_at = datetime('now')
    `).run(merged.userId, merged.featureId, merged.enabled ? 1 : 0, merged.discoveryState, merged.lastSurfacedAt, merged.surfaceCount, merged.lastDeclinedAt, merged.consentRecordId, merged.declineCount, merged.declinedAtVersion);
        return merged;
    }
    // ── Phase 2: Transitions ─────────────────────────────────────────
    /**
     * Execute a validated state transition.
     * Returns a TransitionResult indicating success or failure with details.
     */
    transition(featureId, userId, to, opts) {
        if (!this.db)
            return { success: false, featureId, error: { code: 'NOT_READY', message: 'Database not open' } };
        const def = this.definitions.get(featureId);
        if (!def)
            return { success: false, featureId, error: { code: 'FEATURE_NOT_FOUND', message: `Feature '${featureId}' not found` } };
        const current = this.getState(featureId, userId);
        const valid = VALID_TRANSITIONS[current.discoveryState] ?? [];
        if (!valid.includes(to)) {
            return {
                success: false,
                featureId,
                error: {
                    code: 'INVALID_TRANSITION',
                    message: `Cannot transition from '${current.discoveryState}' to '${to}'`,
                    details: { currentState: current.discoveryState, validTransitions: valid },
                },
            };
        }
        // Block declined → aware when maxDeclines reached — UNLESS the feature version changed
        if (current.discoveryState === 'declined' && to === 'aware' && current.declineCount >= MAX_DECLINES) {
            // Version-aware escape: if the feature has been updated since the decline, allow re-surfacing
            const versionChanged = current.declinedAtVersion && current.declinedAtVersion !== def.featureVersion;
            if (!versionChanged) {
                return {
                    success: false,
                    featureId,
                    error: {
                        code: 'MAX_DECLINES_REACHED',
                        message: `Feature '${featureId}' has been declined ${current.declineCount} times (max: ${MAX_DECLINES}). It is permanently quiet until the feature is updated. Use /capabilities to re-discover.`,
                        details: { currentState: current.discoveryState, validTransitions: [] },
                    },
                };
            }
            // Version changed — allow re-surfacing but keep declineCount (it doesn't reset)
        }
        // Consent record required for enabling network/self-governing features
        if (to === 'enabled' && CONSENT_REQUIRED_TIERS.has(def.consentTier) && !opts?.consentRecord) {
            return {
                success: false,
                featureId,
                error: {
                    code: 'CONSENT_REQUIRED',
                    message: `Enabling '${featureId}' (${def.consentTier} tier) requires a consent record`,
                },
            };
        }
        // Self-governing tier requires activation challenge (server-side user verification)
        if (to === 'enabled' && def.consentTier === 'self-governing') {
            if (!opts?.activationChallenge) {
                // Generate and return a challenge token — the agent must present this back
                // with user confirmation to complete the transition
                const challenge = this.generateActivationChallenge(featureId, userId);
                return {
                    success: false,
                    featureId,
                    error: {
                        code: 'ACTIVATION_CHALLENGE_REQUIRED',
                        message: `Self-governing feature '${featureId}' requires user verification. Present this challenge to the user and include their confirmation.`,
                        details: {
                            currentState: current.discoveryState,
                            validTransitions: valid,
                            challenge,
                        },
                    },
                };
            }
            // Verify the challenge
            if (!this.verifyActivationChallenge(featureId, userId, opts.activationChallenge)) {
                return {
                    success: false,
                    featureId,
                    error: {
                        code: 'INVALID_ACTIVATION_CHALLENGE',
                        message: `Activation challenge verification failed for '${featureId}'. Challenge may be expired or invalid.`,
                    },
                };
            }
        }
        // Validate consent record if provided
        if (to === 'enabled' && opts?.consentRecord) {
            const validation = this.validateConsentRecord(opts.consentRecord, def);
            if (validation) {
                return {
                    success: false,
                    featureId,
                    error: { code: 'INVALID_CONSENT_RECORD', message: validation },
                };
            }
        }
        const now = new Date().toISOString();
        const previousState = current.discoveryState;
        // Build state updates
        const updates = { discoveryState: to };
        if (to === 'enabled') {
            updates.enabled = true;
            if (opts?.consentRecord) {
                const recordId = this.storeConsentRecord(opts.consentRecord);
                updates.consentRecordId = recordId;
            }
        }
        else if (to === 'disabled') {
            updates.enabled = false;
        }
        else if (to === 'declined') {
            updates.lastDeclinedAt = now;
            updates.declineCount = (current.declineCount || 0) + 1;
            updates.declinedAtVersion = def.featureVersion;
        }
        this.setState(featureId, userId, updates);
        // Log the event
        this.logDiscoveryEvent({
            timestamp: now,
            userId,
            featureId,
            previousState,
            newState: to,
            trigger: opts?.trigger,
            context: opts?.context,
        });
        return { success: true, featureId, previousState, newState: to, timestamp: now };
    }
    /**
     * Record that a feature was surfaced to the user.
     * Increments surface count and updates last surfaced timestamp.
     */
    recordSurface(featureId, userId, opts) {
        if (!this.db)
            return { success: false, featureId, error: { code: 'NOT_READY', message: 'Database not open' } };
        const def = this.definitions.get(featureId);
        if (!def)
            return { success: false, featureId, error: { code: 'FEATURE_NOT_FOUND', message: `Feature '${featureId}' not found` } };
        const current = this.getState(featureId, userId);
        const now = new Date().toISOString();
        this.setState(featureId, userId, {
            lastSurfacedAt: now,
            surfaceCount: current.surfaceCount + 1,
        });
        this.logDiscoveryEvent({
            timestamp: now,
            userId,
            featureId,
            previousState: current.discoveryState,
            newState: current.discoveryState,
            trigger: opts?.trigger,
            surfacedAs: opts?.surfacedAs,
            context: opts?.context ?? 'surfaced',
        });
        return { success: true, featureId, previousState: current.discoveryState, newState: current.discoveryState, timestamp: now };
    }
    // ── Consent Records ─────────────────────────────────────────────
    /**
     * Store a consent record and return its ID.
     */
    storeConsentRecord(record) {
        if (!this.db)
            throw new Error('Database not open');
        const id = record.id || `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const dataImplStr = JSON.stringify(record.dataImplications);
        // HMAC signing for tamper detection
        const signature = this.signConsentRecord(id, record.userId, record.featureId, record.consentedAt, dataImplStr);
        this.db.prepare(`
      INSERT INTO consent_records (id, user_id, feature_id, consent_tier, data_implications, consented_at, mechanism, signature)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, record.userId, record.featureId, record.consentTier, dataImplStr, record.consentedAt, record.mechanism, signature);
        return id;
    }
    /**
     * Get consent records for a user.
     */
    getConsentRecords(userId) {
        if (!this.db)
            return [];
        const rows = this.db.prepare('SELECT * FROM consent_records WHERE user_id = ? ORDER BY consented_at DESC').all(userId);
        return rows.map(r => this.mapConsentRow(r));
    }
    /**
     * Get consent records for a specific feature.
     */
    getConsentRecordsForFeature(featureId, userId) {
        if (!this.db)
            return [];
        const rows = this.db.prepare('SELECT * FROM consent_records WHERE user_id = ? AND feature_id = ? ORDER BY consented_at DESC').all(userId, featureId);
        return rows.map(r => this.mapConsentRow(r));
    }
    /**
     * Map a consent record row and verify HMAC signature integrity.
     */
    mapConsentRow(r) {
        const record = {
            id: r.id,
            userId: r.user_id,
            featureId: r.feature_id,
            consentTier: r.consent_tier,
            dataImplications: JSON.parse(r.data_implications),
            consentedAt: r.consented_at,
            mechanism: r.mechanism,
        };
        // Verify HMAC signature if key is available and signature exists
        if (this.hmacKey && r.signature) {
            const expected = this.signConsentRecord(r.id, r.user_id, r.feature_id, r.consented_at, r.data_implications);
            record.integrityVerified = (expected === r.signature);
        }
        else if (this.hmacKey && !r.signature) {
            // Key available but record unsigned (pre-HMAC record)
            record.integrityVerified = undefined; // indeterminate
        }
        return record;
    }
    // ── Event Log ───────────────────────────────────────────────────
    /**
     * Log a discovery event to the JSONL audit trail.
     */
    logDiscoveryEvent(event) {
        try {
            const logDir = path.join(this.stateDir, 'state');
            fs.mkdirSync(logDir, { recursive: true });
            const logPath = path.join(logDir, 'discovery-events.jsonl');
            fs.appendFileSync(logPath, JSON.stringify(event) + '\n');
        }
        catch {
            // Non-blocking — event logging should never break operations
        }
    }
    /**
     * Read discovery events, optionally filtered by user and/or feature.
     */
    getDiscoveryEvents(opts) {
        try {
            const logPath = path.join(this.stateDir, 'state', 'discovery-events.jsonl');
            if (!fs.existsSync(logPath))
                return [];
            const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
            let events = lines.map(l => JSON.parse(l));
            if (opts?.userId)
                events = events.filter(e => e.userId === opts.userId);
            if (opts?.featureId)
                events = events.filter(e => e.featureId === opts.featureId);
            // Most recent first
            events.reverse();
            if (opts?.limit)
                events = events.slice(0, opts.limit);
            return events;
        }
        catch {
            return [];
        }
    }
    // ── Right to Erasure ────────────────────────────────────────────
    /**
     * Delete all discovery data for a user.
     * Consent records are preserved (legal requirement) unless forceDeleteConsent is true.
     */
    eraseDiscoveryData(userId, opts) {
        if (!this.db)
            return { deleted: 0, consentRecordsPreserved: 0, consentRecordsAnonymized: 0 };
        const stateResult = this.db.prepare('DELETE FROM feature_state WHERE user_id = ?').run(userId);
        let consentRecordsPreserved = 0;
        let consentRecordsAnonymized = 0;
        if (opts?.forceDeleteConsent) {
            this.db.prepare('DELETE FROM consent_records WHERE user_id = ?').run(userId);
        }
        else {
            // Anonymize consent records instead of preserving with userId intact.
            // This resolves the right-to-erasure vs "consent proof never deleted" tension:
            // the consent proof is preserved (for legal/compliance) but de-identified.
            const anonymizedId = crypto.createHash('sha256').update(`anonymized:${userId}:${Date.now()}`).digest('hex').slice(0, 16);
            const result = this.db.prepare('UPDATE consent_records SET user_id = ? WHERE user_id = ?').run(`anon-${anonymizedId}`, userId);
            consentRecordsAnonymized = result.changes;
            consentRecordsPreserved = result.changes;
        }
        // Anonymize event log entries (replace userId, don't delete — preserves aggregate analytics)
        try {
            const logPath = path.join(this.stateDir, 'state', 'discovery-events.jsonl');
            if (fs.existsSync(logPath)) {
                const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
                const processed = lines.map(l => {
                    try {
                        const event = JSON.parse(l);
                        if (event.userId === userId) {
                            event.userId = 'erased';
                        }
                        return JSON.stringify(event);
                    }
                    catch {
                        return l;
                    }
                });
                fs.writeFileSync(logPath, processed.length > 0 ? processed.join('\n') + '\n' : '');
            }
        }
        catch { /* non-blocking */ }
        return { deleted: stateResult.changes, consentRecordsPreserved, consentRecordsAnonymized };
    }
    // ── Phase 5: Analytics & Observability ──────────────────────────
    /**
     * Get funnel metrics: count of features in each discovery state.
     */
    getFunnelMetrics(userId = 'default') {
        const counts = {
            undiscovered: 0, aware: 0, interested: 0, deferred: 0,
            declined: 0, enabled: 0, disabled: 0,
        };
        for (const info of this.getAllFeatures(userId)) {
            counts[info.state.discoveryState]++;
        }
        return counts;
    }
    /**
     * Get cooldown status for all features.
     * Returns which features are in cooldown (recently surfaced or declined)
     * and when the cooldown expires.
     */
    getCooldownStatuses(userId = 'default') {
        const statuses = [];
        for (const info of this.getAllFeatures(userId)) {
            const { definition: def, state } = info;
            const maxSurfaces = def.discoveryTriggers.length > 0
                ? Math.min(...def.discoveryTriggers.map(t => t.maxSurfacesBeforeQuiet))
                : 3;
            const quieted = state.surfaceCount >= maxSurfaces;
            let cooldownExpiresAt = null;
            if (state.lastSurfacedAt && def.discoveryTriggers.length > 0) {
                const cooldownMs = Math.max(...def.discoveryTriggers.map(t => state.discoveryState === 'declined' ? t.cooldownAfterDeclineMs : t.cooldownAfterSurfaceMs));
                const expires = new Date(new Date(state.lastSurfacedAt).getTime() + cooldownMs);
                if (expires.getTime() > Date.now()) {
                    cooldownExpiresAt = expires.toISOString();
                }
            }
            statuses.push({
                featureId: def.id,
                featureName: def.name,
                discoveryState: state.discoveryState,
                surfaceCount: state.surfaceCount,
                maxSurfaces,
                quieted,
                lastSurfacedAt: state.lastSurfacedAt,
                lastDeclinedAt: state.lastDeclinedAt,
                cooldownExpiresAt,
            });
        }
        return statuses;
    }
    /**
     * Get disabled features that have a newer version than when they were disabled.
     * Useful for "features you turned off that have changed" digest.
     */
    getChangedDisabledFeatures(userId = 'default') {
        const results = [];
        for (const info of this.getAllFeatures(userId)) {
            if (info.state.discoveryState !== 'disabled')
                continue;
            // Any disabled feature with a version > 1.0.0 may have changed since disable
            // In practice, compare version at time of disable vs current. For now, surface all disabled.
            results.push({
                featureId: info.definition.id,
                featureName: info.definition.name,
                currentVersion: info.definition.featureVersion,
                disabledAt: info.state.lastDeclinedAt,
            });
        }
        return results;
    }
    /**
     * Negative discovery: identify enabled features that haven't been "used"
     * (surfaced or transitioned) in over N days. Suggests disabling unused features.
     */
    getUnusedEnabledFeatures(userId = 'default', thresholdDays = 15) {
        const results = [];
        const now = Date.now();
        const events = this.getDiscoveryEvents({ userId });
        for (const info of this.getAllFeatures(userId)) {
            if (info.state.discoveryState !== 'enabled')
                continue;
            // Find the most recent event for this feature
            const featureEvents = events.filter(e => e.featureId === info.definition.id);
            const lastActivity = featureEvents.length > 0
                ? new Date(featureEvents[0].timestamp).getTime()
                : null;
            // If no events at all, use the state's created timestamp (not available directly, so use null)
            const daysSince = lastActivity
                ? Math.floor((now - lastActivity) / (1000 * 60 * 60 * 24))
                : thresholdDays + 1; // No activity = over threshold
            if (daysSince >= thresholdDays) {
                results.push({
                    featureId: info.definition.id,
                    featureName: info.definition.name,
                    enabledSince: info.state.lastSurfacedAt,
                    daysSinceActivity: daysSince,
                });
            }
        }
        return results;
    }
    /**
     * Get comprehensive discovery analytics for the dashboard.
     */
    getAnalytics(userId = 'default') {
        const funnel = this.getFunnelMetrics(userId);
        const totalFeatures = Object.values(funnel).reduce((a, b) => a + b, 0);
        const enabledCount = funnel.enabled;
        const discoveredCount = totalFeatures - funnel.undiscovered;
        const discoveryRate = totalFeatures > 0 ? discoveredCount / totalFeatures : 0;
        return {
            funnel,
            totalFeatures,
            enabledCount,
            discoveryRate,
            cooldowns: this.getCooldownStatuses(userId),
            changedDisabled: this.getChangedDisabledFeatures(userId),
            unusedEnabled: this.getUnusedEnabledFeatures(userId),
            recentEvents: this.getDiscoveryEvents({ userId, limit: 50 }),
        };
    }
    // ── Bootstrap ────────────────────────────────────────────────────
    /**
     * Bootstrap feature states from the current config.
     * Features with enabled: true in config start as discoveryState: 'enabled'.
     * Everything else starts as 'undiscovered'.
     *
     * Note: We read config.json directly because loadConfig() only returns a subset
     * of fields. Features like gitBackup, externalOperations, evolution are read
     * from config.json but not included in the InstarConfig return value.
     */
    bootstrap(config, userId = 'default') {
        if (!this.db)
            return;
        // Merge passed config with raw config.json for complete coverage
        let rawConfig = {};
        try {
            const configPath = path.join(this.stateDir, 'config.json');
            if (fs.existsSync(configPath)) {
                rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            }
        }
        catch { /* @silent-fallback-ok — best-effort config read, falls through to passed config */ }
        // Raw config takes precedence for fields not in the parsed config
        const mergedConfig = { ...rawConfig, ...config };
        for (const def of this.definitions.values()) {
            const isEnabled = this.resolveConfigValue(mergedConfig, def.configPath);
            const existingRow = this.db.prepare('SELECT discovery_state, enabled FROM feature_state WHERE user_id = ? AND feature_id = ?').get(userId, def.id);
            if (!existingRow) {
                // New feature — bootstrap from config
                if (isEnabled) {
                    this.setState(def.id, userId, {
                        enabled: true,
                        discoveryState: 'enabled',
                    });
                }
                // If not enabled, leave as default (undiscovered, created lazily)
            }
            else if (isEnabled && existingRow.discovery_state === 'undiscovered') {
                // Feature was undiscovered but is now enabled in config — sync state
                this.setState(def.id, userId, {
                    enabled: true,
                    discoveryState: 'enabled',
                });
            }
            else if (!isEnabled && existingRow.enabled) {
                // Feature was enabled but is no longer in config — mark disabled
                this.setState(def.id, userId, {
                    enabled: false,
                    discoveryState: 'disabled',
                });
            }
        }
    }
    /**
     * Resolve a dot-notation config path to a boolean indicating if the feature is enabled.
     */
    resolveConfigValue(config, configPath) {
        const parts = configPath.split('.');
        let current = config;
        for (const part of parts) {
            if (current == null || typeof current !== 'object')
                return false;
            current = current[part];
        }
        // If the path resolves to an object with an 'enabled' field, use that
        if (current != null && typeof current === 'object' && 'enabled' in current) {
            return !!current.enabled;
        }
        // If the path resolves to a boolean, use directly
        if (typeof current === 'boolean')
            return current;
        // If the config key exists and is truthy (non-null object), consider it enabled
        return current != null && typeof current === 'object';
    }
    // ── Activation Challenge (Self-Governing Tier) ─────────────────
    /** Pending challenges: featureId:userId → { token, expiresAt } */
    activationChallenges = new Map();
    /**
     * Generate a time-limited activation challenge for self-governing features.
     * The challenge must be presented back with user confirmation within 10 minutes.
     */
    generateActivationChallenge(featureId, userId) {
        const token = crypto.randomBytes(16).toString('hex');
        const key = `${featureId}:${userId}`;
        this.activationChallenges.set(key, {
            token,
            expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
        });
        return token;
    }
    /**
     * Verify an activation challenge. Consumes the challenge on success.
     */
    verifyActivationChallenge(featureId, userId, challenge) {
        const key = `${featureId}:${userId}`;
        const pending = this.activationChallenges.get(key);
        if (!pending)
            return false;
        if (Date.now() > pending.expiresAt) {
            this.activationChallenges.delete(key);
            return false;
        }
        if (pending.token !== challenge)
            return false;
        // Consume the challenge — one-time use
        this.activationChallenges.delete(key);
        return true;
    }
    // ── HMAC Signing ───────────────────────────────────────────────
    /**
     * Sign a consent record's canonical fields with HMAC-SHA256.
     * Returns null if no HMAC key is configured.
     */
    signConsentRecord(id, userId, featureId, consentedAt, dataImplications) {
        if (!this.hmacKey)
            return null;
        const canonical = `${id}:${userId}:${featureId}:${consentedAt}:${dataImplications}`;
        return crypto.createHmac('sha256', this.hmacKey).update(canonical).digest('hex');
    }
    // ── Consent Validation ─────────────────────────────────────────
    /**
     * Validate a consent record before storing. Returns error message or null if valid.
     * Server-enforced: prevents empty disclosures, backdated timestamps, invalid mechanisms.
     */
    validateConsentRecord(record, definition) {
        const VALID_MECHANISMS = new Set(['explicit-verbal', 'explicit-written', 'profile-blanket']);
        // Mechanism must be valid enum
        if (!VALID_MECHANISMS.has(record.mechanism)) {
            return `Invalid consent mechanism '${record.mechanism}'. Must be: ${[...VALID_MECHANISMS].join(', ')}`;
        }
        // For network/self-governing tiers, dataImplications must be non-empty
        if (CONSENT_REQUIRED_TIERS.has(definition.consentTier)) {
            if (!record.dataImplications || record.dataImplications.length === 0) {
                return `Consent record for ${definition.consentTier}-tier feature '${definition.id}' must include non-empty dataImplications`;
            }
        }
        // consentedAt must not be backdated more than 5 minutes
        if (record.consentedAt) {
            const consentTime = new Date(record.consentedAt).getTime();
            const now = Date.now();
            const fiveMinutesMs = 5 * 60 * 1000;
            if (consentTime < now - fiveMinutesMs) {
                return `Consent timestamp is backdated more than 5 minutes (consentedAt: ${record.consentedAt})`;
            }
            // Also reject future-dated by more than 1 minute (clock skew tolerance)
            if (consentTime > now + 60_000) {
                return `Consent timestamp is in the future (consentedAt: ${record.consentedAt})`;
            }
        }
        // featureId must match the feature being enabled
        if (record.featureId !== definition.id) {
            return `Consent record featureId '${record.featureId}' does not match target feature '${definition.id}'`;
        }
        return null;
    }
    // ── Schema ───────────────────────────────────────────────────────
    createSchema() {
        if (!this.db)
            throw new Error('Database not open');
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS feature_state (
        user_id TEXT NOT NULL DEFAULT 'default',
        feature_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        discovery_state TEXT NOT NULL DEFAULT 'undiscovered',
        last_surfaced_at TEXT,
        surface_count INTEGER NOT NULL DEFAULT 0,
        last_declined_at TEXT,
        consent_record_id TEXT,
        decline_count INTEGER NOT NULL DEFAULT 0,
        declined_at_version TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, feature_id)
      );

      CREATE INDEX IF NOT EXISTS idx_feature_state_discovery
        ON feature_state(discovery_state);

      CREATE INDEX IF NOT EXISTS idx_feature_state_user
        ON feature_state(user_id);

      CREATE TABLE IF NOT EXISTS consent_records (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        feature_id TEXT NOT NULL,
        consent_tier TEXT NOT NULL,
        data_implications TEXT NOT NULL,
        consented_at TEXT NOT NULL,
        mechanism TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_consent_records_user
        ON consent_records(user_id);

      CREATE INDEX IF NOT EXISTS idx_consent_records_feature
        ON consent_records(user_id, feature_id);
    `);
        // Migration: add decline_count column if missing (v2 → v3)
        try {
            this.db.exec('ALTER TABLE feature_state ADD COLUMN decline_count INTEGER NOT NULL DEFAULT 0');
        }
        catch {
            // Column already exists — expected
        }
        // Migration: add declined_at_version column if missing (v3 → v4)
        try {
            this.db.exec('ALTER TABLE feature_state ADD COLUMN declined_at_version TEXT');
        }
        catch {
            // Column already exists — expected
        }
        // Migration: add signature column to consent_records if missing (v2 → v3)
        try {
            this.db.exec('ALTER TABLE consent_records ADD COLUMN signature TEXT');
        }
        catch {
            // Column already exists — expected
        }
        // Set schema version
        this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
    }
}
//# sourceMappingURL=FeatureRegistry.js.map