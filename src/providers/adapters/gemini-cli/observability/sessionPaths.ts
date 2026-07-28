/**
 * Shared helpers for locating Gemini session files on disk.
 *
 * Gemini CLI writes per-project session files to:
 *   ~/.gemini/tmp/<projectHash>/chats/session-<ISO-ts>-<short8>.json[l]
 *
 * Verified against gemini CLI v0.25.2 (apprenticeship Step 2):
 *   - The directory is `~/.gemini/tmp/<projectHash>/chats/`.
 *   - Each session file's basename is `session-<ISO-timestamp>-<short>.{json,jsonl}`
 *     where `<short>` is the FIRST 8 hex chars of the session UUID.
 *   - Each file's JSON body carries a `"sessionId"` field = the full UUID.
 *
 * So a session UUID `9b06d03d-f990-49c0-...` lives in a file named
 * `session-2026-06-02T05-32-9b06d03d.json`. This module finds a session's
 * file by UUID: it matches the filename's `<short8>` suffix against the
 * UUID's first 8 chars (fast, no read) and confirms via the in-file
 * `sessionId` only when the cheap filename match is ambiguous.
 *
 * This is the layout the framework-blind resolvers (ThreadResumeMap.jsonlExists,
 * RateLimitSentinel/CompactionSentinel recovery-verification) route through for
 * gemini sessions — exactly as those resolvers route codex sessions through
 * openai-codex/observability/sessionPaths.ts. Without it, a gemini session has
 * no claude jsonl and no codex rollout, so every framework-blind path falls
 * through to a wrong/default file and silently breaks fleet-wide.
 *
 * RULE 3.1 RATIONALE
 *   Criticality: high (resume + recovery-verification correctness).
 *   Frequency:   per-resume / per-recovery-check.
 *   Stability:   semi-stable (Gemini may change the session layout).
 *   Fallback:    none — a layout change yields empty results (caught by a
 *                geminiSessionLayoutCanary when that conditional ships, §6).
 *   Verdict:     deterministic FS walk.
 */

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Resolve the Gemini home directory (`~/.gemini` unless overridden). */
export function geminiHomeFromConfig(geminiHome?: string): string {
  return geminiHome ?? path.join(homedir(), '.gemini');
}

/** The per-project session root: `<geminiHome>/tmp`. */
function sessionsRoot(geminiHome?: string): string {
  return path.join(geminiHomeFromConfig(geminiHome), 'tmp');
}

/** A gemini session file matches `session-...json` or `session-...jsonl`. */
function isSessionFile(name: string): boolean {
  return name.startsWith('session-') && (name.endsWith('.json') || name.endsWith('.jsonl'));
}

/**
 * The 8-char short id Gemini embeds at the END of a session filename
 * (before the extension): `session-<ISO>-<short8>.json[l]`.
 */
function shortIdFromFilename(name: string): string | null {
  const base = name.replace(/\.jsonl?$/, '');
  const m = /-([0-9a-f]{8})$/i.exec(base);
  return m ? m[1].toLowerCase() : null;
}

/** First 8 hex chars of a UUID (Gemini's filename short-id form). */
function shortIdFromUuid(uuid: string): string {
  return uuid.replace(/-/g, '').slice(0, 8).toLowerCase();
}

/**
 * Confirm a candidate file actually carries the requested sessionId by
 * reading its `"sessionId"` field. Both the `.json` (whole-object) and
 * `.jsonl` (first line is a header object with `sessionId`) layouts put the
 * id near the top, so a small head-read suffices. Returns true on match.
 */
function fileHasSessionId(full: string, uuid: string): boolean {
  try {
    const head = readFileSync(full, 'utf-8').slice(0, 4096);
    // Cheap substring check first (avoids JSON.parse on the common path).
    if (head.includes(uuid)) return true;
    // jsonl header line is a complete JSON object on line 1.
    const firstLine = head.split('\n', 1)[0];
    const parsed = JSON.parse(firstLine) as { sessionId?: string };
    return parsed.sessionId === uuid;
  } catch {
    return false;
  }
}

/**
 * Find a Gemini session file by session UUID. Returns the absolute path or
 * null on miss. Synchronous — the resume-map `jsonlExists` guard runs on a
 * sync code path and cannot await. A missing `~/.gemini/tmp` (e.g. a pure
 * Claude/Codex agent) returns null fast.
 *
 * Strategy:
 *   1. Walk `<geminiHome>/tmp/<projectHash>/chats/` for `session-*` files.
 *   2. Match the filename's `<short8>` against the UUID's first 8 chars.
 *   3. On a filename match, confirm via the in-file `sessionId` (cheap head
 *      read) so two sessions sharing an 8-char prefix can't collide.
 *   4. Also accept a file whose body contains the full UUID even if the
 *      filename short-id was absent (defensive against a layout tweak).
 */
export function findGeminiSessionFileSync(uuid: string, geminiHome?: string): string | null {
  if (!uuid) return null;
  const root = sessionsRoot(geminiHome);
  const want = shortIdFromUuid(uuid);

  let projectHashes: string[];
  try {
    projectHashes = readdirSync(root);
  } catch {
    return null;
  }

  let bodyFallback: string | null = null;

  for (const projectHash of projectHashes) {
    const chatsDir = path.join(root, projectHash, 'chats');
    let files: string[];
    try {
      files = readdirSync(chatsDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!isSessionFile(file)) continue;
      const full = path.join(chatsDir, file);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      const short = shortIdFromFilename(file);
      if (short === want) {
        // Confirm via in-file sessionId to defeat an 8-char-prefix collision.
        if (fileHasSessionId(full, uuid)) return full;
        continue;
      }
      // Defensive: a filename without a short-id but whose body holds the
      // full UUID still resolves (kept as a fallback so the fast path wins).
      if (short === null && bodyFallback === null && fileHasSessionId(full, uuid)) {
        bodyFallback = full;
      }
    }
  }

  return bodyFallback;
}

/**
 * Find the single newest Gemini session file (by mtime) SYNCHRONOUSLY →
 * `{ path, size, mtime }` (or null when none / not a gemini tree).
 *
 * Used by the gemini branch of the RateLimitSentinel + CompactionSentinel
 * recovery-verification: "did the throttle clear / did compaction recover?"
 * == "is gemini producing output again?" == "did the newest session file
 * grow?". The sentinels compare this against the captured baseline size.
 *
 * Mirrors the codex `findNewestRolloutSync` contract (the account-wide
 * growth signal), adapted to gemini's `tmp/<hash>/chats/` layout. Walks all
 * project-hash chat dirs and statSyncs `session-*` files, returning the
 * newest by mtime. (Gemini's per-project session counts are far smaller than
 * codex's tens-of-thousands of rollouts, so a full stat walk is acceptable
 * for the rarely-run recovery check.)
 */
export function findNewestGeminiSessionSync(
  geminiHome?: string,
): { path: string; size: number; mtime: number } | null {
  const root = sessionsRoot(geminiHome);
  let projectHashes: string[];
  try {
    projectHashes = readdirSync(root);
  } catch {
    return null;
  }

  let newest: { path: string; size: number; mtime: number } | null = null;
  for (const projectHash of projectHashes) {
    const chatsDir = path.join(root, projectHash, 'chats');
    let files: string[];
    try {
      files = readdirSync(chatsDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!isSessionFile(file)) continue;
      const full = path.join(chatsDir, file);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        if (newest === null || st.mtimeMs > newest.mtime) {
          newest = { path: full, size: st.size, mtime: st.mtimeMs };
        }
      } catch {
        continue;
      }
    }
  }
  return newest;
}
