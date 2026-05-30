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

/** List all rollout files under $CODEX_HOME/sessions, newest first. */
export async function listAllRollouts(
  codexHome?: string,
  limit = 100,
): Promise<ReadonlyArray<{ path: string; mtime: number }>> {
  const root = path.join(codexHomeFromConfig(codexHome), 'sessions');
  const all: Array<{ path: string; mtime: number }> = [];
  await walkCollect(root, all);
  all.sort((a, b) => b.mtime - a.mtime);
  return all.slice(0, limit);
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
