/**
 * Duration-balanced shards for the slow lanes (spec local-verify-merge-authority.md,
 * "Balanced shards"). vitest's own `--shard=k/n` splits by file count, and the e2e
 * lane's two shards measured 9.3 and 16.8 minutes (median, 2026-10-20..26): the
 * slower shard set the length of every run. Here each shard gets an explicit file
 * list, assigned longest-first to the shard with the least work so far, using the
 * per-file durations of earlier runs on this machine.
 *
 * Pure and deterministic over its inputs. Durations only change WHICH process runs a
 * file, never WHETHER it runs: every lane file is assigned to exactly one shard, and
 * the lane-report rules (a file reported twice fails the lane; a file not reported is
 * `file-not-run`) still apply after the shard reports are joined.
 */

/** Below this share of lane files with a known duration, fall back to vitest's `--shard`. */
export const MIN_DURATION_COVERAGE = 0.5;
/** Weight of the newest observation when blending a file's duration with its history. */
const NEWEST_WEIGHT = 0.5;
/** Above this size the history file is ignored unread (it lives where test code can write). */
export const DURATIONS_MAX_BYTES = 2 * 1024 * 1024;
/** Cap on stored entries (a test tree a few times today's size). */
export const DURATIONS_MAX_FILES = 20_000;

export type FileDurations = Record<string, number>;

/**
 * Explicit per-shard file lists, or null when the history covers too few of the lane's
 * files (the caller then uses vitest's own `--shard=k/n`). A file with no history is
 * assumed to take the median known duration.
 */
export function planShards(files: readonly string[], shards: number, durations: FileDurations): string[][] | null {
  if (shards < 2 || files.length === 0) return null;
  const unique = [...new Set(files)];
  const known = unique.filter((f) => Number.isFinite(durations[f]) && durations[f] >= 0);
  if (known.length / unique.length < MIN_DURATION_COVERAGE) return null;
  const sorted = known.map((f) => durations[f]).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const weight = (f: string) => (Number.isFinite(durations[f]) && durations[f] >= 0 ? durations[f] : median);
  // vitest's positional filters match by case-insensitive substring, so a file whose path
  // contains another file's path would also run in that file's shard. Such files are kept
  // together as one unit, so every file still runs in exactly one shard.
  const groups = filterOverlapGroups(unique);
  const gw = (g: string[]) => g.reduce((n, f) => n + weight(f), 0);
  const order = groups.sort((a, b) => gw(b) - gw(a) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const bins: Array<{ files: string[]; total: number }> = Array.from({ length: shards }, () => ({ files: [], total: 0 }));
  for (const g of order) {
    let best = 0;
    for (let k = 1; k < bins.length; k++) if (bins[k].total < bins[best].total) best = k;
    bins[best].files.push(...g);
    bins[best].total += gw(g);
  }
  // A shard with no files would run vitest with no filter (= every file): never emit one.
  if (bins.some((b) => b.files.length === 0)) return null;
  return bins.map((b) => [...b.files].sort());
}

/**
 * Files that must share a shard: `a` and `b` are joined when one's lower-cased path contains
 * the other's (vitest's filter rule). Sorted members, groups in first-file order.
 */
export function filterOverlapGroups(files: readonly string[]): string[][] {
  const parent = new Map(files.map((f) => [f, f]));
  const find = (f: string): string => { let r = f; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(f, r); return r; };
  const lower = files.map((f) => f.toLowerCase());
  for (let i = 0; i < files.length; i++) {
    for (let j = 0; j < files.length; j++) {
      if (i !== j && lower[j].includes(lower[i])) parent.set(find(files[i]), find(files[j]));
    }
  }
  const out = new Map<string, string[]>();
  for (const f of files) { const r = find(f); const g = out.get(r) ?? []; g.push(f); out.set(r, g); }
  return [...out.values()].map((g) => g.sort());
}

/** Blend new observations into the stored durations (bounded; unparseable input is ignored). */
export function mergeDurations(previous: unknown, observed: FileDurations): FileDurations {
  const out: FileDurations = {};
  if (previous && typeof previous === 'object' && !Array.isArray(previous)) {
    for (const [f, v] of Object.entries(previous as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[f] = v;
    }
  }
  for (const [f, v] of Object.entries(observed)) {
    if (!Number.isFinite(v) || v < 0) continue;
    out[f] = f in out ? Math.round(out[f] * (1 - NEWEST_WEIGHT) + v * NEWEST_WEIGHT) : Math.round(v);
  }
  const keys = Object.keys(out);
  if (keys.length > DURATIONS_MAX_FILES) for (const k of keys.slice(0, keys.length - DURATIONS_MAX_FILES)) delete out[k];
  return out;
}
