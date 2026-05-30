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
 * List rollout files under $CODEX_HOME/sessions, newest first (by mtime).
 *
 * Codex partitions rollouts by date: `sessions/YYYY/MM/DD/rollout-*.jsonl`. A
 * busy account accumulates tens of thousands of these over time (one real
 * machine: 14k files / 1.4 GB). The previous implementation walked AND
 * `stat`ed EVERY file on every call before slicing to `limit`, which made
 * callers like `GET /codex/usage` and the TokenLedger scan take tens of
 * seconds (the route timed out) on a large history.
 *
 * This walks the date-partition directories in DESCENDING date order and
 * `stat`s only the rollout files in the newest partitions, stopping once it has
 * `limit` candidates (after covering >= MIN_PARTITIONS_SCANNED non-empty
 * partitions, so a day is never cut mid-way and the cross-midnight boundary is
 * covered). Work is bounded to the most-recent partitions instead of the entire
 * history. Trade-off: "newest by mtime" becomes "newest among the most-recent
 * date partitions, then by mtime" — for the rate-limit reader this is exact
 * (the account-wide windows are identical across any recently-active session),
 * and for the resume/token-ledger callers a session older than the scanned
 * partitions yet still the single most-recently-touched file is the only miss,
 * which is vanishingly rare in practice. A non-date-partitioned layout falls
 * back to the original full walk (correctness over speed).
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

  const out: Array<{ path: string; mtime: number }> = [];
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
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (stat.isFile()) {
        out.push({ path: full, mtime: stat.mtimeMs });
        had = true;
      }
    }
    if (had) partitionsWithFiles++;
    if (out.length >= limit && partitionsWithFiles >= MIN_PARTITIONS_SCANNED) break;
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
