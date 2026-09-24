/**
 * Job transcript evidence — what a model-session job actually DID, read from
 * its framework transcript rather than its tmux pane.
 *
 * Why this exists: the scheduler captures a job's output from its tmux pane at
 * `sessionComplete`, but by then the pane is gone, so a model-session job's
 * captured output is almost always empty (measured 2026-09-24: ~410 of ~420
 * pending Jev completion-audit packs carried an empty output tail). The Jev
 * completion audit then asks "did this job do what it promised?" with nothing
 * but the job's description and the word "success" — an unanswerable question
 * that makes the model look unsure for our omission. The transcript is durable
 * and holds the real record: every command run, its result, and the final
 * reply (including any `EFFECT: <path>` claim a conditional-effect job prints).
 *
 * Observe-only input to an observe-only audit. Every failure yields '' — the
 * caller falls back to the pane capture exactly as before. Scrubbing happens
 * downstream in the audit's capture (scrubForStore), not here.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveFrameworkTranscriptPath } from '../core/FrameworkSessionStore.js';

/** Bytes read from the END of the transcript (a job transcript is small; this bounds a pathological one). */
export const TRANSCRIPT_READ_CAP_BYTES = 1024 * 1024;
/** Per-step caps so several steps fit in the audit's 8KB tail. */
export const STEP_INPUT_CAP_CHARS = 300;
export const STEP_RESULT_CAP_CHARS = 500;
export const FINAL_TEXT_CAP_CHARS = 1500;

/** Same shape as the audit's EFFECT_MARKER_RE (line-anchored). */
const EFFECT_LINE_RE = /^[ \t]*EFFECT:[ \t]*\S+[ \t]*$/gm;
/** A tool result counts as the job's OWN statement only when the step was a print. */
const PRINT_CMD_RE = /^\s*(echo|printf)\b/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cut(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…[+${flat.length - max} chars]`;
}

function describeToolInput(name: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    if (typeof o.command === 'string') return `$ ${o.command}`;
    if (typeof o.file_path === 'string') return `${name} ${o.file_path}`;
  }
  return `${name} ${JSON.stringify(input ?? {})}`;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .join(' ');
  }
  return '';
}

/**
 * Render a Claude Code transcript (JSONL text) as a compact, ordered trace:
 * one `[step]` per tool call with its (clamped) result, then the final reply.
 * The final reply is kept LAST because the audit clamps tail-preferring.
 */
export function renderClaudeTranscript(jsonl: string): string {
  const lines: string[] = [];
  let finalText = '';
  // EFFECT: claims are re-emitted verbatim on their own lines (flattening would
  // hide them from the audit's line-anchored parser). Only the job's own words
  // count: assistant text, or the output of an echo/printf step — never the
  // content of a file the job merely read.
  const claims: string[] = [];
  const printIds = new Set<string>();
  for (const raw of jsonl.split('\n')) {
    if (!raw.trim()) continue;
    let rec: { type?: string; message?: { content?: unknown } };
    try { rec = JSON.parse(raw); } catch { continue; } // @silent-fallback-ok — a torn first line from the tail read is expected.
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type === 'tool_use') {
        const cmd = (block.input as { command?: unknown } | undefined)?.command;
        if (typeof cmd === 'string' && PRINT_CMD_RE.test(cmd) && typeof block.id === 'string') printIds.add(block.id);
        lines.push(`[step] ${cut(describeToolInput(String(block.name ?? 'tool'), block.input), STEP_INPUT_CAP_CHARS)}`);
      } else if (block?.type === 'tool_result') {
        const err = block.is_error === true ? ' (error)' : '';
        if (typeof block.tool_use_id === 'string' && printIds.has(block.tool_use_id)) {
          claims.push(...(resultText(block.content).match(EFFECT_LINE_RE) ?? []));
        }
        lines.push(`  → result${err}: ${cut(resultText(block.content), STEP_RESULT_CAP_CHARS) || '(empty)'}`);
      } else if (block?.type === 'text' && rec.type === 'assistant' && typeof block.text === 'string' && block.text.trim()) {
        finalText = block.text;
        claims.push(...(block.text.match(EFFECT_LINE_RE) ?? []));
      }
    }
  }
  if (lines.length === 0 && !finalText) return '';
  const out = [`[job transcript: ${lines.filter((l) => l.startsWith('[step]')).length} tool step(s)]`, ...lines];
  out.push(`[final reply] ${cut(finalText, FINAL_TEXT_CAP_CHARS) || '(none)'}`);
  for (const c of new Set(claims.map((c) => c.trim()))) out.push(c);
  return out.join('\n');
}

/**
 * Locate a claude-code job transcript by its session UUID. The pane (and so
 * its live CLAUDE_CONFIG_DIR) is gone at completion, so probe the default home
 * plus every `~/.claude-*` config home (subscription-pool slots). The UUID is
 * unique, so the first existing match is the transcript.
 */
export function findClaudeJobTranscript(sessionId: string, projectDir: string, homeDir: string = os.homedir()): string | null {
  if (!UUID_RE.test(sessionId)) return null;
  const candidates: string[] = [resolveFrameworkTranscriptPath({ framework: 'claude-code', sessionId, projectDir, homeDir })];
  try {
    for (const ent of fs.readdirSync(homeDir, { withFileTypes: true })) {
      if (ent.isDirectory() && /^\.claude-[A-Za-z0-9._-]+$/.test(ent.name)) {
        candidates.push(resolveFrameworkTranscriptPath({ framework: 'claude-code', sessionId, projectDir, homeDir, configHome: path.join(homeDir, ent.name) }));
      }
    }
  } catch { /* @silent-fallback-ok — an unreadable home just leaves the default candidate. */ }
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* @silent-fallback-ok — absent candidate. */ }
  }
  return null;
}

/** Bounded tail read + render. Returns '' on any failure (caller keeps the pane capture). */
export function readJobTranscriptEvidence(transcriptPath: string | null): string {
  if (!transcriptPath) return '';
  try {
    const size = fs.statSync(transcriptPath).size;
    const start = Math.max(0, size - TRANSCRIPT_READ_CAP_BYTES);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return renderClaudeTranscript(buf.toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return ''; // @silent-fallback-ok — evidence is best-effort; the pane capture remains the fallback.
  }
}
