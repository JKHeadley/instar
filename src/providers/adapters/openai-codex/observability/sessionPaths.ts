/**
 * Shared helpers for locating Codex session files on disk.
 *
 * Codex writes rollout files to `$CODEX_HOME/sessions/YYYY/MM/DD/
 * rollout-<ts>-<uuid>.jsonl` — date-partitioned, unlike Claude's flat
 * directory layout. These helpers find a session's rollout file by UUID.
 *
 * RULE 3.1 RATIONALE
 *   Criticality: high (driver of conversation-log reads, resume index, etc.)
 *   Frequency:   per-read (per-resume, per-conversation-replay)
 *   Stability:   semi-stable (Codex changes session layout occasionally)
 *   Fallback:    none — if the layout changes, callers get empty results
 *   Verdict:     deterministic FS walk + canary (canary at canary/codexSessionLayoutCanary.ts)
 */

import { promises as fs, readdirSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

export function codexHomeFromConfig(codexHome?: string): string {
  return codexHome ?? path.join(homedir(), '.codex');
}

function sessionsRootFor(codexHome?: string): string {
  return path.join(codexHomeFromConfig(codexHome), 'sessions');
}

// ── Rollout lookup by thread UUID ─────────────────────────────────────────
//
// Why this is not a plain recursive walk (2026-10-13 server-loop freeze): the
// previous walker `statSync`ed EVERY entry under `$CODEX_HOME/sessions` before
// even looking at its name, so a MISSING uuid (a Claude transcript id sent here
// by a framework-blind caller) cost one stat per archived rollout — 286,984 on
// one machine, ~25 s of blocked event loop per call, once a minute from the
// resume heartbeat. The supervisor then restarted a healthy server three times
// in a morning.
//
// The lookup now works in this order, cheapest first:
//   1. Exact known path — a per-process positive cache, validated with ONE stat.
//   2. A short-lived miss cache (TTL + the newest partition's mtime as a
//      generation stamp) so a repeated miss costs one small readdir chain.
//   3. UUIDv7 partition hint — codex thread ids are UUIDv7, whose first 48 bits
//      are the creation time in ms; the rollout lives in the local-date
//      partition of that instant (checked with ±1 day for the midnight edge).
//      A hinted lookup reads 1–3 directories by NAME only — no per-file stat.
//   4. Sync callers only: a bounded readdir-only scan newest-first, capped at
//      SYNC_SCAN_NAME_BUDGET names, so a small archive still resolves a
//      non-v7 id synchronously while a large one costs milliseconds, not
//      seconds.
//   5. Async enumeration (yielding between directories and every
//      ASYNC_YIELD_EVERY_NAMES names, capped at ASYNC_SCAN_NAME_BUDGET) — the
//      only path that can cover the whole archive. A sync caller whose bounded
//      scan ran out of budget schedules it in the background (single-flight per
//      uuid) and answers an honest miss now; the next call reads the cache.
//
// Filenames are tested BEFORE any stat on every path. `rolloutLookupStats()`
// exposes the counters so tests can prove a lookup never statted the archive.

/** How long a miss from the cheap paths (hint / bounded sync scan) is remembered. */
export const ROLLOUT_MISS_TTL_MS = 60_000;
/**
 * How long a miss is remembered once a FULL async enumeration has covered the
 * archive. Longer than the cheap-path TTL so an untagged stale id polled every
 * minute cannot re-enumerate hundreds of thousands of names every other tick;
 * still dropped early by the newest-partition generation stamp and by
 * `invalidateRolloutLookup`.
 */
export const ROLLOUT_ENUMERATED_MISS_TTL_MS = 5 * 60_000;
/** Names a SYNC lookup may scan before deferring the rest to async enumeration. */
export const SYNC_SCAN_NAME_BUDGET = 20_000;
/** Names an ASYNC enumeration may scan before giving up (bounded work). */
export const ASYNC_SCAN_NAME_BUDGET = 2_000_000;
/** The async enumeration yields the event loop at least this often within one directory. */
export const ASYNC_YIELD_EVERY_NAMES = 5_000;

export interface RolloutLookupStats {
  positiveHits: number;
  negativeHits: number;
  hintedPartitionReads: number;
  syncDirectoryReads: number;
  syncNamesScanned: number;
  syncBudgetExhausted: number;
  asyncEnumerations: number;
  asyncDirectoryReads: number;
  asyncNamesScanned: number;
  asyncBudgetExhausted: number;
  statCalls: number;
}

const positiveCache = new Map<string, string>();
const negativeCache = new Map<string, { expiresAt: number; generation: string }>();
const inflight = new Map<string, Promise<string | null>>();
const stats: RolloutLookupStats = {
  positiveHits: 0, negativeHits: 0, hintedPartitionReads: 0,
  syncDirectoryReads: 0, syncNamesScanned: 0, syncBudgetExhausted: 0,
  asyncEnumerations: 0, asyncDirectoryReads: 0, asyncNamesScanned: 0, asyncBudgetExhausted: 0,
  statCalls: 0,
};

/** Snapshot of the lookup counters (tests + observability). */
export function rolloutLookupStats(): RolloutLookupStats {
  return { ...stats };
}

/** Drop every cached rollout lookup result and zero the counters (tests). */
export function resetRolloutLookupState(): void {
  positiveCache.clear();
  negativeCache.clear();
  inflight.clear();
  for (const k of Object.keys(stats) as Array<keyof RolloutLookupStats>) stats[k] = 0;
}

/**
 * Forget a remembered MISS so the next lookup re-reads the archive. Call it
 * when a rollout is known to have just been written (CodexResumeMap.save).
 * With no uuid, every remembered miss is dropped.
 */
export function invalidateRolloutLookup(threadId?: string, codexHome?: string): void {
  if (!threadId) {
    negativeCache.clear();
    return;
  }
  negativeCache.delete(cacheKey(sessionsRootFor(codexHome), threadId));
}

/** The in-flight async enumeration for a uuid, if one is running (tests await it). */
export function pendingRolloutLookup(threadId: string, codexHome?: string): Promise<string | null> | null {
  return inflight.get(cacheKey(sessionsRootFor(codexHome), threadId)) ?? null;
}

function cacheKey(root: string, uuid: string): string {
  return `${root}\u0000${uuid}`;
}

function isRolloutName(name: string, uuid: string): boolean {
  return name.startsWith('rollout-') && name.endsWith('.jsonl') && name.includes(uuid);
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * The `YYYY/MM/DD` partitions a UUIDv7 thread id's rollout can live in (local
 * date of the embedded creation instant, then the next day, then the previous
 * — codex partitions by LOCAL date, verified against the archive). Null for a
 * non-v7 id (a Claude v4 id, a legacy id), which carries no date.
 */
export function rolloutPartitionHint(threadId: string): string[] | null {
  const m = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(threadId);
  if (!m) return null;
  const ms = parseInt(m[1] + m[2], 16);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const base = new Date(ms);
  if (Number.isNaN(base.getTime())) return null;
  const day = (offset: number): string => {
    const d = new Date(base);
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  };
  return [day(0), day(1), day(-1)];
}

/**
 * A cheap stamp that changes whenever a rollout could have been added: the
 * newest day-partition's path + mtime (a new file in a directory bumps the
 * directory's mtime; a new day adds a newer partition). Three small readdirs
 * and one stat — never a walk.
 */
function partitionGeneration(root: string): string {
  const newest = (dir: string, re: RegExp): string | null => {
    try {
      const names = readdirSync(dir).filter((e) => re.test(e)).sort();
      return names.length > 0 ? names[names.length - 1] : null;
    } catch {
      return null;
    }
  };
  const y = newest(root, /^\d{4}$/);
  const m = y ? newest(path.join(root, y), /^\d{2}$/) : null;
  const d = y && m ? newest(path.join(root, y, m), /^\d{2}$/) : null;
  const dir = y && m && d ? path.join(root, y, m, d) : root;
  try {
    stats.statCalls++;
    return `${dir}:${statSync(dir).mtimeMs}`;
  } catch {
    return `${dir}:unreadable`;
  }
}

function positiveLookupSync(key: string): string | null {
  const known = positiveCache.get(key);
  if (!known) return null;
  try {
    stats.statCalls++;
    if (statSync(known).isFile()) {
      stats.positiveHits++;
      return known;
    }
  } catch {
    // The remembered file is gone — fall through and re-discover.
  }
  positiveCache.delete(key);
  return null;
}

async function positiveLookupAsync(key: string): Promise<string | null> {
  const known = positiveCache.get(key);
  if (!known) return null;
  try {
    stats.statCalls++;
    if ((await fs.stat(known)).isFile()) {
      stats.positiveHits++;
      return known;
    }
  } catch {
    // Gone — re-discover.
  }
  positiveCache.delete(key);
  return null;
}

function missIsFresh(key: string, root: string): boolean {
  const entry = negativeCache.get(key);
  if (!entry) return false;
  if (Date.now() >= entry.expiresAt || entry.generation !== partitionGeneration(root)) {
    negativeCache.delete(key);
    return false;
  }
  stats.negativeHits++;
  return true;
}

function recordHit(key: string, full: string): string {
  positiveCache.set(key, full);
  negativeCache.delete(key);
  return full;
}

function recordMiss(key: string, root: string, ttlMs: number = ROLLOUT_MISS_TTL_MS): null {
  negativeCache.set(key, { expiresAt: Date.now() + ttlMs, generation: partitionGeneration(root) });
  return null;
}

/** readdir one partition by NAME; confirm the single match with one stat. */
function scanPartitionSync(dir: string, uuid: string, counter: 'hintedPartitionReads' | 'syncDirectoryReads'): string | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  stats[counter]++;
  stats.syncNamesScanned += names.length;
  for (const name of names) {
    if (!isRolloutName(name, uuid)) continue;
    const full = path.join(dir, name);
    try {
      stats.statCalls++;
      if (statSync(full).isFile()) return full;
    } catch {
      continue;
    }
  }
  return null;
}

function listDayPartitionsDescendingSync(root: string): string[] | null {
  const readDesc = (dir: string, re: RegExp): string[] => {
    try {
      return readdirSync(dir).filter((e) => re.test(e)).sort().reverse();
    } catch {
      return [];
    }
  };
  const dirs: string[] = [];
  for (const y of readDesc(root, /^\d{4}$/)) {
    const yPath = path.join(root, y);
    for (const m of readDesc(yPath, /^\d{2}$/)) {
      const mPath = path.join(yPath, m);
      for (const d of readDesc(mPath, /^\d{2}$/)) dirs.push(path.join(mPath, d));
    }
  }
  return dirs.length > 0 ? dirs : null;
}

/**
 * Bounded sync scan: partitions newest-first (or a Dirent walk for a flat
 * layout), names only, at most SYNC_SCAN_NAME_BUDGET names. `exhausted` means
 * the archive was NOT fully covered — the caller defers the rest to async.
 */
function boundedSyncScan(root: string, uuid: string): { found: string | null; exhausted: boolean } {
  let budget = SYNC_SCAN_NAME_BUDGET;
  const partitions = listDayPartitionsDescendingSync(root);
  if (partitions) {
    for (const dir of partitions) {
      if (budget <= 0) {
        stats.syncBudgetExhausted++;
        return { found: null, exhausted: true };
      }
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      stats.syncDirectoryReads++;
      stats.syncNamesScanned += names.length;
      budget -= names.length;
      for (const name of names) {
        if (!isRolloutName(name, uuid)) continue;
        const full = path.join(dir, name);
        try {
          stats.statCalls++;
          if (statSync(full).isFile()) return { found: full, exhausted: false };
        } catch {
          continue;
        }
      }
    }
    return { found: null, exhausted: false };
  }
  // Flat / unexpected layout: a bounded Dirent walk (directory-ness comes from
  // the dirent, so still no per-file stat).
  const state = { budget, found: null as string | null, exhausted: false };
  const walk = (dir: string): void => {
    if (state.found || state.exhausted) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    stats.syncDirectoryReads++;
    stats.syncNamesScanned += entries.length;
    state.budget -= entries.length;
    if (state.budget < 0) {
      stats.syncBudgetExhausted++;
      state.exhausted = true;
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name));
        if (state.found || state.exhausted) return;
      } else if (isRolloutName(entry.name, uuid) && entry.isFile()) {
        state.found = path.join(dir, entry.name);
        return;
      }
    }
  };
  walk(root);
  return { found: state.found, exhausted: state.exhausted };
}

/**
 * Full async enumeration, single-flight per (root, uuid). Yields the event loop
 * between directories and within a large one; bounded by ASYNC_SCAN_NAME_BUDGET.
 * Settles the caches so a later sync lookup answers from them.
 */
function enumerateAsync(root: string, uuid: string, key: string): Promise<string | null> {
  const running = inflight.get(key);
  if (running) return running;
  const task = (async (): Promise<string | null> => {
    stats.asyncEnumerations++;
    let budget = ASYNC_SCAN_NAME_BUDGET;
    const partitions = await listDayPartitionsDescending(root);
    const dirs = partitions ?? [root];
    const flat = partitions === null;
    const queue = [...dirs];
    while (queue.length > 0) {
      const dir = queue.shift() as string;
      if (budget <= 0) {
        stats.asyncBudgetExhausted++;
        return recordMiss(key, root, ROLLOUT_ENUMERATED_MISS_TTL_MS);
      }
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      stats.asyncDirectoryReads++;
      stats.asyncNamesScanned += entries.length;
      budget -= entries.length;
      let sinceYield = 0;
      for (const entry of entries) {
        if (++sinceYield >= ASYNC_YIELD_EVERY_NAMES) {
          sinceYield = 0;
          await yieldToEventLoop();
        }
        if (flat && entry.isDirectory()) {
          queue.push(path.join(dir, entry.name));
        } else if (isRolloutName(entry.name, uuid) && entry.isFile()) {
          return recordHit(key, path.join(dir, entry.name));
        }
      }
      await yieldToEventLoop();
    }
    return recordMiss(key, root, ROLLOUT_ENUMERATED_MISS_TTL_MS);
  })().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, task);
  return task;
}

/** Find a rollout JSONL file by Codex thread UUID. Returns null on miss. */
export async function findRolloutFile(
  threadId: string,
  codexHome?: string,
): Promise<string | null> {
  if (!threadId) return null;
  const root = sessionsRootFor(codexHome);
  const key = cacheKey(root, threadId);
  const known = await positiveLookupAsync(key);
  if (known) return known;
  // A sync caller may have recorded a cheap-path miss AND started the full
  // enumeration; an async caller joins that enumeration instead of repeating
  // the miss for the rest of its TTL (second-pass review).
  const running = inflight.get(key);
  if (running) return running;
  if (missIsFresh(key, root)) return null;
  const hint = rolloutPartitionHint(threadId);
  if (hint) {
    for (const rel of hint) {
      const dir = path.join(root, rel);
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      stats.hintedPartitionReads++;
      stats.asyncNamesScanned += names.length;
      for (const name of names) {
        if (!isRolloutName(name, threadId)) continue;
        const full = path.join(dir, name);
        try {
          stats.statCalls++;
          if ((await fs.stat(full)).isFile()) return recordHit(key, full);
        } catch {
          continue;
        }
      }
    }
  }
  return enumerateAsync(root, threadId, key);
}

/**
 * Synchronous variant of {@link findRolloutFile} for callers on a sync code
 * path — the resume-map `jsonlExists` guards (ThreadResumeMap, TopicResumeMap)
 * and CodexResumeMap.get. Never walks the archive with per-file stats: it
 * answers from the exact known path, the miss cache, the UUIDv7 partition hint,
 * or a bounded readdir-only scan; anything beyond the budget is enumerated
 * asynchronously in the background and the call answers an honest miss now. A
 * missing `$CODEX_HOME/sessions` (a pure Claude agent) returns null fast.
 */
export function findRolloutFileSync(threadId: string, codexHome?: string): string | null {
  if (!threadId) return null;
  const root = sessionsRootFor(codexHome);
  try {
    statSync(root);
  } catch {
    return null;
  }
  const key = cacheKey(root, threadId);
  const known = positiveLookupSync(key);
  if (known) return known;
  if (missIsFresh(key, root)) return null;
  const hint = rolloutPartitionHint(threadId);
  if (hint) {
    for (const rel of hint) {
      const found = scanPartitionSync(path.join(root, rel), threadId, 'hintedPartitionReads');
      if (found) return recordHit(key, found);
    }
    // A dated id that is not in its own partitions is almost certainly absent;
    // let the background enumeration settle the rare clock-skew case.
    recordMiss(key, root);
    void enumerateAsync(root, threadId, key).catch(() => undefined);
    return null;
  }
  const scan = boundedSyncScan(root, threadId);
  if (scan.found) return recordHit(key, scan.found);
  recordMiss(key, root);
  if (scan.exhausted) void enumerateAsync(root, threadId, key).catch(() => undefined);
  return null;
}

// Always cover at least this many newest non-empty day-partitions before an
// early break, so the cross-midnight boundary (and a session that started
// "yesterday" but is still the most recently active) is not missed.
const MIN_PARTITIONS_SCANNED = 2;

/**
 * Find the single newest codex rollout file SYNCHRONOUSLY → `{ path, size, mtime }`
 * (or null when none / not a codex tree). Used by the RateLimitSentinel's codex
 * recovery-verification, whose callers (`report()` is sync) need a sync read.
 *
 * Rationale: the OpenAI rate limit is ACCOUNT-WIDE, so "did the throttle clear?" ==
 * "is the codex account producing output again?" == "did the newest rollout grow?".
 * The sentinel compares this against the captured baseline size; the existing verify()
 * already handles the newest-file CHANGING between baseline and check (it only counts a
 * size INCREASE, and refreshes the baseline to the current newest each cycle).
 *
 * Perf-safe (same concern as listAllRollouts — a busy account has tens of thousands of
 * rollouts): walk YYYY/MM/DD newest-first, take the newest rollout BY FILENAME (the
 * embedded ISO-ish timestamp makes a lexicographic sort chronological — no stat needed)
 * in the newest non-empty day partition, and `statSync` ONLY that one file. The recovery
 * check runs rarely (only during an active codex throttle recovery), so a single stat is
 * ample. A long-running session with an older filename but a newer mtime is the only
 * miss, and the account-wide signal still catches its growth via whatever rollout IS
 * newest-by-filename in the same window.
 */
export function findNewestRolloutSync(
  codexHome?: string,
): { path: string; size: number; mtime: number } | null {
  const root = path.join(codexHomeFromConfig(codexHome), 'sessions');
  const readDesc = (dir: string, re: RegExp): string[] => {
    try {
      return readdirSync(dir).filter((e) => re.test(e)).sort().reverse();
    } catch {
      return [];
    }
  };
  for (const y of readDesc(root, /^\d{4}$/)) {
    const yPath = path.join(root, y);
    for (const m of readDesc(yPath, /^\d{2}$/)) {
      const mPath = path.join(yPath, m);
      for (const d of readDesc(mPath, /^\d{2}$/)) {
        const dPath = path.join(mPath, d);
        const rollouts = readDesc(dPath, /^rollout-.*\.jsonl$/); // newest-created first
        if (rollouts.length === 0) continue;
        try {
          const full = path.join(dPath, rollouts[0]);
          const st = statSync(full);
          if (st.isFile()) return { path: full, size: st.size, mtime: st.mtimeMs };
        } catch {
          // unreadable newest in this partition — fall through to older partitions
        }
      }
    }
  }
  return null;
}

// `stat` only this multiple of `limit` candidate files — the newest by the
// timestamp embedded in their filename — to resolve the authoritative
// newest-by-mtime. A long-running session (older filename, newer mtime) is still
// caught as long as it is among the newest `limit * STAT_OVERSCAN` created.
const STAT_OVERSCAN = 4;

/**
 * List rollout files under $CODEX_HOME/sessions, newest first (by mtime).
 *
 * Codex partitions rollouts by date: `sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`.
 * A busy account accumulates tens of thousands of these (one real machine: 14k
 * files / 1.4 GB). The original implementation `stat`ed EVERY file before
 * slicing to `limit`; an interim fix narrowed that to the newest partitions but
 * still `stat`ed every file in them (~3.6k on the same machine) — fast in a
 * healthy process, but catastrophic when the server's event loop is CPU-starved
 * (each `await fs.stat` needs a loop turn), which is exactly when `GET
 * /codex/usage` timed out.
 *
 * This avoids the per-file `stat` storm entirely:
 *   1. Enumerate date-partition dirs newest-first; `readdir` (one syscall each,
 *      NO per-file stat) the newest partitions to collect candidate PATHS until
 *      we have >= `limit * STAT_OVERSCAN` of them AND have covered >=
 *      MIN_PARTITIONS_SCANNED non-empty partitions.
 *   2. Sort candidates DESCENDING by path — the zero-padded `YYYY/MM/DD` dir +
 *      `rollout-<ISO-ish-ts>` filename make a lexicographic sort chronological
 *      by CREATION time, no `stat` needed.
 *   3. `stat` ONLY the top `limit * STAT_OVERSCAN` candidates for the
 *      authoritative mtime, sort by mtime, return the newest `limit`.
 *
 * So a `limit`-8 call does ~32 `stat`s instead of ~3.6k. Trade-off: "newest by
 * mtime" becomes "newest by mtime among the newest-created candidates" — exact
 * for the rate-limit reader (account-wide windows are identical across any
 * recently-active session); the only miss for the resume/token-ledger callers is
 * a session whose creation is older than the newest `limit * STAT_OVERSCAN` yet
 * is still the single most-recently-touched file — vanishingly rare. A
 * non-date-partitioned layout falls back to the original full walk.
 */
export async function listAllRollouts(
  codexHome?: string,
  limit = 100,
): Promise<ReadonlyArray<{ path: string; mtime: number }>> {
  const root = path.join(codexHomeFromConfig(codexHome), 'sessions');
  const dayDirs = await listDayPartitionsDescending(root);

  if (dayDirs === null) {
    // Unexpected/flat layout — fall back to the full walk so we never silently
    // miss files just because the date partitions weren't where we expected.
    const all: Array<{ path: string; mtime: number }> = [];
    await walkCollect(root, all);
    all.sort((a, b) => b.mtime - a.mtime);
    return all.slice(0, limit);
  }

  const statTarget = Math.max(limit, 1) * STAT_OVERSCAN;

  // Phase 1: collect candidate PATHS (readdir only — no per-file stat).
  const candidates: string[] = [];
  let partitionsWithFiles = 0;
  for (const dir of dayDirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    let had = false;
    for (const entry of entries) {
      if (!entry.startsWith('rollout-') || !entry.endsWith('.jsonl')) continue;
      candidates.push(path.join(dir, entry));
      had = true;
    }
    if (had) partitionsWithFiles++;
    if (candidates.length >= statTarget && partitionsWithFiles >= MIN_PARTITIONS_SCANNED) break;
  }

  // Phase 2: sort by path descending (chronological by creation), keep the top.
  candidates.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const top = candidates.slice(0, statTarget);

  // Phase 3: stat ONLY the top candidates for authoritative mtime.
  const out: Array<{ path: string; mtime: number }> = [];
  for (const full of top) {
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (stat.isFile()) out.push({ path: full, mtime: stat.mtimeMs });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

/**
 * Enumerate the `sessions/YYYY/MM/DD` day-partition directories in descending
 * date order WITHOUT statting their contents. Returns null when no
 * date-partitioned structure is present (so the caller can fall back to a full
 * walk). Numeric-name sort (zero-padded YYYY/MM/DD) is lexicographic-correct.
 */
async function listDayPartitionsDescending(root: string): Promise<string[] | null> {
  const dirs: string[] = [];
  const years = await readNamesDesc(root, /^\d{4}$/);
  for (const y of years) {
    const yPath = path.join(root, y);
    const months = await readNamesDesc(yPath, /^\d{2}$/);
    for (const m of months) {
      const mPath = path.join(yPath, m);
      const days = await readNamesDesc(mPath, /^\d{2}$/);
      for (const d of days) dirs.push(path.join(mPath, d));
    }
  }
  return dirs.length > 0 ? dirs : null;
}

/** readdir + filter by name pattern + descending sort. [] on any read error. */
async function readNamesDesc(dir: string, pattern: RegExp): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  return entries.filter((e) => pattern.test(e)).sort().reverse();
}

async function walkCollect(dir: string, out: Array<{ path: string; mtime: number }>): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      await walkCollect(full, out);
    } else if (stat.isFile() && entry.startsWith('rollout-') && entry.endsWith('.jsonl')) {
      out.push({ path: full, mtime: stat.mtimeMs });
    }
  }
}
