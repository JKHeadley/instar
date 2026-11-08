/**
 * RunSlice — Tier 1. Spec: docs/specs/skill-learning-sentinel.md §3.5 input 2 (bounded backward
 * transcript read; tool name + target + 256-char args excerpt; never tool results; every cut recorded).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { readRunSlice, renderOutline, toolTarget, RUN_SLICE_ARGS_EXCERPT_CHARS } from '../../src/monitoring/skillLearning/RunSlice.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'skill-learning-runslice.test.ts' });
});

const T0 = Date.parse('2026-11-06T10:00:00Z');
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function row(ts: string, blocks: unknown[], type = 'assistant'): string {
  return JSON.stringify({ type, timestamp: ts, message: { role: type, content: blocks } });
}
function toolUse(name: string, input: unknown) { return { type: 'tool_use', id: `tu-${Math.random()}`, name, input }; }
function toolResult(text: string) { return { type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text }] }; }

function transcript(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-runslice-'));
  dirs.push(dir);
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

const OPTS = { transcriptScanBytes: 4 * 1024 * 1024, runSliceBytesPerRun: 98304 };

describe('RunSlice (§3.5 input 2)', () => {
  it('keeps only tool_use rows inside the window, chronological, with target + bounded args; results are never read', async () => {
    const file = transcript([
      row(iso(-60_000), [toolUse('Bash', { command: 'git status' })]),                          // before the window
      row(iso(1_000), [toolUse('Read', { file_path: '/repo/README.md' })]),
      row(iso(2_000), [toolResult('SECRET RESULT TEXT that must never appear')], 'user'),
      row(iso(3_000), [toolUse('Bash', { command: 'curl http://localhost:4040/health' })]),
      row(iso(90_000), [toolUse('Write', { file_path: '/repo/after.md' })]),                   // after the window
    ]);
    const s = await readRunSlice({ transcriptPath: file, windowStartMs: T0, windowEndMs: T0 + 60_000, ...OPTS });
    expect(s.truncated).toBe(false);
    expect(s.windowCovered).toBe(true);
    expect(s.steps.map((x) => [x.tool, x.target])).toEqual([['Read', '/repo/README.md'], ['Bash', 'curl http://localhost:4040/health']]);
    const rendered = renderOutline(s, '1');
    expect(rendered).not.toContain('SECRET RESULT TEXT');
    expect(JSON.stringify(s)).not.toContain('SECRET RESULT TEXT');
  });

  it('args excerpt is bounded to 256 chars with a disclosed cut; a secret in args is scrubbed', async () => {
    const long = 'x'.repeat(2000);
    const file = transcript([row(iso(1_000), [toolUse('Bash', { command: `echo token=ghp_${'A'.repeat(40)}`, note: long })])]);
    const s = await readRunSlice({ transcriptPath: file, windowStartMs: T0, windowEndMs: T0 + 60_000, ...OPTS });
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0].args.length).toBeLessThan(RUN_SLICE_ARGS_EXCERPT_CHARS + 40);
    expect(s.steps[0].args).toMatch(/…\[cut: \d+ chars\]$/);
    expect(s.steps[0].target).not.toContain('ghp_AAAA');
    expect(s.truncated).toBe(false); // a field-level excerpt bound is disclosed, not a run truncation
  });

  it('reads backward in chunks across a torn line boundary and stops at the first row older than the window', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) lines.push(row(iso(-1_000_000 + i), [toolUse('Bash', { command: `old-${i} ${'p'.repeat(200)}` })]));
    for (let i = 0; i < 50; i++) lines.push(row(iso(1_000 + i), [toolUse('Bash', { command: `in-${i} ${'q'.repeat(200)}` })]));
    const file = transcript(lines);
    const s = await readRunSlice({ transcriptPath: file, windowStartMs: T0, windowEndMs: T0 + 60_000, chunkBytes: 4096, ...OPTS });
    expect(s.steps).toHaveLength(50);
    expect(s.steps[0].target.startsWith('in-0')).toBe(true);
    expect(s.steps[49].target.startsWith('in-49')).toBe(true);
    expect(s.windowCovered).toBe(true);
    expect(s.scannedBytes).toBeLessThan(fs.statSync(file).size); // it did not read the whole file
  });

  it('scan bound reached before the window start ⇒ truncated (scan-bound), rows read so far kept', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) lines.push(row(iso(1_000 + i), [toolUse('Bash', { command: `in-${i} ${'q'.repeat(300)}` })]));
    const file = transcript(lines);
    const s = await readRunSlice({ transcriptPath: file, windowStartMs: T0, windowEndMs: T0 + 60_000, chunkBytes: 4096, transcriptScanBytes: 8192, runSliceBytesPerRun: 98304 });
    expect(s.truncated).toBe(true);
    expect(s.cuts).toContain('scan-bound');
    expect(s.windowCovered).toBe(false);
    expect(s.steps.length).toBeGreaterThan(0);
    expect(s.steps.length).toBeLessThan(300);
  });

  it('per-run cap drops steps ⇒ truncated (run-cap), with stepsInWindow reporting the real count', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) lines.push(row(iso(1_000 + i), [toolUse('Bash', { command: `step-${i} ${'z'.repeat(100)}` })]));
    const file = transcript(lines);
    const s = await readRunSlice({ transcriptPath: file, windowStartMs: T0, windowEndMs: T0 + 60_000, transcriptScanBytes: 4 * 1024 * 1024, runSliceBytesPerRun: 1500 });
    expect(s.truncated).toBe(true);
    expect(s.cuts).toContain('run-cap');
    expect(s.stepsInWindow).toBe(40);
    expect(s.steps.length).toBeLessThan(40);
  });

  it('a target longer than the target bound is cut ⇒ truncated (target-cut) — a cut target refuses the draft', async () => {
    const file = transcript([row(iso(1_000), [toolUse('Bash', { command: `echo ${'w'.repeat(900)}` })])]);
    const s = await readRunSlice({ transcriptPath: file, windowStartMs: T0, windowEndMs: T0 + 60_000, ...OPTS });
    expect(s.cuts).toContain('target-cut');
    expect(s.truncated).toBe(true);
  });

  it('an unreadable transcript is truncated (unreadable), never a throw', async () => {
    const s = await readRunSlice({ transcriptPath: '/nonexistent/path/session.jsonl', windowStartMs: T0, windowEndMs: T0 + 60_000, ...OPTS });
    expect(s).toMatchObject({ steps: [], truncated: true, cuts: ['unreadable'] });
  });

  it('toolTarget picks the citable field per tool and nothing from a result', () => {
    expect(toolTarget('Bash', { command: 'ls  -la' })).toBe('ls -la');
    expect(toolTarget('Read', { file_path: '/a/b' })).toBe('/a/b');
    expect(toolTarget('WebFetch', { url: 'https://example.com/x' })).toBe('https://example.com/x');
    expect(toolTarget('Skill', { skill: 'build' })).toBe('build');
    expect(toolTarget('X', { nothing: 1 })).toBe('');
    expect(toolTarget('X', 'not-an-object')).toBe('');
  });
});
