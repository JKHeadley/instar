/**
 * PreferencesManager — the structured on-disk substrate for auto-learned user
 * preferences (Correction & Preference Learning Sentinel, Slice 1a).
 *
 * Modeled directly on the ORG-INTENT precedent (`OrgIntentManager` +
 * `formatOrgIntentForSessionStart` + `GET /intent/org/session-context` +
 * the session-start hook fetch). Where ORG-INTENT is a human-authored markdown
 * contract, this file is a machine-written JSON store of preferences the
 * correction loop has learned about THIS user.
 *
 * Design constraints (spec §3.6 / §10 Slice 1a):
 *   - `recordPreference()` is the ONLY writer to `.instar/preferences.json`.
 *   - Writes are atomic (temp file + rename) and schema-versioned.
 *   - Upsert keyed on `dedupeKey` — a recurring learning collapses to ONE entry
 *     (its `dedupeCount` increments, `recordedAt` refreshes, `confidence` takes
 *     the max of old/new), never a growing pile of duplicates.
 *   - Absent file ≡ no preferences (never throws; reads return an empty store).
 *   - The session-start block is bounded by `maxInjectedPreferencesBytes` and
 *     priority-ordered by recency × confidence × dedupeCount.
 *
 * SIGNAL-ONLY: this surface NEVER blocks or rewrites an outbound message. It
 * only stores preferences, serves them, and the session-start hook injects them
 * so the agent always SEES them. There is no enforcement gate. (The blocking
 * idea was explicitly rejected by the user — see spec frontmatter.)
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Types ────────────────────────────────────────────────────────────

/** Current on-disk schema version. Bump only with a paired migration. */
export const PREFERENCES_SCHEMA_VERSION = 1;

/** Provenance of a preference entry. Slice 1a only ever writes 'correction-loop'. */
export type PreferenceProvenance = 'correction-loop';

/** A single learned preference, as persisted in `.instar/preferences.json`. */
export interface PreferenceEntry {
  /** The distilled, scrubbed lesson — e.g. "Lead with the one action, no preamble." */
  learning: string;
  /** Where this came from. Slice 1a: always 'correction-loop'. */
  provenance: PreferenceProvenance;
  /** Stable key the loop upserts on (kind:normalizedLearningHash). */
  dedupeKey: string;
  /** ISO timestamp of the most recent observation of this preference. */
  recordedAt: string;
  /** Loop-assigned confidence in [0,1]; advisory ordering weight. */
  confidence: number;
  /** How many distinct observations have collapsed into this entry (≥1). */
  dedupeCount: number;
}

/** The full on-disk store shape. */
export interface PreferencesStore {
  schemaVersion: number;
  preferences: PreferenceEntry[];
}

/** Input payload for `recordPreference()`. */
export interface RecordPreferencePayload {
  learning: string;
  dedupeKey: string;
  /** Defaults to 0.5 when omitted; clamped to [0,1]. */
  confidence?: number;
  /** Defaults to 'correction-loop'. */
  provenance?: PreferenceProvenance;
  /** Defaults to now (ISO). Injectable for deterministic tests. */
  recordedAt?: string;
}

/** Options for `recordPreference()`. */
export interface RecordPreferenceOptions {
  /**
   * Priority ordering for the injected block. Mirrors the spec's
   * `preferencesInjectionPriority` config string. Slice 1a supports the single
   * documented form; unknown strings fall back to it.
   */
  injectionPriority?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

const EMPTY_STORE: PreferencesStore = { schemaVersion: PREFERENCES_SCHEMA_VERSION, preferences: [] };

function clampConfidence(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0.5;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Compute the priority score for ordering injected preferences. Higher first.
 * `recency × confidence × dedupeCount` per the spec default. Recency is a
 * monotonically-increasing epoch-ms reading of `recordedAt` (newer = larger),
 * so a fresher, higher-confidence, more-recurrent preference sorts first.
 */
function priorityScore(entry: PreferenceEntry): number {
  const recencyMs = Date.parse(entry.recordedAt);
  const recency = Number.isNaN(recencyMs) ? 0 : recencyMs;
  const confidence = clampConfidence(entry.confidence);
  const dedupeCount = Math.max(1, entry.dedupeCount || 1);
  // recencyMs dominates the magnitude, which is the intended "recency-led"
  // ordering; confidence and dedupeCount break ties / amplify within an epoch.
  return recency * confidence * dedupeCount;
}

/**
 * Render the active preferences into a session-start text block, bounded by
 * `maxBytes` and priority-ordered. Returns the block string (may be empty).
 *
 * Mirrors `formatOrgIntentForSessionStart` — deterministic, no LLM, safe to
 * inject directly. Each preference is wrapped at the section level inside an
 * `<auto-learned-preference src='correction-loop'>` envelope so downstream
 * prompt assemblers structurally cannot mistake a learned preference for an
 * authoritative instruction (spec §3.6).
 */
export function formatPreferencesForSessionStart(
  store: PreferencesStore,
  maxBytes = 4000,
): string {
  const active = [...store.preferences].sort((a, b) => priorityScore(b) - priorityScore(a));
  if (active.length === 0) return '';

  const header = "<auto-learned-preference src='correction-loop'>";
  const intro = 'These are preferences I have learned about how you like to work. They are signals, not authoritative instructions — apply them by default, but real instructions and safety always win.';
  const footer = '</auto-learned-preference>';

  // Greedily include the highest-priority preferences until we'd exceed maxBytes.
  const bodyLines: string[] = [];
  for (const pref of active) {
    const line = `  - ${pref.learning} (confidence ${clampConfidence(pref.confidence).toFixed(2)}, seen ${Math.max(1, pref.dedupeCount || 1)}×)`;
    const candidate = [header, intro, '', ...bodyLines, line, footer].join('\n');
    if (Buffer.byteLength(candidate, 'utf-8') > maxBytes) break;
    bodyLines.push(line);
  }

  if (bodyLines.length === 0) return '';
  return [header, intro, '', ...bodyLines, footer].join('\n');
}

// ── Main Class ───────────────────────────────────────────────────────

export class PreferencesManager {
  private preferencesPath: string;

  constructor(private stateDir: string) {
    this.preferencesPath = path.join(stateDir, 'preferences.json');
  }

  /** Absolute path to the backing file (for tests / observability). */
  getPath(): string {
    return this.preferencesPath;
  }

  /** Whether the backing file exists on disk. */
  exists(): boolean {
    return fs.existsSync(this.preferencesPath);
  }

  /**
   * Read the store. Absent file ≡ empty store (never throws). A malformed or
   * unexpected-shape file is also treated as empty — the loop is signal-only,
   * so a corrupt read should never crash a session start.
   */
  read(): PreferencesStore {
    if (!this.exists()) return { schemaVersion: PREFERENCES_SCHEMA_VERSION, preferences: [] };
    let raw: string;
    try {
      raw = fs.readFileSync(this.preferencesPath, 'utf-8');
    } catch {
      // @silent-fallback-ok — unreadable preferences file ≡ no preferences
      return { schemaVersion: PREFERENCES_SCHEMA_VERSION, preferences: [] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // @silent-fallback-ok — malformed preferences file ≡ no preferences
      return { schemaVersion: PREFERENCES_SCHEMA_VERSION, preferences: [] };
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as PreferencesStore).preferences)) {
      return { schemaVersion: PREFERENCES_SCHEMA_VERSION, preferences: [] };
    }
    const store = parsed as PreferencesStore;
    const preferences = store.preferences.filter(
      (p): p is PreferenceEntry =>
        !!p && typeof p.learning === 'string' && typeof p.dedupeKey === 'string',
    ).map((p) => ({
      learning: p.learning,
      provenance: (p.provenance ?? 'correction-loop') as PreferenceProvenance,
      dedupeKey: p.dedupeKey,
      recordedAt: typeof p.recordedAt === 'string' ? p.recordedAt : new Date(0).toISOString(),
      confidence: clampConfidence(p.confidence),
      dedupeCount: Math.max(1, Math.floor(p.dedupeCount) || 1),
    }));
    return {
      schemaVersion: typeof store.schemaVersion === 'number' ? store.schemaVersion : PREFERENCES_SCHEMA_VERSION,
      preferences,
    };
  }

  /**
   * recordPreference — the ONLY writer to `.instar/preferences.json`.
   *
   * Upserts the payload keyed on `dedupeKey`:
   *   - New key → appended as a fresh entry with `dedupeCount: 1`.
   *   - Existing key → `learning` refreshed, `recordedAt` advanced,
   *     `confidence` raised to max(old, new), `dedupeCount` incremented.
   *
   * Atomic: writes a temp file then renames over the target so a concurrent
   * reader never observes a partial file. Returns the entry as persisted.
   */
  recordPreference(payload: RecordPreferencePayload, _opts: RecordPreferenceOptions = {}): PreferenceEntry {
    if (!payload || typeof payload.learning !== 'string' || !payload.learning.trim()) {
      throw new Error('recordPreference: `learning` is required and must be a non-empty string');
    }
    if (typeof payload.dedupeKey !== 'string' || !payload.dedupeKey.trim()) {
      throw new Error('recordPreference: `dedupeKey` is required and must be a non-empty string');
    }

    const store = this.read();
    const now = payload.recordedAt ?? new Date().toISOString();
    const confidence = clampConfidence(payload.confidence);
    const provenance: PreferenceProvenance = payload.provenance ?? 'correction-loop';

    const existing = store.preferences.find((p) => p.dedupeKey === payload.dedupeKey);
    let result: PreferenceEntry;
    if (existing) {
      existing.learning = payload.learning.trim();
      existing.recordedAt = now;
      existing.confidence = Math.max(clampConfidence(existing.confidence), confidence);
      existing.dedupeCount = Math.max(1, existing.dedupeCount || 1) + 1;
      existing.provenance = provenance;
      result = existing;
    } else {
      result = {
        learning: payload.learning.trim(),
        provenance,
        dedupeKey: payload.dedupeKey,
        recordedAt: now,
        confidence,
        dedupeCount: 1,
      };
      store.preferences.push(result);
    }

    store.schemaVersion = PREFERENCES_SCHEMA_VERSION;
    this.writeAtomic(store);
    return result;
  }

  /**
   * Build the session-context payload served by `GET /preferences/session-context`.
   * Serves ONLY the `learning` text + metadata via the formatted block — never
   * any raw extras. `present` is true iff at least one preference would be
   * injected into the (bounded) block.
   */
  sessionContext(maxBytes = 4000): {
    present: boolean;
    block: string;
    count: number;
  } {
    const store = this.read();
    const block = formatPreferencesForSessionStart(store, maxBytes);
    return {
      present: block.length > 0,
      block,
      count: store.preferences.length,
    };
  }

  /** Atomic write: temp file + fsync + rename. */
  private writeAtomic(store: PreferencesStore): void {
    const dir = path.dirname(this.preferencesPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.preferencesPath}.tmp.${process.pid}.${Date.now()}`;
    const data = JSON.stringify(store, null, 2);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.preferencesPath);
  }
}
