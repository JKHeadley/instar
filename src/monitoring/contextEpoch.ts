/**
 * The context epoch (context-budget-layered-summaries §7.7, §9.1): ONE
 * deterministic transcript key per stretch of a session's context, derived the
 * same way by every writer and reader of the seeded marker.
 *
 *   - after a compaction: the engine's compact-boundary entry id (its `uuid`);
 *   - after a fold (a clear-and-seed): the `foldId`;
 *   - otherwise (startup, resume, fork, unknown): the spawn id (the Instar
 *     session id the session was started with).
 *
 * Writers: the session-start hook's compact branch (shell + Python; it cannot
 * see this compaction's boundary — Claude Code flushes it after the hook runs,
 * measured on 2.1.321 — so it writes an EMPTY epoch that readers bind with
 * `boundaryEpochFor` below), the clear-seed hook (`foldId`), and the server
 * (the CompactionSentinel fallback and the heal ladder, which see the boundary
 * and write it). Readers: the CompactionSentinel seed wait, the canary, the heal
 * ladder. A test drives every writer through `markerEpoch` and proves they agree.
 */

export type EpochSource = 'compact' | 'clear' | 'fold' | 'startup' | 'resume' | 'fork' | 'unknown';

export interface EpochInputs {
  source: EpochSource | string;
  /** The compact-boundary entry id this compaction wrote, when visible. */
  boundaryUuid?: string | null;
  foldId?: string | null;
  /** The Instar session id the session was spawned with. */
  spawnId?: string | null;
}

/** A compact-boundary entry as the transcript records it. */
export interface BoundaryRef { uuid: string; at: number }

/** The hook runs this long before its compaction's boundary is stamped (same machine's clock). */
export const BOUNDARY_SLACK_MS = 2_000;

/**
 * The epoch for a set of inputs. A compaction without a visible boundary
 * yields `''` — "bind to the boundary that follows" (`boundaryEpochFor`) —
 * never a made-up key.
 */
export function deriveContextEpoch(i: EpochInputs): string {
  if (i.source === 'compact') return typeof i.boundaryUuid === 'string' ? i.boundaryUuid : '';
  if (i.source === 'clear' || i.source === 'fold') return typeof i.foldId === 'string' ? i.foldId : '';
  return typeof i.spawnId === 'string' ? i.spawnId : '';
}

/**
 * The compaction a time belongs to: the NEWEST boundary stamped at or before
 * `at + BOUNDARY_SLACK_MS` (a hook's marker lands about a second before its own
 * boundary; a server-written marker lands after it, before the next one).
 * Null when no boundary precedes it.
 */
export function boundaryEpochFor(at: number, boundaries: readonly BoundaryRef[]): string | null {
  let best: BoundaryRef | null = null;
  for (const b of boundaries) if (b.at <= at + BOUNDARY_SLACK_MS && (!best || b.at >= best.at)) best = b;
  return best ? best.uuid : null;
}

/**
 * The epoch a seeded marker names, the same way for every writer: an explicit
 * epoch wins; a compaction marker with an empty epoch binds to its boundary.
 */
export function markerEpoch(marker: { epoch: string; seededAt: number; source?: string }, boundaries: readonly BoundaryRef[]): string | null {
  if (marker.epoch) return marker.epoch;
  if (marker.source !== undefined && marker.source !== 'compact') return null;
  return boundaryEpochFor(marker.seededAt, boundaries);
}
