/**
 * RunSlice — the agent's own tool-call outline for one run, read from the
 * session transcript (docs/specs/skill-learning-sentinel.md §3.5 input 2).
 *
 * Bounded, async, backward: the transcript is read from its tail in 512 KB
 * chunks until a row older than the run window is seen, the scan bound
 * (`evidence.transcriptScanBytes`) is reached, or the file begins. Only the
 * rows inside `[windowStart, windowEnd]` are kept, and from each only
 * `tool_use` blocks: tool name + a target + a 256-char args excerpt. Tool
 * RESULTS are never read into the slice — a result is other people's text.
 * Everything kept passes `scrubSecrets`.
 *
 * Every cut is RECORDED, never silent (Never Silently Cut the Data a Decision
 * Depends On): `truncated: true` with its reasons when the scan bound stopped
 * short of the window start, when the per-run cap (`runSliceBytesPerRun`,
 * chars) dropped steps, or when a step's TARGET had to be cut (a cut that
 * removes a step's target refuses the draft like a truncated run does). The
 * 256-char args excerpt is a documented field-level bound disclosed in the
 * outline text itself, not a truncation of the run.
 *
 * Transcript shape (Claude Code JSONL): one row per line,
 * `{ type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', name, input }] } }`.
 */

import fs from 'node:fs';
import { scrubSecrets } from '../scrubSecrets.js';

export const RUN_SLICE_CHUNK_BYTES = 512 * 1024;
/** Documented field bound: the args excerpt per step (§3.5 "256-byte args excerpt"), chars. */
export const RUN_SLICE_ARGS_EXCERPT_CHARS = 256;
/** A target longer than this is cut, and a cut target refuses the draft (§3.5). */
export const RUN_SLICE_TARGET_MAX_CHARS = 512;

export interface RunSliceStep {
  at: string;
  tool: string;
  /** The tool's target (command, path, url, skill name, …) — usable by the drafter as a reference. */
  target: string;
  /** Untrusted evidence: a bounded excerpt of the raw input (disclosed cut). Never a sentence source. */
  args: string;
}

export type RunSliceCut = 'scan-bound' | 'run-cap' | 'target-cut' | 'unreadable';

export interface RunSlice {
  steps: RunSliceStep[];
  truncated: boolean;
  cuts: RunSliceCut[];
  /** Bytes actually read from the tail. */
  scannedBytes: number;
  /** True when a row OLDER than the window start was seen (or the file began) — the window is fully covered. */
  windowCovered: boolean;
  /** Steps inside the window before the per-run cap. */
  stepsInWindow: number;
}

export interface ReadRunSliceOptions {
  transcriptPath: string;
  windowStartMs: number;
  windowEndMs: number;
  /** `evidence.transcriptScanBytes` */
  transcriptScanBytes: number;
  /** `evidence.runSliceBytesPerRun` — applied as a char cap over the rendered steps. */
  runSliceBytesPerRun: number;
  chunkBytes?: number;
}

const TARGET_KEYS = ['command', 'file_path', 'path', 'url', 'skill', 'query', 'pattern', 'notebook_path', 'name', 'target', 'description'] as const;

/** The target of a tool call: the one field a drafter may cite (never a result). */
export function toolTarget(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  for (const k of TARGET_KEYS) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').trim();
  }
  void name;
  return '';
}

function argsExcerpt(input: unknown): string {
  let s: string;
  try { s = JSON.stringify(input ?? {}); } catch { s = '{}'; }
  if (s.length <= RUN_SLICE_ARGS_EXCERPT_CHARS) return s;
  return `${s.slice(0, RUN_SLICE_ARGS_EXCERPT_CHARS)}…[cut: ${s.length - RUN_SLICE_ARGS_EXCERPT_CHARS} chars]`;
}

/** Rendered size of a step as the drafter sees it (the per-run cap is measured on this). */
export function renderStep(s: RunSliceStep, withArgs: boolean): string {
  return withArgs ? `- [${s.tool}] ${s.target}\n    args: ${s.args}` : `- [${s.tool}] ${s.target}`;
}

interface ParsedRow { at: number; steps: Array<{ tool: string; input: unknown }> }

function parseRow(line: string): ParsedRow | null {
  if (!line.trim()) return null;
  let rec: { type?: unknown; timestamp?: unknown; message?: { content?: unknown } };
  try { rec = JSON.parse(line); } catch { return null; } // @silent-fallback-ok — a torn line at a chunk edge is expected and reassembled by the caller
  if (!rec || typeof rec !== 'object') return null;
  const at = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
  if (!Number.isFinite(at)) return null;
  const steps: ParsedRow['steps'] = [];
  const content = rec.message?.content;
  if (rec.type === 'assistant' && Array.isArray(content)) {
    for (const b of content as Array<Record<string, unknown>>) {
      if (b && b.type === 'tool_use') steps.push({ tool: String(b.name ?? 'tool'), input: b.input });
      // tool_result blocks are deliberately not read — never a slice input.
    }
  }
  return { at, steps };
}

/**
 * Read the run's tool-call outline. Never throws: an unreadable transcript is
 * `{ steps: [], truncated: true, cuts: ['unreadable'] }` — the honest side, the
 * draft is refused rather than written from nothing.
 */
export async function readRunSlice(opts: ReadRunSliceOptions): Promise<RunSlice> {
  const chunk = Math.max(4096, opts.chunkBytes ?? RUN_SLICE_CHUNK_BYTES);
  const scanBound = Math.max(chunk, Math.floor(opts.transcriptScanBytes));
  const cuts = new Set<RunSliceCut>();
  let scanned = 0;
  let windowCovered = false;
  const rows: ParsedRow[] = [];

  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(opts.transcriptPath, 'r');
  } catch {
    return { steps: [], truncated: true, cuts: ['unreadable'], scannedBytes: 0, windowCovered: false, stepsInWindow: 0 };
  }
  try {
    const size = (await fh.stat()).size;
    let pos = size;
    let leftover = '';
    outer: while (pos > 0 && scanned < scanBound) {
      const len = Math.min(chunk, pos, scanBound - scanned);
      pos -= len;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, pos);
      scanned += len;
      const text = buf.toString('utf8') + leftover;
      const lines = text.split('\n');
      // The first element may be a torn line (unless we are at the file start).
      leftover = pos > 0 ? lines.shift() ?? '' : '';
      for (let i = lines.length - 1; i >= 0; i--) {
        const row = parseRow(lines[i]);
        if (!row) continue;
        if (row.at < opts.windowStartMs) { windowCovered = true; break outer; }
        if (row.at <= opts.windowEndMs) rows.push(row);
      }
      if (pos === 0 && leftover) {
        const row = parseRow(leftover);
        if (row && row.at >= opts.windowStartMs && row.at <= opts.windowEndMs) rows.push(row);
      }
    }
    if (pos === 0) windowCovered = true;
    if (!windowCovered) cuts.add('scan-bound');
  } catch {
    cuts.add('unreadable');
  } finally {
    await fh.close().catch(() => { /* @silent-fallback-ok — close failure after a read is not evidence */ });
  }

  // Chronological order (rows were collected newest-first).
  rows.sort((a, b) => a.at - b.at);
  const all: RunSliceStep[] = [];
  for (const r of rows) {
    for (const s of r.steps) {
      let target = scrubSecrets(toolTarget(s.tool, s.input));
      if (target.length > RUN_SLICE_TARGET_MAX_CHARS) {
        target = `${target.slice(0, RUN_SLICE_TARGET_MAX_CHARS)}…[cut]`;
        cuts.add('target-cut');
      }
      all.push({ at: new Date(r.at).toISOString(), tool: scrubSecrets(s.tool), target, args: scrubSecrets(argsExcerpt(s.input)) });
    }
  }
  // Per-run cap over the rendered outline (chars), chronological head kept.
  const cap = Math.max(64, Math.floor(opts.runSliceBytesPerRun));
  const kept: RunSliceStep[] = [];
  let used = 0;
  for (const s of all) {
    const len = renderStep(s, true).length + 1;
    if (used + len > cap) { cuts.add('run-cap'); break; }
    kept.push(s);
    used += len;
  }
  return {
    steps: kept,
    truncated: cuts.size > 0,
    cuts: [...cuts],
    scannedBytes: scanned,
    windowCovered,
    stepsInWindow: all.length,
  };
}

/** The outline the arbiter sees: tool + target only. */
export function renderOutline(slice: RunSlice, label: string): string {
  const lines = [`run ${label}: ${slice.steps.length} step(s)${slice.truncated ? ` [cut: ${slice.cuts.join(',')}]` : ''}`];
  for (const s of slice.steps) lines.push(renderStep(s, false));
  return lines.join('\n');
}
