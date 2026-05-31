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

import { promises as fs, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function codexHomeFromConfig(codexHome?: string): string {
  return codexHome ?? path.join(homedir(), '.codex');
}

/** Find a rollout JSONL file by Codex thread UUID. Returns null on miss. */
export async function findRolloutFile(
  threadId: string,
  codexHome?: string,
): Promise<string | null> {
  if (!threadId) return null;
  const root = path.join(codexHomeFromConfig(codexHome), 'sessions');
  return walkForUuid(root, threadId);
}

/**
 * Synchronous variant of {@link findRolloutFile}. Needed by callers that run on
 * a sync code path and cannot await — notably the resume-map `jsonlExists`
 * guards (ThreadResumeMap, TopicResumeMap), which previously checked only the
 * Claude flat layout and so returned false for EVERY codex session (the
 * codex-compat resume bug: every codex thread looked expired/missing). Returns
 * the rollout path or null. A missing `$CODEX_HOME/sessions` (e.g. a pure
 * Claude agent) returns null fast — `readdirSync` throws and is caught.
 */
export function findRolloutFileSync(threadId: string, codexHome?: string): string | null {
  if (!threadId) return null;
  const root = path.join(codexHomeFromConfig(codexHome), 'sessions');
  return walkForUuidSync(root, threadId);
}

function walkForUuidSync(root: string, uuid: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(root, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const nested = walkForUuidSync(full, uuid);
      if (nested) return nested;
    } else if (stat.isFile() && entry.startsWith('rollout-') && entry.includes(uuid) && entry.endsWith('.jsonl')) {
      return full;
    }
  }
  return null;
}

async function walkForUuid(root: string, uuid: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(root, entry);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const nested = await walkForUuid(full, uuid);
      if (nested) return nested;
    } else if (stat.isFile() && entry.startsWith('rollout-') && entry.includes(uuid) && entry.endsWith('.jsonl')) {
      return full;
    }
  }
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
