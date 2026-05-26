/**
 * transcriptProber — per-framework transcript-growth probe for the SessionReaper.
 *
 * SESSION-REAPER-SPEC §3.1(3) "Transcript growth", gate E. The reaper must NEVER
 * treat an *unresolvable* transcript as "quiet" — that was the v1 BLOCKER (the old
 * CompactionSentinel probe hardcoded `~/.claude/projects`, so Codex sessions and
 * sessions whose path could not be resolved silently read as no-growth and became
 * reap-eligible). This wraps the already-per-framework
 * {@link resolveFrameworkTranscriptPath} (Claude `~/.claude/projects`, Codex
 * `~/.codex/sessions`) and makes the failure mode explicit: anything we cannot
 * resolve-and-stat returns `resolved:false`, and {@link transcriptDelta} reports
 * `'unknown'` for it — which the classifier maps to KEEP.
 *
 * Pure path resolution + a single stat. No mutation, no network.
 */

import * as fs from 'node:fs';
import {
  resolveFrameworkTranscriptPath,
  type ResolveTranscriptOptions,
} from '../core/FrameworkSessionStore.js';

export interface TranscriptProbe {
  /** True only if a path resolved AND statting it succeeded. */
  readonly resolved: boolean;
  /** Resolved path, or '' when no path could be resolved. */
  readonly path: string;
  /** File size in bytes (0 when unresolved). */
  readonly size: number;
  /** mtime in ms since epoch (0 when unresolved). */
  readonly mtime: number;
}

const UNRESOLVED: TranscriptProbe = { resolved: false, path: '', size: 0, mtime: 0 };

/**
 * Resolve and stat a session's transcript. Returns `resolved:false` when the
 * path cannot be resolved (no session id, Codex file not on disk yet, unknown
 * framework) or the stat fails (missing / permission error). Callers MUST treat
 * `resolved:false` as ambiguous → KEEP, never as "no activity".
 */
export function probeTranscript(opts: ResolveTranscriptOptions): TranscriptProbe {
  const p = resolveFrameworkTranscriptPath(opts);
  if (!p) return UNRESOLVED;
  try {
    const st = fs.statSync(p);
    return { resolved: true, path: p, size: st.size, mtime: st.mtimeMs };
  } catch {
    // Path resolved but the file is missing / unreadable — still ambiguous.
    return { resolved: false, path: p, size: 0, mtime: 0 };
  }
}

export type TranscriptDelta = 'grew' | 'static' | 'unknown';

/**
 * Compare two probes of the same session over an observation window.
 *  - `'grew'`    — size or mtime advanced ⇒ the session produced output (WORKING).
 *  - `'static'`  — both probes resolved, same file identity, no growth ⇒ quiet
 *                  (high-confidence; safe to count toward idle).
 *  - `'unknown'` — either probe unresolved, or the file identity changed
 *                  (rotation / different path) ⇒ cannot tell ⇒ caller KEEPS.
 */
export function transcriptDelta(
  baseline: TranscriptProbe,
  current: TranscriptProbe,
): TranscriptDelta {
  if (!baseline.resolved || !current.resolved) return 'unknown';
  // Path identity changed under us (rotation / re-resolution to a different
  // file) — we cannot reason about growth across two different files.
  if (current.path !== baseline.path) return 'unknown';
  if (current.size > baseline.size || current.mtime > baseline.mtime) return 'grew';
  return 'static';
}
