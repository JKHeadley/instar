/**
 * stopGateTranscriptTail — bounded, fail-open reverse tail-read of a Claude Code
 * Stop-hook transcript (JSONL) to recover the last K user turns as conversational
 * context for the Turn-End Self-Deferral Guard (Phase A / shadow).
 *
 * Spec: docs/specs/turn-end-self-deferral-guard.md §3.2(b) + §3.2(b-bis).
 *
 * WHY BOUNDED + FAIL-OPEN: the transcript JSONL grows unboundedly and the parse
 * runs in the fresh-per-turn Stop-hook process OUTSIDE the authority's
 * breaker/timeout stack — a naive whole-file read is O(file) per turn → O(N²)
 * per conversation on the stop hot path. So: a reverse tail-read (scan from EOF
 * backward, stop as soon as K user turns with real prose are collected), a hard
 * byte cap, a per-turn char clamp, and FAIL-OPEN — any missing/unreadable/
 * malformed/oversize transcript degrades to empty turns and NEVER throws.
 *
 * This module is the tested reference implementation. The deployed
 * `stop-gate-router.js` hook (generated in PostUpdateMigrator.getStopGateRouterHook)
 * inlines a faithful plain-JS port of this exact algorithm — a hook is a
 * self-contained deployed script that cannot import project modules at runtime.
 */

import fs from 'node:fs';

/** A user turn recovered from the transcript, shaped for UntrustedContent.recentTurns. */
export interface RecentUserTurn {
  source: 'user';
  text: string;
}

export interface TranscriptTailOptions {
  /** Max user turns to return (spec K=3). */
  maxTurns?: number;
  /** Hard cap on bytes scanned from the tail (spec ≤256KB). */
  maxBytes?: number;
  /** Per-turn character clamp (a huge user turn is truncated). */
  perTurnChars?: number;
}

export const DEFAULT_MAX_TURNS = 3;
export const DEFAULT_MAX_BYTES = 256 * 1024;
export const DEFAULT_PER_TURN_CHARS = 2000;

/**
 * Extract prose text from a Claude Code transcript user entry. Returns '' for a
 * tool_result-only user entry (an automatic tool response, not real user prose).
 */
export function extractUserProse(entry: unknown): string {
  if (!entry || typeof entry !== 'object') return '';
  const e = entry as Record<string, unknown>;
  if (e.type !== 'user') return '';
  const message = e.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        // Only text blocks carry user prose; tool_result blocks are skipped.
        if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
    }
    return parts.join('\n').trim();
  }
  return '';
}

/**
 * Reverse tail-read `transcriptPath` and return up to `maxTurns` most-recent user
 * turns carrying real prose, in chronological order. Never throws — any failure
 * returns `[]`.
 */
export function readRecentUserTurns(
  transcriptPath: unknown,
  opts: TranscriptTailOptions = {},
): RecentUserTurn[] {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const perTurnChars = opts.perTurnChars ?? DEFAULT_PER_TURN_CHARS;
  try {
    if (!transcriptPath || typeof transcriptPath !== 'string') return [];
    const stat = fs.statSync(transcriptPath);
    const size = stat.size;
    if (!size) return [];
    const readBytes = Math.min(size, maxBytes);
    const fd = fs.openSync(transcriptPath, 'r');
    let text: string;
    try {
      const buf = Buffer.alloc(readBytes);
      fs.readSync(fd, buf, 0, readBytes, size - readBytes);
      text = buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
    // If we started mid-file (capped), drop the first (likely partial) line.
    if (readBytes < size) {
      const nl = text.indexOf('\n');
      if (nl !== -1) text = text.slice(nl + 1);
    }
    const lines = text.split(/\r?\n/).filter(Boolean);
    const turns: RecentUserTurn[] = [];
    for (let i = lines.length - 1; i >= 0 && turns.length < maxTurns; i--) {
      let entry: unknown;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        // @silent-fallback-ok: a malformed transcript line is skipped, never fatal — the
        // spec (§3.2 b-bis) MANDATES a fail-open parse that never throws/delays turn-end; a
        // bad line simply yields fewer user turns (recorded via contextTurns), never an error.
        continue;
      }
      let prose = extractUserProse(entry);
      if (!prose) continue; // filters tool_result-only user entries
      if (prose.length > perTurnChars) prose = prose.slice(0, perTurnChars);
      turns.push({ source: 'user', text: prose });
    }
    turns.reverse(); // chronological order
    return turns;
  } catch {
    // @silent-fallback-ok: the transcript tail-read is fail-open BY DESIGN (spec §3.2 b-bis) — a
    // missing/unreadable/oversize transcript degrades to zero user turns (contextTurns:0) so the
    // stop-gate evaluation still proceeds and the turn still ends. It must NEVER throw or delay.
    return [];
  }
}
