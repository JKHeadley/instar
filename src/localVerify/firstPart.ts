/**
 * The first part of a lane (spec docs/specs/local-verify-likely-failing-first.md, sections A,
 * B "Both machines use the same list" and E).
 *
 * For a verify of a pull request, each lane may run a small FIRST PART before the rest of its
 * files: the change's own test files, the files the same change failed on in its previous
 * verify, then the lane's files from the coordinator's likely-failing list. This module holds
 * the pure choices: which files go first, the bounded request field that carries the list to a
 * peer, and the per-machine setting. It is ordering only: a file left out of a first part still
 * runs in the rest of its lane, so a poor choice here can only mean the old timing.
 *
 * These limits are deliberately NOT part of the policy hash: the two run machines may differ in
 * the setting during the trial, and nothing here decides a verdict.
 */

import type { LaneName } from './inventory.js';
import type { FileDurations } from './shardPlan.js';

const DAY = 24 * 60 * 60_000;

export const FIRST_PART_LIMITS = Object.freeze({
  /** Files in one lane's first part. */
  files: Object.freeze({ unit: 80, integration: 20, e2e: 12 }) as Readonly<Record<LaneName, number>>,
  /** Lanes whose files run one at a time: their first part is also held to `maxMs` of recorded time. */
  timedLanes: Object.freeze(['integration', 'e2e']) as readonly LaneName[],
  maxMs: 60_000,
  /** What a file with no recorded time counts as. */
  untimedMs: 10_000,
  /** Paths of the likely-failing list used for one verify. */
  listUsed: 90,
  /** A change's previous failures (a record names at most 3 failed files). */
  previousMax: 3,
  /** The request field: paths in total, and characters per path. */
  wirePaths: 100,
  pathChars: 300,
  /** Failures are kept, and the list is trusted, this long. */
  windowMs: 7 * DAY,
  staleMs: 7 * DAY,
  /** Files in the list file, failures kept per file, and the largest file that is read. */
  listFiles: 500,
  failuresPerFile: 40,
  listMaxBytes: 1024 * 1024,
  /** The verdict check (measure 6): comparisons finished per kind, and comparisons started per kind. */
  compareEach: 5,
  compareStartsEach: 10,
  /** A comparison that could not start within this long of its verify is dropped. */
  comparePendingMs: 30 * 60_000,
  /** Pull requests whose assignment is remembered. */
  groupsKept: 5000,
});

export type FirstPartSetting = 'off' | 'on' | 'alternate';
export type FirstPartGroup = 'with' | 'without';

/** `monitoring.localVerify.likelyFailingFirst`: exactly `on` or `alternate`; anything else (absent included) is `off`. */
export function parseFirstPartSetting(v: unknown): FirstPartSetting {
  return v === 'on' || v === 'alternate' ? v : 'off';
}

/**
 * What a run child is told (absent ⇒ the setting is off on this machine and the verify runs
 * exactly as before this feature). `group` is the coordinator's assignment of the pull request.
 */
export interface FirstPartInput {
  setting: 'on' | 'alternate';
  group?: FirstPartGroup;
  /** The files this same change failed on in its previous verify (at most 3). */
  previous: readonly string[];
  /** The likely-failing list in use, in its order (at most 90). */
  list: readonly string[];
}

/** Whether this verify uses first parts: `on`, or `alternate` for a pull request assigned `with`. */
export function firstPartActive(i: FirstPartInput | undefined, kind: 'main' | undefined): boolean {
  if (!i || kind === 'main') return false;
  return i.setting === 'on' || (i.setting === 'alternate' && i.group === 'with');
}

/** Characters a path may not contain to be named to the test runner (`--exclude=` reads a pattern). */
const WILDCARD = /[*?[\]{}()!+@|,\\]/;

export function hasWildcard(p: string): boolean {
  return WILDCARD.test(p);
}

export interface FirstPartSelection {
  /** The first part's files, sorted. Empty ⇒ the lane starts as it does without this feature. */
  files: string[];
  fromChange: number;
  fromPrevious: number;
  fromList: number;
  /** Files that came in only because their path overlaps a chosen file's path. */
  partners: number;
  /** Recorded time of the chosen files (an untimed file counts as 10 s); null for the unit lane. */
  ms: number | null;
}

/**
 * Choose one lane's first part. Filled in order: the change's own files of this lane, its
 * previous failures, then the list, in the list's order. Only files of the lane are ever chosen
 * (so a deleted file, a non-test file or another lane's file drops out). The test runner matches
 * a named file by case-insensitive substring, so files whose paths overlap in either direction
 * form a group that is taken whole or left whole: a group that would pass the lane's limit (by
 * count, or by 60 s of recorded time on the two slower lanes), or that holds a path with a
 * wildcard character, stays in the rest. Pure and deterministic.
 */
export function selectFirstPart(i: {
  lane: LaneName;
  laneFiles: readonly string[];
  /** Every path the change touches; null when that could not be read (then there are none). */
  changed: ReadonlySet<string> | null;
  previous: readonly string[];
  list: readonly string[];
  durations: FileDurations;
}): FirstPartSelection {
  const out: FirstPartSelection = { files: [], fromChange: 0, fromPrevious: 0, fromList: 0, partners: 0, ms: null };
  const laneFiles = [...new Set(i.laneFiles)];
  const inLane = new Set(laneFiles);
  const maxFiles = FIRST_PART_LIMITS.files[i.lane];
  const timed = FIRST_PART_LIMITS.timedLanes.includes(i.lane);
  const cost = (f: string) => (Number.isFinite(i.durations[f]) && i.durations[f] >= 0 ? i.durations[f] : FIRST_PART_LIMITS.untimedMs);

  type Source = 'fromChange' | 'fromPrevious' | 'fromList';
  const candidates: Array<{ file: string; source: Source }> = [];
  const seen = new Set<string>();
  const offer = (file: unknown, source: Source) => {
    if (typeof file !== 'string' || !inLane.has(file) || seen.has(file)) return;
    seen.add(file);
    candidates.push({ file, source });
  };
  for (const f of i.changed ? [...i.changed].sort() : []) offer(f, 'fromChange');
  for (const f of i.previous) offer(f, 'fromPrevious');
  for (const f of i.list) offer(f, 'fromList');
  if (candidates.length === 0) return out;

  const lower = laneFiles.map((f) => f.toLowerCase());
  /** The files that must run in the same process as `file`: its overlap group (see shardPlan.ts). */
  const groupOf = (file: string): string[] => {
    const group = new Set<string>([file]);
    const todo = [file.toLowerCase()];
    while (todo.length > 0) {
      const a = todo.pop()!;
      for (let k = 0; k < laneFiles.length; k++) {
        if (group.has(laneFiles[k])) continue;
        if (lower[k].includes(a) || a.includes(lower[k])) { group.add(laneFiles[k]); todo.push(lower[k]); }
      }
    }
    return [...group];
  };

  const chosen = new Set<string>();
  const sourceOf = new Map(candidates.map((c) => [c.file, c.source]));
  let ms = 0;
  for (const c of candidates) {
    if (chosen.has(c.file)) continue;
    const group = groupOf(c.file);
    if (group.some(hasWildcard)) continue;
    if (chosen.size + group.length > maxFiles) continue;
    const groupMs = group.reduce((n, f) => n + cost(f), 0);
    if (timed && ms + groupMs > FIRST_PART_LIMITS.maxMs) continue;
    for (const f of group) {
      chosen.add(f);
      const s = sourceOf.get(f);
      if (s) out[s]++; else out.partners++;
    }
    ms += groupMs;
  }
  out.files = [...chosen].sort();
  out.ms = timed ? ms : null;
  return out;
}

// ── The request field that carries the list to a peer ──────────────────

/** The one request field: the list in use and the change's previous failures. */
export interface LikelyFailingWire {
  list: string[];
  previous: string[];
}

/**
 * Bound what is sent with a verify: the previous failures (at most 3) and then the list, at
 * most 100 paths in total. A path longer than 300 characters is left out and returned in
 * `dropped` (the caller writes the audit row), so a legitimate long path can never refuse a
 * request; that file simply runs in its lane as usual. `field` is null when nothing is left.
 */
export function boundLikelyFailingWire(list: readonly string[], previous: readonly string[]): { field: LikelyFailingWire | null; dropped: string[] } {
  const L = FIRST_PART_LIMITS;
  const dropped: string[] = [];
  const ok = (p: unknown): p is string => {
    if (typeof p !== 'string' || p.length === 0) return false;
    if (p.length > L.pathChars) { dropped.push(p); return false; }
    return true;
  };
  const prev = [...new Set(previous.filter(ok))].slice(0, L.previousMax);
  const rest = [...new Set(list.filter(ok))].slice(0, Math.min(L.listUsed, L.wirePaths - prev.length));
  return { field: prev.length + rest.length === 0 ? null : { list: rest, previous: prev }, dropped };
}

/**
 * Parse the request field. Exactly the keys `list` and `previous`, each an array of non-empty
 * strings of at most 300 characters, at most 100 paths in total and at most 3 previous. Anything
 * else is malformed (null): the caller refuses the whole request, as for every other field.
 */
export function parseLikelyFailingWire(v: unknown): LikelyFailingWire | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const x = v as Record<string, unknown>;
  if (!Object.keys(x).every((k) => k === 'list' || k === 'previous')) return null;
  const L = FIRST_PART_LIMITS;
  const paths = (a: unknown): a is string[] => Array.isArray(a) && a.every((p) => typeof p === 'string' && p.length > 0 && p.length <= L.pathChars);
  if (!paths(x.list) || !paths(x.previous)) return null;
  if (x.previous.length > L.previousMax || x.list.length + x.previous.length > L.wirePaths) return null;
  if (x.list.length + x.previous.length === 0) return null; // the field is sent only when it is not empty
  return { list: [...x.list], previous: [...x.previous] };
}

// ── What a run reports about its first parts ───────────────────────────

/** One lane's first part, as numbers (the file names stay in the run log). */
export interface FirstPartLaneSummary {
  lane: LaneName;
  files: number;
  fromChange: number;
  fromPrevious: number;
  fromList: number;
  partners: number;
  /** How long the first part's process took; null when it never ran. */
  ms: number | null;
  /** The lane failed finally in its first part and did not start the rest. */
  endedHere: boolean;
}

/** What a verify's result says about its first parts (the service writes it to the audit log). */
export interface FirstPartSummary {
  setting: 'on' | 'alternate';
  group?: FirstPartGroup;
  /** Whether this verify used first parts. */
  active: boolean;
  lanes: FirstPartLaneSummary[];
  /** The verify ended as failed in a first part. */
  endedInFirstPart: boolean;
}
