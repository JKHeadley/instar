/** Exact-session corroboration for standby usage-limit notices. Pane text is
 * only a signal: tools and helpers can print the same banner. Only the latest
 * main assistant turn's provider-owned API error can establish this claim. */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonlTailLines } from '../utils/jsonl-tail.js';
import { isSafeSessionRef } from '../core/claudeResumeTranscript.js';
import { THROTTLE_PATTERNS, USAGE_WALL_TEXT_PATTERN } from './rateLimitDetection.js';

/**
 * The transcript id Claude Code itself recorded for a live tmux session, from
 * `<configHome>/sessions/<pid>.json` (written by Claude Code 2.1.3xx for every
 * interactive process: pid, sessionId, tmux "<name>:@w.%p"). Instar learns the
 * id from hook events (PostToolUse, Stop, ...), and a session whose first turn
 * is refused for usage runs no tool and fires no Stop, so its id stayed unknown
 * and its wall could never be proven or recovered (nimbus, 2026-11-07).
 * Null when no live process for exactly this tmux session is on record.
 */
export function claudeSessionIdFromPidFiles(
  configHome: string,
  tmuxSession: string,
  isAlive: (pid: number) => boolean = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }, // @silent-fallback-ok: no such process means not alive
): string | null {
  if (!configHome || !tmuxSession) return null;
  const dir = path.join(configHome, 'sessions');
  let names: string[];
  try { names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)); }
  catch { return null; } // @silent-fallback-ok: no sessions folder means no record, never a guess
  let best: { id: string; startedAt: number } | null = null;
  for (const name of names) {
    let row: { pid?: unknown; sessionId?: unknown; tmux?: unknown; startedAt?: unknown };
    try { row = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')); }
    catch { continue; } // @silent-fallback-ok: a file mid-write is skipped; another pass reads it
    if (typeof row.tmux !== 'string' || !row.tmux.startsWith(`${tmuxSession}:`)) continue;
    if (!isSafeSessionRef(row.sessionId)) continue;
    if (typeof row.pid !== 'number' || `${row.pid}.json` !== name || !isAlive(row.pid)) continue;
    const startedAt = typeof row.startedAt === 'number' ? row.startedAt : 0;
    if (!best || startedAt > best.startedAt) best = { id: row.sessionId, startedAt };
  }
  return best?.id ?? null;
}

/** The latest main-turn row of the exact session, when it is the provider's
 * own rate/usage API error: its text. Null otherwise (no such row, a later
 * user/assistant row refutes it, or the latest record is unreadable). */
function latestMainTurnLimitErrorText(transcriptPath: string, sessionId: string): string | null {
  if (!transcriptPath || !sessionId) return null;
  const { lines } = readJsonlTailLines(transcriptPath, 128 * 1024);
  for (let i = lines.length - 1; i >= 0; i--) {
    let row;
    try { row = JSON.parse(lines[i]); }
    catch { return null; /* @silent-fallback-ok — partial/corrupt latest record is unknown, never affirmative limit evidence */ }
    if (row.sessionId !== sessionId || row.isSidechain || row.agentId) continue;
    if (row.type !== 'assistant' && row.type !== 'user') continue;
    // User/tool-result rows or a later normal assistant turn refute an old
    // error. Nested tool_result text is never inspected for an API signature.
    if (!(row.type === 'assistant' && row.isApiErrorMessage === true
      && (row.error === 'rate_limit' || row.error === 'rate_limit_error'))) return null;
    const content = row.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((c: unknown): c is { type: string; text: string } =>
          !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' && typeof (c as { text?: unknown }).text === 'string')
        .map((c) => c.text)
        .join('\n');
    }
    return '';
  }
  return null;
}

export function confirmSessionUsageLimit(transcriptPath: string, sessionId: string): boolean {
  return latestMainTurnLimitErrorText(transcriptPath, sessionId) !== null;
}

/**
 * The account's USAGE WALL, proven from the exact session's own transcript:
 * the latest main-turn row is the provider's rate-limit API error AND its
 * text is the wall banner ("You've hit your weekly limit · resets …"). Claude
 * Code also files the shared-capacity throttle ("Server is temporarily
 * limiting requests (not your usage limit)") under `error: 'rate_limit'`, so
 * the error code alone cannot tell the two apart — the text must. Returns the
 * banner text, or null.
 */
export function sessionUsageWallFromTranscript(transcriptPath: string, sessionId: string): string | null {
  const text = latestMainTurnLimitErrorText(transcriptPath, sessionId);
  if (!text) return null;
  if (THROTTLE_PATTERNS.some((p) => p.test(text))) return null;
  return USAGE_WALL_TEXT_PATTERN.test(text) ? text : null;
}
