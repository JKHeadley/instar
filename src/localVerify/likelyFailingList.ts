/**
 * The likely-failing list (spec docs/specs/local-verify-likely-failing-first.md, section B).
 *
 * One file on the coordinator, `state/local-verify/likely-failing.json`: per test file, the
 * pull request number and time of each verify that FAILED FINALLY on it in the last 7 days
 * (what a verify's record stores as `failedFiles`). For each verify the coordinator takes the
 * 90 files that failed for the most DIFFERENT pull requests other than the one being verified.
 * The list only decides which files run first: it can never remove a file from a verify or
 * change a verdict.
 *
 * The pure functions take and return plain state; `LikelyFailingStore` adds the file. The file
 * is written whole and replaced, and read only when it is at most 1 MB. A lost, oversized or
 * unreadable file is an empty list (one audit row), rebuilt as verifies are recorded.
 */

import fs from 'node:fs';
import path from 'node:path';
import { FIRST_PART_LIMITS } from './firstPart.js';

export interface LikelyFailingFailure {
  pr: number;
  /** When that verify finished (ms). */
  at: number;
}

export interface LikelyFailingState {
  v: 1;
  /** When the list last changed (ms); 0 = never. */
  updatedAt: number;
  /** The oldest failure the list holds (ms); null when it holds none. */
  oldestFailureAt: number | null;
  files: Record<string, LikelyFailingFailure[]>;
}

export function emptyLikelyFailing(): LikelyFailingState {
  return { v: 1, updatedAt: 0, oldestFailureAt: null, files: {} };
}

function oldest(files: Record<string, LikelyFailingFailure[]>): number | null {
  let o: number | null = null;
  for (const list of Object.values(files)) for (const f of list) if (o === null || f.at < o) o = f.at;
  return o;
}

/** A failure time this far ahead of now is not a real one (clock skew between two machines is seconds). */
export const FUTURE_SLACK_MS = 5 * 60_000;

const newest = (list: readonly LikelyFailingFailure[]) => list.reduce((n, f) => Math.max(n, f.at), 0);

/**
 * Count one verify's final failures. Failures older than 7 days are dropped first; each named
 * file gets `{ pr, at }`, one entry per pull request (its latest failure); a file keeps its
 * newest 40 entries; and when the list would hold more than 500 files, the file whose most recent failure
 * is oldest is dropped (`evicted`). Pure: returns a new state, `changed` false when nothing moved.
 */
export function addLikelyFailures(
  state: LikelyFailingState,
  failure: { pr: number; files: readonly string[]; at: number },
  now: number,
): { state: LikelyFailingState; changed: boolean; evicted: string[] } {
  const L = FIRST_PART_LIMITS;
  const files: Record<string, LikelyFailingFailure[]> = {};
  let changed = false;
  for (const [f, list] of Object.entries(state.files)) {
    const kept = list.filter((x) => now - x.at <= L.windowMs);
    if (kept.length !== list.length) changed = true;
    if (kept.length > 0) files[f] = kept;
  }
  const usable = Number.isSafeInteger(failure.pr) && failure.pr > 0 && Number.isFinite(failure.at) && now - failure.at <= L.windowMs && failure.at - now <= FUTURE_SLACK_MS;
  for (const f of usable ? new Set(failure.files) : []) {
    if (typeof f !== 'string' || f.length === 0 || f.length > 1000) continue;
    const list = files[f] ?? [];
    // One entry per pull request per file, its latest failure: a change that fails the same file
    // many times can never push other pull requests' entries out of the 40 kept.
    const mine = list.find((x) => x.pr === failure.pr);
    if (mine && mine.at >= failure.at) continue;
    files[f] = [...list.filter((x) => x.pr !== failure.pr), { pr: failure.pr, at: failure.at }].sort((a, b) => a.at - b.at).slice(-L.failuresPerFile);
    changed = true;
  }
  const evicted: string[] = [];
  const names = Object.keys(files);
  if (names.length > L.listFiles) {
    // Oldest most-recent failure first; the path breaks a tie so the choice is stable.
    const order = names.sort((a, b) => newest(files[a]) - newest(files[b]) || (a < b ? -1 : 1));
    for (const f of order.slice(0, names.length - L.listFiles)) { delete files[f]; evicted.push(f); }
  }
  if (!changed) return { state, changed: false, evicted };
  return { state: { v: 1, updatedAt: now, oldestFailureAt: oldest(files), files }, changed: true, evicted };
}

/**
 * The list in use for one verify: the 90 files that failed finally for the most different pull
 * requests OTHER than `pr` inside the last 7 days; ties go to the most recent failure, then the
 * path. No minimum. A list not updated for 7 days is treated as empty. Pure.
 */
export function likelyFailingFor(state: LikelyFailingState, pr: number, now: number): string[] {
  return rankLikelyFailing(state, pr, now).slice(0, FIRST_PART_LIMITS.listUsed).map((r) => r.file);
}

/** Every listed file with its count of different pull requests (other than `pr`) and its last failure, in list order. */
export function rankLikelyFailing(state: LikelyFailingState, pr: number | null, now: number): Array<{ file: string; prs: number; last: number }> {
  const L = FIRST_PART_LIMITS;
  if (state.updatedAt <= 0 || now - state.updatedAt > L.staleMs) return [];
  const rows: Array<{ file: string; prs: number; last: number }> = [];
  for (const [file, list] of Object.entries(state.files)) {
    const live = list.filter((x) => now - x.at <= L.windowMs && x.pr !== pr);
    if (live.length === 0) continue;
    rows.push({ file, prs: new Set(live.map((x) => x.pr)).size, last: newest(live) });
  }
  return rows.sort((a, b) => b.prs - a.prs || b.last - a.last || (a.file < b.file ? -1 : 1));
}

/**
 * Parse the file's text; null when it is not a list this code wrote. With `now`, a failure (or an
 * update time) more than a few minutes in the future makes the whole file invalid: a doctored
 * time could otherwise pin a file at the top of the list and never age out.
 */
export function parseLikelyFailing(text: string, now?: number): LikelyFailingState | null {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const x = doc as Record<string, unknown>;
  const future = (at: number) => now !== undefined && at - now > FUTURE_SLACK_MS;
  if (x.v !== 1 || typeof x.updatedAt !== 'number' || !Number.isFinite(x.updatedAt) || future(x.updatedAt) || !x.files || typeof x.files !== 'object' || Array.isArray(x.files)) return null;
  const files: Record<string, LikelyFailingFailure[]> = {};
  for (const [f, list] of Object.entries(x.files as Record<string, unknown>)) {
    if (!Array.isArray(list)) return null;
    const out: LikelyFailingFailure[] = [];
    for (const e of list) {
      const r = e as { pr?: unknown; at?: unknown } | null;
      if (!r || typeof r.pr !== 'number' || !Number.isSafeInteger(r.pr) || r.pr <= 0 || typeof r.at !== 'number' || !Number.isFinite(r.at) || future(r.at)) return null;
      out.push({ pr: r.pr, at: r.at });
    }
    if (out.length > 0) files[f] = out;
  }
  if (Object.keys(files).length > FIRST_PART_LIMITS.listFiles * 2) return null;
  return { v: 1, updatedAt: x.updatedAt, oldestFailureAt: oldest(files), files };
}

export type LikelyFailingProblem = 'oversized' | 'unparseable' | 'unreadable';

/** What `GET /local-verify` shows of the list. */
export interface LikelyFailingInfo {
  /** Files the list holds. */
  files: number;
  updatedAt: string | null;
  oldestFailureAt: string | null;
  /** Not updated for 7 days: treated as empty. */
  stale: boolean;
  /** Set while the file on disk could not be used (the list is empty until a verify is recorded). */
  problem: LikelyFailingProblem | null;
  /** The first ten files in list order, with the number of different pull requests each failed for. */
  top: Array<{ file: string; prs: number; last: string }>;
}

/**
 * The list with its file. One instance is shared by the recorder (the completion path) and the
 * run input (a local start and a hand-off to a peer). Never throws: a list problem must not
 * touch a verify.
 */
export class LikelyFailingStore {
  private state: LikelyFailingState | null = null;
  private problem: LikelyFailingProblem | null = null;

  constructor(
    readonly file: string,
    private readonly now: () => number,
    private readonly audit: (event: Record<string, unknown>) => void,
  ) {}

  /** Load once. A file over 1 MB is never read; anything unusable is an empty list and ONE audit row. */
  private load(): LikelyFailingState {
    if (this.state) return this.state;
    let state = emptyLikelyFailing();
    try {
      let size: number | null = null;
      try { size = fs.statSync(this.file).size; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (size !== null) {
        if (size > FIRST_PART_LIMITS.listMaxBytes) this.problem = 'oversized';
        else {
          const parsed = parseLikelyFailing(fs.readFileSync(this.file, 'utf-8'), this.now());
          if (parsed) state = parsed; else this.problem = 'unparseable';
        }
        if (this.problem) this.audit({ event: 'likely-failing-unreadable', reason: this.problem, bytes: size });
      }
    } catch (e) {
      this.problem = 'unreadable';
      this.audit({ event: 'likely-failing-unreadable', reason: 'unreadable', detail: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
    this.state = state;
    return state;
  }

  /** Count one recorded verify's final failures; writes the file whole and replaces it when the list changed. */
  record(failure: { pr: number; files: readonly string[]; at: number }): boolean {
    const r = addLikelyFailures(this.load(), failure, this.now());
    if (!r.changed) return false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(r.state), { mode: 0o600 }); /* state-registry: local-verify-likely-failing */
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // @silent-fallback-ok: the list stays as it was in memory and on disk; a first part built from an older list only means the old timing.
      this.audit({ event: 'likely-failing-write-failed', detail: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      return false;
    }
    this.state = r.state;
    this.problem = null;
    this.audit({ event: 'likely-failing-updated', pr: failure.pr, added: [...new Set(failure.files)].slice(0, 3), files: Object.keys(r.state.files).length, ...(r.evicted.length ? { evicted: r.evicted.slice(0, 10) } : {}) });
    return true;
  }

  /** The list in use for a verify of `pr`. */
  listFor(pr: number): string[] {
    return likelyFailingFor(this.load(), pr, this.now());
  }

  info(): LikelyFailingInfo {
    const s = this.load();
    const now = this.now();
    const iso = (ms: number | null) => (ms === null || ms <= 0 ? null : new Date(ms).toISOString());
    return {
      files: Object.keys(s.files).length, updatedAt: iso(s.updatedAt), oldestFailureAt: iso(s.oldestFailureAt),
      stale: s.updatedAt > 0 && now - s.updatedAt > FIRST_PART_LIMITS.staleMs, problem: this.problem,
      top: rankLikelyFailing(s, null, now).slice(0, 10).map((r) => ({ file: r.file, prs: r.prs, last: new Date(r.last).toISOString() })),
    };
  }
}
