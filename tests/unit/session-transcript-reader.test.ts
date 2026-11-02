/**
 * Console History reads a session's conversation record a page at a time, newest
 * first, without reading the whole file: Claude Code and Codex shapes, tool calls as
 * one line, meta/sidechain records skipped, and paging that never loses or repeats an
 * entry across chunk and page boundaries.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractEntries, readTranscriptPage } from '../../src/core/SessionTranscriptReader.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir = '';
afterEach(() => { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/session-transcript-reader.test.ts' }); dir = ''; });
function write(lines: unknown[]): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-transcript-'));
  const f = path.join(dir, 't.jsonl');
  fs.writeFileSync(f, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return f;
}
const user = (text: string, i: number) => ({ type: 'user', timestamp: `2026-11-01T00:00:${String(i % 60).padStart(2, '0')}Z`, message: { role: 'user', content: text } });
const asst = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'tool_use', name: 'Bash', input: { command: 'ls -la', description: 'List files' } }] } });

describe('extractEntries', () => {
  it('reads Claude text and tool calls, and skips meta, sidechain and tool results', () => {
    expect(extractEntries(asst('hello'), 7)).toEqual([
      { offset: 7, role: 'assistant', text: 'hello', at: null },
      { offset: 7, role: 'tool', text: 'Bash: List files', at: null },
    ]);
    expect(extractEntries({ ...user('x', 1), isMeta: true }, 0)).toEqual([]);
    expect(extractEntries({ ...user('x', 1), isSidechain: true }, 0)).toEqual([]);
    expect(extractEntries({ type: 'user', message: { content: [{ type: 'tool_result', content: 'big output' }] } }, 0)).toEqual([]);
  });
  it('reads Codex messages and function calls, and skips its injected context', () => {
    expect(extractEntries({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } }, 3)[0]).toMatchObject({ role: 'assistant', text: 'done' });
    expect(extractEntries({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":"npm test"}' } }, 3)[0]).toMatchObject({ role: 'tool', text: 'shell: npm test' });
    expect(extractEntries({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } }, 3)).toEqual([]);
  });
});

describe('readTranscriptPage', () => {
  it('pages newest first through a file larger than one chunk, with no gap or repeat', () => {
    const lines: unknown[] = [];
    for (let i = 0; i < 3000; i++) lines.push(i % 2 ? asst(`reply ${i} ${'x'.repeat(400)}`) : user(`ask ${i}`, i));
    lines.splice(10, 0, 'not json {');
    const f = write(lines);
    const seen: string[] = [];
    let before: number | undefined;
    let pages = 0;
    for (;;) {
      const p = readTranscriptPage(f, { before, limit: 97 });
      pages++;
      seen.unshift(...p.entries.map((e) => `${e.offset}:${e.role}:${e.text.slice(0, 12)}`));
      if (p.nextBefore === null) break;
      expect(p.nextBefore).toBeLessThan(before ?? Infinity);
      before = p.nextBefore;
    }
    expect(pages).toBeGreaterThan(40);
    expect(seen).toHaveLength(1500 + 1500 * 2);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen[0]).toContain(':user:ask 0');
    expect(seen[seen.length - 1]).toContain(':tool:Bash: List');
  });
  it('an empty file is one empty page with nothing older', () => {
    const f = write([]);
    expect(readTranscriptPage(f)).toMatchObject({ entries: [], nextBefore: null });
  });
});
