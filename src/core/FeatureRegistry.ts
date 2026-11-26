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

import { registerSqliteHandle } from './SqliteRegistry.js';
import type { FeatureApplyResult } from './FeatureActionApplier.js';

// Dynamic import for better-sqlite3
type Database = import('better-sqlite3').Database;

// ── Types ────────────────────────────────────────────────────────────

export type FeatureCategory = 'communication' | 'safety' | 'intelligence' | 'infrastructure';

export type ConsentTier =
  | 'informational'   // No data implications, just a UX choice
  | 'local'           // Data stays on machine
  | 'network'         // Data leaves the machine
  | 'self-governing'; // Agent acts without confirmation

export type DiscoveryState =
  | 'undiscovered'
  | 'aware'
  | 'interested'
  | 'deferred'
  | 'declined'
  | 'enabled'
  | 'disabled';

export type TriggerType =
  | 'problem-match'
  | 'question-match'
  | 'usage-pattern'
  | 'capability-query'
  | 'explicit-ask';

export interface EnableAction {
  method: 'PATCH' | 'POST';
  path: string;
  body: Record<string, unknown>;
}

export interface DataImplication {
  dataType: string;
  destination: 'local' | 'anthropic-cli' | 'cloudflare' | 'custom';
  retention?: string;
  description: string;
}

export interface DiscoveryTrigger {
  type: TriggerType;
  condition: string;
  surfaceAs: 'awareness' | 'suggestion' | 'prompt';
  messageTemplate: string;
  cooldownAfterSurfaceMs: number;
  cooldownAfterDeclineMs: number;
  maxSurfacesBeforeQuiet: number;
}

/** Static — defined in code, never changes at runtime */
export interface FeatureDefinition {
  id: string;
  name: string;
  category: FeatureCategory;
  featureVersion: string;

  // Config binding
  configPath: string;            // Dot-notation path into InstarConfig
  /** The feature's consumer treats an ABSENT key as on (e.g. `enabled !== false`). Default false. */
  defaultOn?: boolean;
  /** When set, the key counts as on only when it equals this value (e.g. approvalMode === 'autonomous'). */
  configEnabledValue?: unknown;
  /** A plain sentence appended to the shown state where the runtime's real behaviour differs from the key. */
  honestyNote?: string;
  /** false = the runtime ignores this key, so the switch is read-only (the transition route refuses enable/disable). */
  switchable?: boolean;
  enableAction: EnableAction;
  disableAction: EnableAction;

  // Discovery metadata
  oneLiner: string;
  fullDescription: string;
  prerequisiteFeatures?: string[];

  // Consent metadata
  consentTier: ConsentTier;
  dataImplications: DataImplication[];
  reversibilityNote: string;

  // Discovery rules
  discoveryTriggers: DiscoveryTrigger[];
}

/** Dynamic — per-user, stored in SQLite */
export interface FeatureState {
  userId: string;
  featureId: string;
  enabled: boolean;
  discoveryState: DiscoveryState;
  lastSurfacedAt: string | null;
  surfaceCount: number;
  lastDeclinedAt: string | null;
  consentRecordId: string | null;
  /** Number of times the user has declined this feature */
  declineCount: number;
  /** Feature version at time of last decline (for version-aware re-surfacing) */
  declinedAtVersion: string | null;
  /** Result of the last attempt to apply the feature's enable/disable setting change. */
  lastApply: FeatureApplyResult | null;
}

/**
 * What the switch says vs what the agent is doing (spec §2.3).
 * "Running" means the process booted with the setting on — the strongest claim
 * available without a per-feature liveness probe.
 */
export type EffectiveStatus = 'on' | 'off' | 'on-after-restart' | 'off-after-restart' | 'recorded-only' | 'not-recorded';

export interface FeatureEffectiveState {
  /** What the switch says (state.enabled). */
  recorded: boolean;
  /** The config key now (config.json on disk merged over runtime config). */
  configured: boolean;
  /** The config key when this server process started; null when this process never took a boot snapshot. */
  atBoot: boolean | null;
  /** The last attempt to apply the setting change, kept even after a restart reset the switch. */
  lastAttempt: FeatureApplyResult | null;
  status: EffectiveStatus;
  /** One plain sentence for a person (the base sentence plus `detail`, when any). */
  summary: string;
  /** What `summary` adds beyond the plain on/off sentence: a failed attempt and/or an honesty note. Null when nothing. */
  detail: string | null;
}

/** Max declines before a feature goes permanently quiet (server-enforced) */
const MAX_DECLINES = 3;

/** Consent record for high-tier feature activations */
export interface ConsentRecord {
  id: string;
  userId: string;
  featureId: string;
  consentTier: ConsentTier;
  dataImplications: DataImplication[];
  consentedAt: string;
  mechanism: 'explicit-verbal' | 'explicit-written' | 'profile-blanket';
}

/** Discovery event for audit trail */
export interface DiscoveryEvent {
  timestamp: string;
  userId: string;
  featureId: string;
  previousState: DiscoveryState;
  newState: DiscoveryState;
  trigger?: string;
  surfacedAs?: 'awareness' | 'suggestion' | 'prompt';
  context?: string;
}

/** Result of a transition attempt */
export interface TransitionResult {
  success: boolean;
  featureId: string;
  previousState?: DiscoveryState;
  newState?: DiscoveryState;
  timestamp?: string;
  error?: {
    code: string;
    message: string;
    details?: {
      currentState?: DiscoveryState;
      validTransitions?: DiscoveryState[];
    };
  };
}

/** Combined view for API responses */
export interface FeatureInfo {
  definition: FeatureDefinition;
  state: FeatureState;
}

/** Lightweight summary for GET /features/summary */
export interface FeatureSummary {
  id: string;
  name: string;
  category: FeatureCategory;
  consentTier: ConsentTier;
  enabled: boolean;
  discoveryState: DiscoveryState;
  effective?: FeatureEffectiveState;
}

// ── Valid Transitions ────────────────────────────────────────────────

const VALID_TRANSITIONS: Record<DiscoveryState, DiscoveryState[]> = {
  undiscovered: ['aware'],
  aware: ['interested', 'deferred', 'declined'],
  interested: ['enabled'],
  deferred: ['aware'],
  declined: ['aware'],
  enabled: ['disabled'],
  disabled: ['enabled'],
};

/** Tiers requiring a consent record before enabling */
const CONSENT_REQUIRED_TIERS: Set<ConsentTier> = new Set(['network', 'self-governing']);

const SCHEMA_VERSION = '5';

// ── Registry ─────────────────────────────────────────────────────────

export class FeatureRegistry {
  private db: Database | null = null;
  private dbPath: string;
  private stateDir: string;
  private definitions: Map<string, FeatureDefinition> = new Map();
  private hmacKey: string | null = null;
  /** Config value of each feature when this process bootstrapped (spec §2.3 atBoot). */
  private bootValues: Map<string, boolean> = new Map();
  /**
   * Per-feature override of "is the key on in this config?" for a consumer whose
   * default is not in config (autonomous evolution falls back to the autonomy
   * profile). Set by server.ts before bootstrap; used by bootstrap AND the shown
   * state so the two never disagree.
   */
  private configuredResolvers: Map<string, (config: Record<string, unknown>) => boolean> = new Map();

  constructor(stateDir: string, opts?: { hmacKey?: string }) {
    this.stateDir = stateDir;
    this.dbPath = path.join(stateDir, 'discovery.db');
    this.hmacKey = opts?.hmacKey ?? null;
  }

  /**
   * Set the HMAC key for consent record signing (can be set after construction).
   */
  setHmacKey(key: string): void {
    this.hmacKey = key;
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Open the database and create schema if needed.
   */
  async open(): Promise<void> {
    if (this.db) return;

    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });

    this.db = new BetterSqlite3(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    this.createSchema();
    // Close-on-exit registry (SqliteRegistry.ts) — closed once at shutdown.
    registerSqliteHandle(() => { try { this.db?.close(); } catch { /* already closed */ } });
  }

  /**
   * Close the database cleanly.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  isReady(): boolean {
    return this.db !== null;
  }

  // ── Feature Registration ─────────────────────────────────────────

  /**
   * Register a feature definition. Called at startup to populate the registry.
   */
  register(definition: FeatureDefinition): void {
    this.definitions.set(definition.id, definition);
  }

  /**
   * Get a feature definition by ID.
   */
  getDefinition(id: string): FeatureDefinition | undefined {
    return this.definitions.get(id);
  }

  /**
   * Get all registered definitions.
   */
  getAllDefinitions(): FeatureDefinition[] {
    return Array.from(this.definitions.values());
  }

  // ── State Management ─────────────────────────────────────────────

  /**
   * Get the state for a specific feature and user.
   * Creates a default 'undiscovered' state if none exists.
   */
  getState(featureId: string, userId: string = 'default'): FeatureState | null {
    if (!this.db) return null;
    const def = this.definitions.get(featureId);
    if (!def) return null;

    const row = this.db.prepare(
      'SELECT * FROM feature_state WHERE user_id = ? AND feature_id = ?'
    ).get(userId, featureId) as any;

    if (row) {
      return {
        userId: row.user_id,
        featureId: row.feature_id,
        enabled: !!row.enabled,
        discoveryState: row.discovery_state as DiscoveryState,
        lastSurfacedAt: row.last_surfaced_at,
        surfaceCount: row.surface_count,
        lastDeclinedAt: row.last_declined_at,
        consentRecordId: row.consent_record_id,
        declineCount: row.decline_count ?? 0,
        declinedAtVersion: row.declined_at_version ?? null,
        lastApply: parseApply(row.last_apply_json),
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
      lastApply: null,
    };
  }

  /**
   * Get combined definition + state for a feature.
   */
  getFeatureInfo(featureId: string, userId: string = 'default'): FeatureInfo | null {
    const definition = this.definitions.get(featureId);
    if (!definition) return null;
    const state = this.getState(featureId, userId);
    if (!state) return null;
    return { definition, state };
  }

  /**
   * Get all features with their states for a user.
   */
  getAllFeatures(userId: string = 'default'): FeatureInfo[] {
    return this.getAllDefinitions().map(def => ({
      definition: def,
      state: this.getState(def.id, userId)!,
    }));
  }

  /**
   * Get features filtered by discovery state(s).
   */
  getFeaturesByState(states: DiscoveryState[], userId: string = 'default'): FeatureInfo[] {
    return this.getAllFeatures(userId).filter(f => states.includes(f.state.discoveryState));
  }

  /**
   * Get lightweight summaries of all features.
   */
  getSummaries(userId: string = 'default'): FeatureSummary[] {
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
  getValidTransitions(featureId: string, userId: string = 'default'): DiscoveryState[] {
    const state = this.getState(featureId, userId);
    if (!state) return [];
    return VALID_TRANSITIONS[state.discoveryState] ?? [];
  }

  // ── State Mutations ──────────────────────────────────────────────

  /**
   * Upsert feature state directly (used for bootstrapping).
   */
  setState(featureId: string, userId: string, updates: Partial<FeatureState>): FeatureState | null {
    if (!this.db) return null;
    if (!this.definitions.has(featureId)) return null;

    const current = this.getState(featureId, userId)!;
    const merged: FeatureState = { ...current, ...updates, featureId, userId };

    this.db.prepare(`
      INSERT INTO feature_state (user_id, feature_id, enabled, discovery_state, last_surfaced_at, surface_count, last_declined_at, consent_record_id, decline_count, declined_at_version, last_apply_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, feature_id) DO UPDATE SET
        enabled = excluded.enabled,
        discovery_state = excluded.discovery_state,
        last_surfaced_at = excluded.last_surfaced_at,
        surface_count = excluded.surface_count,
        last_declined_at = excluded.last_declined_at,
        consent_record_id = excluded.consent_record_id,
        decline_count = excluded.decline_count,
        declined_at_version = excluded.declined_at_version,
        last_apply_json = excluded.last_apply_json,
        updated_at = datetime('now')
    `).run(
      merged.userId,
      merged.featureId,
      merged.enabled ? 1 : 0,
      merged.discoveryState,
      merged.lastSurfacedAt,
      merged.surfaceCount,
      merged.lastDeclinedAt,
      merged.consentRecordId,
      merged.declineCount,
      merged.declinedAtVersion,
      merged.lastApply ? JSON.stringify(merged.lastApply) : null,
    );

    return merged;
  }

  // ── Phase 2: Transitions ─────────────────────────────────────────

  /**
   * Execute a validated state transition.
   * Returns a TransitionResult indicating success or failure with details.
   */
  transition(
    featureId: string,
    userId: string,
    to: DiscoveryState,
    opts?: {
      trigger?: string;
      consentRecord?: ConsentRecord;
      context?: string;
      /** Challenge token for self-governing tier activation */
      activationChallenge?: string;
    },
  ): TransitionResult {
    if (!this.db) return { success: false, featureId, error: { code: 'NOT_READY', message: 'Database not open' } };

    const def = this.definitions.get(featureId);
    if (!def) return { success: false, featureId, error: { code: 'FEATURE_NOT_FOUND', message: `Feature '${featureId}' not found` } };

    const current = this.getState(featureId, userId)!;
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
            } as any,
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
    const updates: Partial<FeatureState> = { discoveryState: to };

    if (to === 'enabled') {
      updates.enabled = true;
      if (opts?.consentRecord) {
        const recordId = this.storeConsentRecord(opts.consentRecord);
        updates.consentRecordId = recordId;
      }
    } else if (to === 'disabled') {
      updates.enabled = false;
    } else if (to === 'declined') {
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
  recordSurface(
    featureId: string,
    userId: string,
    opts?: { surfacedAs?: 'awareness' | 'suggestion' | 'prompt'; trigger?: string; context?: string },
  ): TransitionResult {
    if (!this.db) return { success: false, featureId, error: { code: 'NOT_READY', message: 'Database not open' } };

    const def = this.definitions.get(featureId);
    if (!def) return { success: false, featureId, error: { code: 'FEATURE_NOT_FOUND', message: `Feature '${featureId}' not found` } };

    const current = this.getState(featureId, userId)!;
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
  storeConsentRecord(record: ConsentRecord): string {
    if (!this.db) throw new Error('Database not open');

    const id = record.id || `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const dataImplStr = JSON.stringify(record.dataImplications);

    // HMAC signing for tamper detection
    const signature = this.signConsentRecord(id, record.userId, record.featureId, record.consentedAt, dataImplStr);

    this.db.prepare(`
      INSERT INTO consent_records (id, user_id, feature_id, consent_tier, data_implications, consented_at, mechanism, signature)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      record.userId,
      record.featureId,
      record.consentTier,
      dataImplStr,
      record.consentedAt,
      record.mechanism,
      signature,
    );

    return id;
  }

  /**
   * Get consent records for a user.
   */
  getConsentRecords(userId: string): Array<ConsentRecord & { integrityVerified?: boolean }> {
    if (!this.db) return [];
    const rows = this.db.prepare(
      'SELECT * FROM consent_records WHERE user_id = ? ORDER BY consented_at DESC'
    ).all(userId) as any[];

    return rows.map(r => this.mapConsentRow(r));
  }

  /**
   * Get consent records for a specific feature.
   */
  getConsentRecordsForFeature(featureId: string, userId: string): Array<ConsentRecord & { integrityVerified?: boolean }> {
    if (!this.db) return [];
    const rows = this.db.prepare(
      'SELECT * FROM consent_records WHERE user_id = ? AND feature_id = ? ORDER BY consented_at DESC'
    ).all(userId, featureId) as any[];

    return rows.map(r => this.mapConsentRow(r));
  }

  /**
   * Map a consent record row and verify HMAC signature integrity.
   */
  private mapConsentRow(r: any): ConsentRecord & { integrityVerified?: boolean } {
    const record: ConsentRecord & { integrityVerified?: boolean } = {
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
    } else if (this.hmacKey && !r.signature) {
      // Key available but record unsigned (pre-HMAC record)
      record.integrityVerified = undefined; // indeterminate
    }

    return record;
  }

  // ── Event Log ───────────────────────────────────────────────────

  /**
   * Log a discovery event to the JSONL audit trail.
   */
  private logDiscoveryEvent(event: DiscoveryEvent): void {
    try {
      const logDir = path.join(this.stateDir, 'state');
      fs.mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, 'discovery-events.jsonl');
      fs.appendFileSync(logPath, JSON.stringify(event) + '\n');
    } catch {
      // Non-blocking — event logging should never break operations
    }
  }

  /**
   * Read discovery events, optionally filtered by user and/or feature.
   */
  getDiscoveryEvents(opts?: { userId?: string; featureId?: string; limit?: number }): DiscoveryEvent[] {
    try {
      const logPath = path.join(this.stateDir, 'state', 'discovery-events.jsonl');
      if (!fs.existsSync(logPath)) return [];
      const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
      let events: DiscoveryEvent[] = lines.map(l => JSON.parse(l));

      if (opts?.userId) events = events.filter(e => e.userId === opts.userId);
      if (opts?.featureId) events = events.filter(e => e.featureId === opts.featureId);

      // Most recent first
      events.reverse();

      if (opts?.limit) events = events.slice(0, opts.limit);
      return events;
    } catch {
      return [];
    }
  }

  // ── Right to Erasure ────────────────────────────────────────────

  /**
   * Delete all discovery data for a user.
   * Consent records are preserved (legal requirement) unless forceDeleteConsent is true.
   */
  eraseDiscoveryData(userId: string, opts?: { forceDeleteConsent?: boolean }): { deleted: number; consentRecordsPreserved: number; consentRecordsAnonymized: number } {
    if (!this.db) return { deleted: 0, consentRecordsPreserved: 0, consentRecordsAnonymized: 0 };

    const stateResult = this.db.prepare('DELETE FROM feature_state WHERE user_id = ?').run(userId);
    let consentRecordsPreserved = 0;
    let consentRecordsAnonymized = 0;

    if (opts?.forceDeleteConsent) {
      this.db.prepare('DELETE FROM consent_records WHERE user_id = ?').run(userId);
    } else {
      // Anonymize consent records instead of preserving with userId intact.
      // This resolves the right-to-erasure vs "consent proof never deleted" tension:
      // the consent proof is preserved (for legal/compliance) but de-identified.
      const anonymizedId = crypto.createHash('sha256').update(`anonymized:${userId}:${Date.now()}`).digest('hex').slice(0, 16);
      const result = this.db.prepare(
        'UPDATE consent_records SET user_id = ? WHERE user_id = ?'
      ).run(`anon-${anonymizedId}`, userId);
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
          } catch { return l; }
        });
        fs.writeFileSync(logPath, processed.length > 0 ? processed.join('\n') + '\n' : '');
      }
    } catch { /* non-blocking */ }

    return { deleted: stateResult.changes, consentRecordsPreserved, consentRecordsAnonymized };
  }

  // ── Phase 5: Analytics & Observability ──────────────────────────

  /**
   * Get funnel metrics: count of features in each discovery state.
   */
  getFunnelMetrics(userId: string = 'default'): Record<DiscoveryState, number> {
    const counts: Record<DiscoveryState, number> = {
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
  getCooldownStatuses(userId: string = 'default'): Array<{
    featureId: string;
    featureName: string;
    discoveryState: DiscoveryState;
    surfaceCount: number;
    maxSurfaces: number;
    quieted: boolean;
    lastSurfacedAt: string | null;
    lastDeclinedAt: string | null;
    cooldownExpiresAt: string | null;
  }> {
    const statuses = [];
    for (const info of this.getAllFeatures(userId)) {
      const { definition: def, state } = info;
      const maxSurfaces = def.discoveryTriggers.length > 0
        ? Math.min(...def.discoveryTriggers.map(t => t.maxSurfacesBeforeQuiet))
        : 3;
      const quieted = state.surfaceCount >= maxSurfaces;

      let cooldownExpiresAt: string | null = null;
      if (state.lastSurfacedAt && def.discoveryTriggers.length > 0) {
        const cooldownMs = Math.max(...def.discoveryTriggers.map(t =>
          state.discoveryState === 'declined' ? t.cooldownAfterDeclineMs : t.cooldownAfterSurfaceMs
        ));
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
  getChangedDisabledFeatures(userId: string = 'default'): Array<{
    featureId: string;
    featureName: string;
    currentVersion: string;
    disabledAt: string | null;
  }> {
    const results = [];
    for (const info of this.getAllFeatures(userId)) {
      if (info.state.discoveryState !== 'disabled') continue;
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
  getUnusedEnabledFeatures(userId: string = 'default', thresholdDays: number = 15): Array<{
    featureId: string;
    featureName: string;
    enabledSince: string | null;
    daysSinceActivity: number;
  }> {
    const results = [];
    const now = Date.now();
    const events = this.getDiscoveryEvents({ userId });

    for (const info of this.getAllFeatures(userId)) {
      if (info.state.discoveryState !== 'enabled') continue;

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
  getAnalytics(userId: string = 'default'): {
    funnel: Record<DiscoveryState, number>;
    totalFeatures: number;
    enabledCount: number;
    discoveryRate: number;
    cooldowns: ReturnType<FeatureRegistry['getCooldownStatuses']>;
    changedDisabled: ReturnType<FeatureRegistry['getChangedDisabledFeatures']>;
    unusedEnabled: ReturnType<FeatureRegistry['getUnusedEnabledFeatures']>;
    recentEvents: DiscoveryEvent[];
  } {
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
  bootstrap(config: Record<string, unknown>, userId: string = 'default'): void {
    if (!this.db) return;

    // Merge passed config with raw config.json for complete coverage
    let rawConfig: Record<string, unknown> = {};
    try {
      const configPath = path.join(this.stateDir, 'config.json');
      if (fs.existsSync(configPath)) {
        rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }
    } catch { /* @silent-fallback-ok — best-effort config read, falls through to passed config */ }

    // Raw config takes precedence for fields not in the parsed config
    const mergedConfig = { ...rawConfig, ...config };

    for (const def of this.definitions.values()) {
      const isEnabled = this.resolveConfigValue(mergedConfig, def);
      this.bootValues.set(def.id, isEnabled);
      const existingRow = this.db.prepare(
        'SELECT discovery_state, enabled FROM feature_state WHERE user_id = ? AND feature_id = ?'
      ).get(userId, def.id) as { discovery_state: string; enabled: number } | undefined;

      if (!existingRow) {
        // New feature — bootstrap from config
        if (isEnabled) {
          this.setState(def.id, userId, {
            enabled: true,
            discoveryState: 'enabled',
          });
        }
        // If not enabled, leave as default (undiscovered, created lazily)
      } else if (isEnabled && existingRow.discovery_state === 'undiscovered') {
        // Feature was undiscovered but is now enabled in config — sync state
        this.setState(def.id, userId, {
          enabled: true,
          discoveryState: 'enabled',
        });
      } else if (!isEnabled && existingRow.enabled) {
        // Feature was enabled but is no longer in config — mark disabled
        this.setState(def.id, userId, {
          enabled: false,
          discoveryState: 'disabled',
        });
      }
    }
  }

  // ── Applied setting + honest state (spec feature-transition-applies-action) ──

  /**
   * Record the result of applying a feature's setting change, and log it next to
   * the transition in the discovery-events audit trail.
   */
  recordApply(featureId: string, userId: string, result: FeatureApplyResult): void {
    if (!this.db || !this.definitions.has(featureId)) return;
    const current = this.getState(featureId, userId)!;
    this.setState(featureId, userId, { lastApply: result });
    this.logDiscoveryEvent({
      timestamp: result.at,
      userId,
      featureId,
      previousState: current.discoveryState,
      newState: current.discoveryState,
      context: `apply:${result.outcome}${result.detail ? ` — ${result.detail}` : ''}`,
    });
  }

  /**
   * The operator's switch (spec §2.4). The caller has already verified a fresh
   * dashboard PIN unlock. Sets enabled/disabled from ANY state, skipping the
   * discovery graph (the operator is setting a switch, not being surfaced to);
   * the switch itself is the consent, so a consent record is written for
   * network / self-governing features.
   */
  operatorSet(featureId: string, userId: string, to: 'enabled' | 'disabled', opts?: { context?: string }): TransitionResult {
    if (!this.db) return { success: false, featureId, error: { code: 'NOT_READY', message: 'Database not open' } };
    const def = this.definitions.get(featureId);
    if (!def) return { success: false, featureId, error: { code: 'FEATURE_NOT_FOUND', message: `Feature '${featureId}' not found` } };
    if (to !== 'enabled' && to !== 'disabled') {
      return { success: false, featureId, error: { code: 'INVALID_TRANSITION', message: `The operator switch only sets 'enabled' or 'disabled'` } };
    }
    const current = this.getState(featureId, userId)!;
    const now = new Date().toISOString();
    const updates: Partial<FeatureState> = { discoveryState: to, enabled: to === 'enabled' };
    if (to === 'enabled' && CONSENT_REQUIRED_TIERS.has(def.consentTier)) {
      updates.consentRecordId = this.storeConsentRecord({
        id: '',
        userId,
        featureId,
        consentTier: def.consentTier,
        dataImplications: def.dataImplications,
        consentedAt: now,
        mechanism: 'explicit-written',
      });
    }
    this.setState(featureId, userId, updates);
    this.logDiscoveryEvent({
      timestamp: now,
      userId,
      featureId,
      previousState: current.discoveryState,
      newState: to,
      trigger: 'operator-switch',
      context: opts?.context,
    });
    return { success: true, featureId, previousState: current.discoveryState, newState: to, timestamp: now };
  }

  /** Install a consumer-specific "is it on?" rule (see configuredResolvers). */
  setConfiguredResolver(featureId: string, resolver: (config: Record<string, unknown>) => boolean): void {
    this.configuredResolvers.set(featureId, resolver);
  }

  /**
   * Is the feature's config key on in this config? (Public form of the rule
   * bootstrap() uses, so the shown state reads config exactly as boot does.)
   */
  isConfigured(featureId: string, config: Record<string, unknown>): boolean {
    const def = this.definitions.get(featureId);
    if (!def) return false;
    return this.resolveConfigValue(config, def);
  }

  /**
   * Merge config.json on disk one level deep OVER the given runtime config (disk
   * wins — unlike bootstrap(), where runtime wins). Used by the shown state only.
   */
  readMergedConfig(runtimeConfig: Record<string, unknown>): Record<string, unknown> {
    let rawConfig: Record<string, unknown> = {};
    try {
      const configPath = path.join(this.stateDir, 'config.json');
      if (fs.existsSync(configPath)) rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch { /* @silent-fallback-ok — unreadable config file; runtime config still answers */ }
    // Disk wins here (unlike boot): PATCH /config writes the file, and the shown
    // state must reflect what was just written even where runtime lags. Merge one
    // level deep (the shape PATCH /config writes), so a disk section never wipes
    // sibling sub-keys the runtime holds for the same top-level key (review r2).
    const merged: Record<string, unknown> = { ...runtimeConfig };
    for (const [k, v] of Object.entries(rawConfig)) {
      const base = merged[k];
      merged[k] = v && typeof v === 'object' && !Array.isArray(v) && base && typeof base === 'object' && !Array.isArray(base)
        ? { ...(base as Record<string, unknown>), ...(v as Record<string, unknown>) }
        : v;
    }
    return merged;
  }

  /** What the switch says vs what is configured vs what this process booted with. */
  getEffectiveState(featureId: string, userId: string, mergedConfig: Record<string, unknown>): FeatureEffectiveState | null {
    const state = this.getState(featureId, userId);
    const def = this.definitions.get(featureId);
    if (!state || !def) return null;
    const configured = this.isConfigured(featureId, mergedConfig);
    const atBoot = this.bootValues.has(featureId) ? this.bootValues.get(featureId)! : null;
    if (def.switchable === false) {
      // A read-only switch: the key is what it is, the switch cannot move it, and the
      // honest sentence is the note. (A prerequisite rule was tried in r1 and dropped in
      // r2: the evolution consumers do not honor it, so it would have lied the other way.)
      const note = def.honestyNote ?? 'The switch is read-only in this version.';
      return {
        recorded: configured, configured, atBoot, lastAttempt: state.lastApply,
        status: configured ? 'on' : 'off',
        summary: `${configured ? 'On.' : 'Off.'} ${note}`,
        detail: note,
      };
    }
    return deriveEffectiveState(state.enabled, configured, atBoot, state.lastApply, def.honestyNote ?? null);
  }

  /**
   * Resolve a dot-notation config path to a boolean indicating if the feature is enabled.
   */
  private resolveConfigValue(config: Record<string, unknown>, def: FeatureDefinition): boolean {
    const resolver = this.configuredResolvers.get(def.id);
    if (resolver) {
      try { return resolver(config) === true; } catch { /* @silent-fallback-ok — fall through to the key */ }
    }
    const parts = def.configPath.split('.');
    let current: unknown = config;

    for (const part of parts) {
      if (current == null || typeof current !== 'object') { current = undefined; break; }
      current = (current as Record<string, unknown>)[part];
    }

    // An absent key means whatever the consumer's default is (review r1: publishing,
    // the tunnel, backups, the file viewer and external operations all run unless
    // explicitly disabled — the registry called them "off").
    if (current === undefined || current === null) return def.defaultOn === true;

    // A key that is on only at one value (evolution.approvalMode === 'autonomous').
    if (def.configEnabledValue !== undefined) return current === def.configEnabledValue;

    // A section object: its boolean `enabled` decides; a section with other keys but
    // no boolean `enabled` means the consumer's default applies (review r2 — the old
    // "any object counts as on" read `feedback: { webhookUrl }` as on while the
    // FeedbackManager, checking `this.config.enabled`, treated it as off).
    if (current != null && typeof current === 'object') {
      const enabled = (current as Record<string, unknown>).enabled;
      if (typeof enabled === 'boolean') return enabled;
      return def.defaultOn === true;
    }

    // A bare boolean at the path decides; anything else (null, a string without a
    // configEnabledValue) is off.
    return typeof current === 'boolean' ? current : false;
  }

  // ── Activation Challenge (Self-Governing Tier) ─────────────────

  /** Pending challenges: featureId:userId → { token, expiresAt } */
  private activationChallenges = new Map<string, { token: string; expiresAt: number }>();

  /**
   * Generate a time-limited activation challenge for self-governing features.
   * The challenge must be presented back with user confirmation within 10 minutes.
   */
  generateActivationChallenge(featureId: string, userId: string): string {
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
  verifyActivationChallenge(featureId: string, userId: string, challenge: string): boolean {
    const key = `${featureId}:${userId}`;
    const pending = this.activationChallenges.get(key);
    if (!pending) return false;
    if (Date.now() > pending.expiresAt) {
      this.activationChallenges.delete(key);
      return false;
    }
    if (pending.token !== challenge) return false;
    // Consume the challenge — one-time use
    this.activationChallenges.delete(key);
    return true;
  }

  // ── HMAC Signing ───────────────────────────────────────────────

  /**
   * Sign a consent record's canonical fields with HMAC-SHA256.
   * Returns null if no HMAC key is configured.
   */
  private signConsentRecord(
    id: string, userId: string, featureId: string, consentedAt: string, dataImplications: string,
  ): string | null {
    if (!this.hmacKey) return null;
    const canonical = `${id}:${userId}:${featureId}:${consentedAt}:${dataImplications}`;
    return crypto.createHmac('sha256', this.hmacKey).update(canonical).digest('hex');
  }

  // ── Consent Validation ─────────────────────────────────────────

  /**
   * Validate a consent record before storing. Returns error message or null if valid.
   * Server-enforced: prevents empty disclosures, backdated timestamps, invalid mechanisms.
   */
  private validateConsentRecord(record: ConsentRecord, definition: FeatureDefinition): string | null {
    const VALID_MECHANISMS: Set<string> = new Set(['explicit-verbal', 'explicit-written', 'profile-blanket']);

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

  private createSchema(): void {
    if (!this.db) throw new Error('Database not open');

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
    } catch {
      // Column already exists — expected
    }

    // Migration: add declined_at_version column if missing (v3 → v4)
    try {
      this.db.exec('ALTER TABLE feature_state ADD COLUMN declined_at_version TEXT');
    } catch {
      // Column already exists — expected
    }

    // Migration: last apply result column (v4 → v5, spec feature-transition-applies-action §2.2)
    try {
      this.db.exec('ALTER TABLE feature_state ADD COLUMN last_apply_json TEXT');
    } catch {
      // @silent-fallback-ok — column already exists (idempotent ADD COLUMN migration, same as the v3/v4 columns above)
    }

    // Migration: add signature column to consent_records if missing (v2 → v3)
    try {
      this.db.exec('ALTER TABLE consent_records ADD COLUMN signature TEXT');
    } catch {
      // Column already exists — expected
    }

    // Set schema version
    this.db.prepare(
      'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'
    ).run('schema_version', SCHEMA_VERSION);
  }
}

function parseApply(raw: unknown): FeatureApplyResult | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const v = JSON.parse(raw) as FeatureApplyResult;
    return v && typeof v === 'object' && typeof v.outcome === 'string' ? v : null;
  } catch {
    return null; // @silent-fallback-ok — a corrupt stored result reads as "no result"
  }
}

/**
 * The honest-state table (spec §2.3). Pure: exported for unit tests.
 *
 * "On" never claims the feature is verified running: a boot flag is not a
 * successful start (review r1). atBoot null = this process took no snapshot.
 */
export function deriveEffectiveState(
  recorded: boolean,
  configured: boolean,
  atBoot: boolean | null,
  lastApply: FeatureApplyResult | null,
  note: string | null = null,
): FeatureEffectiveState {
  const failed = lastApply && lastApply.outcome !== 'applied' ? lastApply : null;
  const why = failed?.detail
    ? ` The last attempt to turn it ${failed.direction === 'enable' ? 'on' : 'off'} was ${failed.outcome === 'not-applied' ? 'not made' : failed.outcome}: ${failed.detail}.`
    : '';
  const tail = note ? ` ${note}` : '';
  const base = { recorded, configured, atBoot, lastAttempt: lastApply };
  let status: EffectiveStatus;
  let summary: string;
  if (recorded && !configured) { status = 'recorded-only'; summary = 'Switched on, but the setting is still off.'; }
  else if (!recorded && configured) { status = 'not-recorded'; summary = 'The setting is on, but the switch says off.'; }
  else if (recorded) {
    if (atBoot === true) { status = 'on'; summary = 'On (the setting was on when the agent started; running is not separately verified).'; }
    else if (atBoot === false) { status = 'on-after-restart'; summary = 'Saved as on; it may not start until the next restart.'; }
    else { status = 'on'; summary = 'On in the settings; whether it started is not known to this process.'; }
  } else {
    if (atBoot === false) { status = 'off'; summary = 'Off (the setting was off when the agent started; not running is not separately verified).'; }
    else if (atBoot === true) { status = 'off-after-restart'; summary = 'Saved as off; it may keep running until the next restart.'; }
    else { status = 'off'; summary = 'Off in the settings; whether it stopped is not known to this process.'; }
  }
  const detail = (why + tail).trim();
  return { ...base, status, summary: summary + why + tail, detail: detail || null };
}
