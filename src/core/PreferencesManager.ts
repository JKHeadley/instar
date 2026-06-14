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

import { randomUUID } from 'node:crypto';
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
  /**
   * OPTIONAL self-violation pattern (Self-Violation Signal extension). When set,
   * the SelfViolationDetector checks finalized outbound messages against this
   * pattern; a match records a self-violation in the CorrectionLedger that
   * reinforces this preference's recurrence/salience. Grammar:
   *   - `regex:<source>` → a case-insensitive RegExp.
   *   - `keywords:a,b,c` → fires only when ALL keywords are present (≥2).
   *   - bare `<source>`  → treated as a regex source.
   * ABSENT ≡ this preference is NEVER self-violation-checked (fully back-compat
   * with shipped `.instar/preferences.json` files that have no such field).
   * SIGNAL-ONLY: a match never blocks/alters the outbound message.
   */
  violationPattern?: string;
  /**
   * WS2.1 cross-machine replication (additive). The store `replicationSeq` at
   * this entry's most recent upsert — the delta-window key the sync serve side
   * pages on. Absent on a legacy entry ⇒ backfilled to 1 (serves on a from-0
   * pull). Local-only bookkeeping; never part of the injected session block.
   */
  lastMutatedSeq?: number;
}

/** The full on-disk store shape. */
export interface PreferencesStore {
  schemaVersion: number;
  preferences: PreferenceEntry[];
  /**
   * WS2.1 cross-machine replication (additive). Monotonic per-machine mutation
   * counter — each `recordPreference` upsert bumps it and stamps the entry's
   * `lastMutatedSeq`. Absent on a legacy store ⇒ seeded to 1 on next read.
   */
  replicationSeq?: number;
  /**
   * WS2.1 — opaque per-store incarnation. Re-minted when a restore rewinds the
   * store below its high-water seq, so replica peers re-pull wholesale instead
   * of stranding behind a backward seq. Absent on a legacy store ⇒ minted.
   */
  storeIncarnation?: string;
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
  /**
   * OPTIONAL self-violation pattern (Self-Violation Signal extension). Persisted
   * verbatim onto the entry. Absent ≡ this preference is never self-violation-
   * checked. See PreferenceEntry.violationPattern for the grammar.
   */
  violationPattern?: string;
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
    ).map((p) => {
      const entry: PreferenceEntry = {
        learning: p.learning,
        provenance: (p.provenance ?? 'correction-loop') as PreferenceProvenance,
        dedupeKey: p.dedupeKey,
        recordedAt: typeof p.recordedAt === 'string' ? p.recordedAt : new Date(0).toISOString(),
        confidence: clampConfidence(p.confidence),
        dedupeCount: Math.max(1, Math.floor(p.dedupeCount) || 1),
      };
      // Back-compat: preserve an optional self-violation pattern when present;
      // a file written before this field existed simply omits it (no check).
      if (typeof p.violationPattern === 'string' && p.violationPattern.trim().length > 0) {
        entry.violationPattern = p.violationPattern;
      }
      // WS2.1: preserve the replication seq; a legacy entry without one is
      // backfilled to 1 so it serves on a from-0 pull.
      entry.lastMutatedSeq =
        typeof p.lastMutatedSeq === 'number' && Number.isFinite(p.lastMutatedSeq) ? p.lastMutatedSeq : 1;
      return entry;
    });
    // WS2.1 replication bookkeeping (additive). Seed a legacy store with seq=1 +
    // a fresh incarnation: peers hold nothing for a new incarnation, so the
    // first sync is a FULL pull (never a 0-means-unchanged strand). Then, if the
    // meta sidecar's high-water seq EXCEEDS our current seq, the store was
    // rewound (restore) — re-mint the incarnation so peers re-pull wholesale.
    const replicationSeq =
      typeof store.replicationSeq === 'number' && Number.isFinite(store.replicationSeq) ? store.replicationSeq : 1;
    let storeIncarnation =
      typeof store.storeIncarnation === 'string' && store.storeIncarnation ? store.storeIncarnation : randomUUID();
    try {
      const metaRaw = fs.readFileSync(`${this.preferencesPath}.meta.json`, 'utf-8');
      const meta = JSON.parse(metaRaw) as { highWaterSeq?: number };
      if (typeof meta?.highWaterSeq === 'number' && replicationSeq < meta.highWaterSeq) {
        storeIncarnation = randomUUID();
      }
    } catch {
      // @silent-fallback-ok — no meta sidecar = no prior advert to rewind below (first boot); nothing to fence
    }
    return {
      schemaVersion: typeof store.schemaVersion === 'number' ? store.schemaVersion : PREFERENCES_SCHEMA_VERSION,
      preferences,
      replicationSeq,
      storeIncarnation,
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

    // Optional self-violation pattern (Self-Violation Signal extension). Only a
    // non-empty string is persisted; omitting it on an upsert preserves any
    // existing pattern (never silently clears one already set).
    const violationPattern =
      typeof payload.violationPattern === 'string' && payload.violationPattern.trim().length > 0
        ? payload.violationPattern.trim()
        : undefined;

    const existing = store.preferences.find((p) => p.dedupeKey === payload.dedupeKey);
    let result: PreferenceEntry;
    if (existing) {
      existing.learning = payload.learning.trim();
      existing.recordedAt = now;
      existing.confidence = Math.max(clampConfidence(existing.confidence), confidence);
      existing.dedupeCount = Math.max(1, existing.dedupeCount || 1) + 1;
      existing.provenance = provenance;
      if (violationPattern !== undefined) existing.violationPattern = violationPattern;
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
      if (violationPattern !== undefined) result.violationPattern = violationPattern;
      store.preferences.push(result);
    }

    // WS2.1: every upsert is a state-meaningful mutation — bump the store's
    // monotonic replication seq and stamp it on the upserted entry so the sync
    // delta window catches it. The first write on a FRESH file takes read()'s
    // file-absent early return (no seeded fields), so seed the incarnation here
    // before persisting — otherwise each later read would mint a new one and
    // the advert incarnation would never stabilize.
    if (typeof store.storeIncarnation !== 'string' || !store.storeIncarnation) {
      store.storeIncarnation = randomUUID();
    }
    const nextSeq = (typeof store.replicationSeq === 'number' ? store.replicationSeq : 1) + 1;
    store.replicationSeq = nextSeq;
    result.lastMutatedSeq = nextSeq;

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

    // WS2.1 rewind fence: the meta sidecar tracks the high-water replicationSeq.
    // Written AFTER the store rename (a crash between leaves the sidecar BEHIND
    // the store — harmless; ahead would false-trip the rewind fence). The store
    // fd is fsync'd before its rename above, so in program order the sidecar can
    // never be persisted ahead of the store — the fence cannot false-trip on a
    // reorder (review WS2.1 finding #6: ordering verified sufficient, no barrier
    // needed). Best-effort: a sidecar write failure only weakens rewind detection.
    try {
      const seq = store.replicationSeq;
      if (typeof seq === 'number') {
        const metaTmp = `${this.preferencesPath}.meta.json.${process.pid}.tmp`;
        fs.writeFileSync(metaTmp, JSON.stringify({ highWaterSeq: seq }));
        fs.renameSync(metaTmp, `${this.preferencesPath}.meta.json`);
      }
    } catch {
      // @silent-fallback-ok — sidecar write failure only weakens rewind detection; the store itself persisted
    }
  }

  /**
   * WS2.1 — the replication advert ({ incarnation, replicationSeq }) the
   * `preferences-sync` serve side answers with. Sourced from the on-disk store
   * (read() seeds both fields), so a fresh/legacy store yields a valid advert.
   */
  getReplicationAdvert(): { incarnation: string; replicationSeq: number } {
    const store = this.read();
    return {
      incarnation: store.storeIncarnation ?? randomUUID(),
      replicationSeq: typeof store.replicationSeq === 'number' ? store.replicationSeq : 1,
    };
  }

  /**
   * WS2.1 — the OWN preferences with their replication seqs, for the sync serve
   * side (buildPreferencesSyncPage). Never includes replicas. Each entry's
   * `lastMutatedSeq` is backfilled to 1 by read() when absent.
   */
  getAllForSync(): PreferenceEntry[] {
    return this.read().preferences;
  }
}
