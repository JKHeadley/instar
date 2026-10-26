/**
 * PreferencesListView — the structured read behind `GET /preferences`
 * (docs/specs/console-features/people-settings.md, "What I've learned about you").
 *
 * The session-context route serves a FORMATTED text block (byte-bounded, for the
 * session-start hook). The console page needs the structured entries instead —
 * when each was learned, how often, how sure, and which machine — so it can say
 * "new this week" and name the machine without parsing prose.
 *
 * Pure: callers hand in the rows from whichever source the session-context route
 * would read (own store, the WS2.1 merged view, or the foundation union) and get
 * back the served entries. Two invariants:
 *   - `violationPattern` (a LOCAL-ONLY operator regex) and replication bookkeeping
 *     (`lastMutatedSeq`, `provenance`) are never served.
 *   - every `learning` passes the credential scrubber the replication serve path
 *     uses (`redactForLiveTail`), on every source — own entries included, so a
 *     secret that slipped into a distilled lesson never reaches the page.
 * Read only; never writes.
 */

import type { PreferenceEntry } from './PreferencesManager.js';
import type { UnionResult } from './UnionReader.js';
import { prefEntryFromOriginRecord } from './PreferencesReplicatedStore.js';
import { redactForLiveTail } from './liveTailRedaction.js';

/** One served preference. `origin` is the machine id that learned it (absent when unknown). */
export interface PreferenceListEntry {
  dedupeKey: string;
  learning: string;
  recordedAt: string;
  confidence: number;
  dedupeCount: number;
  origin?: string;
  /** True when `learning` had a credential-shaped span replaced at serve time. */
  textRedacted?: true;
}

/** A source row: the entry plus the machine it came from (when known). */
export interface PreferenceSourceRow {
  entry: PreferenceEntry;
  origin?: string | null;
  /** Already redacted upstream (a replica's serve-time scrub). */
  redacted?: boolean;
}

/** Hard cap on served entries (the store is small in practice; this bounds a pathological one). */
export const MAX_LIST_ENTRIES = 500;

export type Scrubber = (input: string) => { text: string; redactedCount: number };

/** Rows → served entries: scrubbed, origin-stamped, newest first, capped. */
export function buildPreferenceList(
  rows: PreferenceSourceRow[],
  scrub: Scrubber = redactForLiveTail,
): { entries: PreferenceListEntry[]; total: number; truncated: boolean } {
  const out: PreferenceListEntry[] = [];
  for (const r of rows) {
    const e = r && r.entry;
    if (!e || typeof e.learning !== 'string' || !e.learning.trim() || typeof e.dedupeKey !== 'string') continue;
    const scan = scrub(e.learning);
    const redacted = scan.redactedCount > 0 || r.redacted === true;
    const entry: PreferenceListEntry = {
      dedupeKey: e.dedupeKey,
      learning: scan.redactedCount > 0 ? scan.text : e.learning,
      recordedAt: typeof e.recordedAt === 'string' ? e.recordedAt : new Date(0).toISOString(),
      confidence: typeof e.confidence === 'number' && Number.isFinite(e.confidence) ? e.confidence : 0.5,
      dedupeCount: typeof e.dedupeCount === 'number' && Number.isFinite(e.dedupeCount) && e.dedupeCount >= 1 ? Math.floor(e.dedupeCount) : 1,
    };
    if (typeof r.origin === 'string' && r.origin.length > 0) entry.origin = r.origin;
    if (redacted) entry.textRedacted = true;
    out.push(entry);
  }
  out.sort((a, b) => (Date.parse(b.recordedAt) || 0) - (Date.parse(a.recordedAt) || 0) || a.dedupeKey.localeCompare(b.dedupeKey));
  return { entries: out.slice(0, MAX_LIST_ENTRIES), total: out.length, truncated: out.length > MAX_LIST_ENTRIES };
}

/**
 * The foundation union → source rows, keeping each variant's origin machine. Mirrors
 * `mergeUnionToPreferences`: an open conflict yields every surviving `put` variant
 * (both are usable hints), a delete tombstone yields nothing.
 */
export function unionToPreferenceRows(union: Map<string, UnionResult>): PreferenceSourceRow[] {
  const out: PreferenceSourceRow[] = [];
  for (const result of union.values()) {
    if (result.conflict) {
      for (const v of result.conflict.versions) {
        if (v.envelope.op === 'delete') continue;
        out.push({ entry: prefEntryFromOriginRecord(v), origin: v.origin });
      }
      continue;
    }
    if (result.value && result.value.envelope.op !== 'delete') {
      out.push({ entry: prefEntryFromOriginRecord(result.value), origin: result.value.origin });
    }
  }
  return out;
}
