/**
 * LadderEvidenceReader — turns a ladder's `jsonl-log` metrics into numbers.
 *
 * Spec: docs/specs/feature-maturation-ladder.md §3. Streams each distinct file
 * once, off the event loop, across its rotated segments. A failed, oversized or
 * cut read leaves the metric without a number: absence reads as "not enough
 * evidence", never as a pass. Rows are counted and dropped, never kept or returned.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { isEvidenceFileAllowed, type JsonlLogRef } from './MaturationLadder.js';

export const MAX_FILE_BYTES = 512 * 1024 * 1024;
const DAY_MS = 86_400_000;
const TIME_FIELDS = ['at', 'timestamp', 'ts', 'time', 'createdAt', 'observedAt'];
export const RAN_FRESH_DAYS = 7;

export interface JsonlQuery {
  key: string;
  ref: JsonlLogRef;
  sinceMs: number;
  direction: 'at-least' | 'at-most';
  /** A `ran` metric whose newest match is stale reads as nothing at all. */
  freshWithinMs?: number;
}

export interface JsonlReading {
  value: number | null;
  samples: number;
  newestAt: number | null;
  coverageDays?: number;
  reason?: string;
}

function matches(row: Record<string, unknown>, want: Record<string, string | number | boolean> | undefined): boolean {
  if (!want) return true;
  for (const [k, v] of Object.entries(want)) if (row[k] !== v) return false;
  return true;
}

function rowTime(row: Record<string, unknown>, field: string | undefined): number | null {
  const fields = field ? [field] : TIME_FIELDS;
  for (const f of fields) {
    const v = row[f];
    if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
    if (typeof v === 'string') {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
  }
  return null;
}

interface Tally {
  q: JsonlQuery;
  where: number;
  of: number;
  newest: number | null;
  oldest: number | null;
  /** dedupe: last row per value wins. */
  seen: Map<string, { where: boolean; of: boolean }> | null;
}

/** Resolve an evidence file, refusing anything that escapes the agent home. */
export function resolveEvidenceFile(projectDir: string, file: string): string | null {
  if (!isEvidenceFileAllowed(file)) return null;
  const full = path.join(projectDir, file);
  try {
    const home = fs.realpathSync(projectDir);
    const real = fs.realpathSync(full);
    if (!real.startsWith(home + path.sep)) return null;
    return full;
  } catch {
    return full; // not there yet; the read reports it as empty
  }
}

function segmentsOf(full: string): { paths: string[]; compressed: boolean; rotated: boolean } {
  const dir = path.dirname(full);
  const base = path.basename(full);
  const paths: Array<{ seq: number; p: string }> = [];
  let compressed = false;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(`${base}.`)) continue;
      const rest = name.slice(base.length + 1);
      if (/^\d+\.gz$/.test(rest)) compressed = true;
      else if (/^\d+$/.test(rest)) paths.push({ seq: Number(rest), p: path.join(dir, name) });
    }
  } catch { /* @silent-fallback-ok — no directory yet means no rows, which reads as no evidence */ }
  paths.sort((a, b) => a.seq - b.seq);
  return { paths: [...paths.map(x => x.p), full], compressed, rotated: paths.length > 0 || compressed };
}

async function readOneFile(p: string, tallies: Tally[]): Promise<void> {
  let lst: fs.Stats;
  try { lst = await fs.promises.lstat(p); } catch { return; }
  if (lst.isSymbolicLink() || !lst.isFile()) return;
  const stream = fs.createReadStream(p, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line || line[0] !== '{') continue;
      let row: Record<string, unknown>;
      try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      for (const t of tallies) {
        const when = rowTime(row, t.q.ref.timeField);
        if (when === null) continue;
        if (t.oldest === null || when < t.oldest) t.oldest = when;
        if (when < t.q.sinceMs) continue;
        const isWhere = matches(row, t.q.ref.where);
        const isOf = matches(row, t.q.ref.of);
        if (t.seen && t.q.ref.dedupe) {
          const key = row[t.q.ref.dedupe];
          if (typeof key === 'string' || typeof key === 'number') t.seen.set(String(key), { where: isWhere, of: isOf });
          if (isWhere && (t.newest === null || when > t.newest)) t.newest = when;
          continue;
        }
        if (isWhere) {
          t.where++;
          if (t.newest === null || when > t.newest) t.newest = when;
        }
        if (isOf) t.of++;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

function finish(t: Tally, rotated: boolean, compressed: boolean, now: number): JsonlReading {
  if (t.seen) {
    for (const v of t.seen.values()) {
      if (v.where) t.where++;
      if (v.of) t.of++;
    }
  }
  const { ref, direction, freshWithinMs } = t.q;
  const newestAt = t.newest;
  if (freshWithinMs !== undefined && (newestAt === null || now - newestAt > freshWithinMs)) {
    return { value: 0, samples: 0, newestAt };
  }
  const covered = t.oldest === null ? 0 : (now - t.oldest) / DAY_MS;
  const cut = (rotated || compressed) && t.oldest !== null && t.oldest > t.q.sinceMs;
  const coverage = cut ? { coverageDays: Math.floor(covered * 10) / 10 } : {};
  const isCount = ref.value === 'count';
  // A cut read can only be trusted when missing rows cannot flip the answer: an at-least count.
  if (cut && !(isCount && direction === 'at-least')) {
    return { value: null, samples: 0, newestAt, ...coverage, reason: 'evidence-cut' };
  }
  if (isCount) return { value: t.where, samples: t.of, newestAt, ...coverage };
  if (t.of === 0) return { value: null, samples: 0, newestAt, ...coverage };
  return { value: t.where / t.of, samples: t.of, newestAt, ...coverage };
}

/** Answer every query, reading each distinct file once. Never throws. */
export async function readJsonlQueries(
  projectDir: string,
  queries: JsonlQuery[],
  now: number,
): Promise<Map<string, JsonlReading>> {
  const out = new Map<string, JsonlReading>();
  const byFile = new Map<string, JsonlQuery[]>();
  for (const q of queries) {
    const list = byFile.get(q.ref.file) ?? [];
    list.push(q);
    byFile.set(q.ref.file, list);
  }
  for (const [file, group] of byFile) {
    const full = resolveEvidenceFile(projectDir, file);
    if (!full) {
      for (const q of group) out.set(q.key, { value: null, samples: 0, newestAt: null, reason: 'file-refused' });
      continue;
    }
    const { paths, compressed, rotated } = segmentsOf(full);
    let total = 0;
    for (const p of paths) {
      try { total += (await fs.promises.stat(p)).size; } catch { /* @silent-fallback-ok — a segment that vanished between list and stat has no rows to count */ }
    }
    if (total > MAX_FILE_BYTES) {
      for (const q of group) out.set(q.key, { value: null, samples: 0, newestAt: null, reason: 'file-too-large' });
      continue;
    }
    const tallies: Tally[] = group.map(q => ({ q, where: 0, of: 0, newest: null, oldest: null, seen: q.ref.dedupe ? new Map() : null }));
    try {
      for (const p of paths) {
        await readOneFile(p, tallies);
        await new Promise(resolve => setImmediate(resolve));
      }
      for (const t of tallies) out.set(t.q.key, finish(t, rotated, compressed, now));
    } catch {
      for (const q of group) out.set(q.key, { value: null, samples: 0, newestAt: null, reason: 'read-failed' });
    }
  }
  return out;
}
