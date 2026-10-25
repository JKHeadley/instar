/**
 * latest-run-per-check — the ONE rule for "which run of a check counts".
 *
 * GitHub judges a required context by the LATEST run of each check name: a
 * failed run superseded by a passing rerun on the same head is green. Both the
 * green-PR watcher (src/monitoring/greenPrLogic.ts) and safe-merge
 * (scripts/safe-merge.mjs) collapse their check lists with this module, so the
 * watcher and the act-time authority can never disagree about a rerun
 * (2026-07-08 watcher bug; 2026-10-22 safe-merge `refused:red-checks` on PR 2289).
 *
 * Rule: group by workflow + check name (GitHub supersedes a run only within the
 * same workflow — a passing `e2e` in workflow B never hides a failing `e2e` in
 * workflow A); the run that COMPLETED most recently wins, as GitHub judges a
 * required check (PR 2296, 2026-10-22: a shard that started first but was
 * cancelled last blocked the merge on GitHub; ties go to the later row). A row with no workflow identity keys
 * on the name alone, so it never supersedes a row that has one (both are kept:
 * fail toward keeping the red). A run still open (queued or in progress) is never
 * the superseded run: it completes last, so it wins and keeps a settle loop waiting. Unnamed runs never
 * collapse together.
 *
 * Pure, dependency-free: safe-merge runs before compile, and its import closure
 * is hash-pinned by the merge runner.
 */

/** A gh timestamp (ISO string or ms) as ms; 0 when absent, unparseable or not after the epoch (gh's 0001-01-01 placeholder). */
export function runTimeMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 0 ? v : 0;
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    return Number.isFinite(t) && t > 0 ? t : 0;
  }
  return 0;
}

/**
 * Keep the latest run per check name.
 * @template T
 * @param {T[]} rows
 * @param {{ name: (r: T) => string, workflow?: (r: T) => string, order: (r: T) => number, open: (r: T) => boolean }} acc
 * @returns {T[]} named winners (first-seen key order), then unnamed rows as-is
 */
export function latestPerName(rows, acc) {
  if (!Array.isArray(rows)) return [];
  const byName = new Map();
  const anon = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const n = String(acc.name(row) ?? '').trim();
    if (!n) { anon.push(row); continue; }
    const wf = acc.workflow ? String(acc.workflow(row) ?? '').trim() : '';
    const key = `${wf}\0${n}`;
    const prev = byName.get(key);
    if (prev === undefined || supersedes(row, prev, acc)) byName.set(key, row);
  }
  return [...byName.values(), ...anon];
}

function supersedes(candidate, prev, acc) {
  const co = acc.order(candidate);
  const po = acc.order(prev);
  // A run still open (queued or in progress) will complete last, so it is the latest.
  const cOpen = acc.open(candidate);
  const pOpen = acc.open(prev);
  if (cOpen && !pOpen) return true;
  if (pOpen && !cOpen) return false;
  return co >= po;
}
