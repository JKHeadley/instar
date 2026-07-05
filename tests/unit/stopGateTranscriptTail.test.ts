/**
 * Unit tests — bounded, fail-open transcript tail-read (self-deferral guard
 * conversational context). Spec: turn-end-self-deferral-guard.md §3.2(b-bis) / §7.
 *
 * The deployed stop-gate-router.js hook inlines a faithful plain-JS port of
 * this exact algorithm; this tests the reference implementation.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readRecentUserTurns,
  extractUserProse,
  DEFAULT_PER_TURN_CHARS,
} from '../../src/core/stopGateTranscriptTail.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const tmpFiles: string[] = [];
function writeTranscript(lines: unknown[]): string {
  const p = path.join(os.tmpdir(), `sd-transcript-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  while (tmpFiles.length) {
    try {
      SafeFsExecutor.safeUnlinkSync(tmpFiles.pop()!, {
        operation: 'tests/unit/stopGateTranscriptTail.test.ts afterEach cleanup',
      });
    } catch { /* ignore */ }
  }
});

const userText = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const userBlocks = (blocks: unknown[]) => ({ type: 'user', message: { role: 'user', content: blocks } });
const assistant = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolResultOnly = () => userBlocks([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]);

describe('extractUserProse', () => {
  it('returns string content', () => {
    expect(extractUserProse(userText('hello'))).toBe('hello');
  });
  it('joins text blocks and skips tool_result blocks', () => {
    expect(extractUserProse(userBlocks([{ type: 'text', text: 'a' }, { type: 'tool_result', content: 'x' }, { type: 'text', text: 'b' }]))).toBe('a\nb');
  });
  it('returns "" for a tool_result-only user entry', () => {
    expect(extractUserProse(toolResultOnly())).toBe('');
  });
  it('returns "" for a non-user entry', () => {
    expect(extractUserProse(assistant('hi'))).toBe('');
  });
});

describe('readRecentUserTurns — bounded tail-read', () => {
  it('returns the last <=3 user turns in chronological order', () => {
    const p = writeTranscript([
      userText('turn 1'),
      assistant('reply 1'),
      userText('turn 2'),
      assistant('reply 2'),
      userText('turn 3'),
      assistant('reply 3'),
      userText('turn 4'),
      assistant('reply 4'),
    ]);
    const turns = readRecentUserTurns(p);
    expect(turns).toHaveLength(3);
    expect(turns.map(t => t.text)).toEqual(['turn 2', 'turn 3', 'turn 4']);
    expect(turns.every(t => t.source === 'user')).toBe(true);
  });

  it('skips tool_result-only user entries (no prose)', () => {
    const p = writeTranscript([
      userText('real question'),
      assistant('working'),
      toolResultOnly(),
      assistant('done'),
    ]);
    const turns = readRecentUserTurns(p);
    expect(turns.map(t => t.text)).toEqual(['real question']);
  });

  it('clamps a huge user turn to the per-turn char cap', () => {
    const big = 'x'.repeat(DEFAULT_PER_TURN_CHARS + 5000);
    const p = writeTranscript([userText(big)]);
    const turns = readRecentUserTurns(p);
    expect(turns).toHaveLength(1);
    expect(turns[0].text.length).toBe(DEFAULT_PER_TURN_CHARS);
  });

  it('respects the byte cap (only scans the tail)', () => {
    // A giant early user turn beyond the byte window is never seen.
    const lines = [userText('EARLY-' + 'z'.repeat(300_000)), userText('recent A'), userText('recent B')];
    const p = writeTranscript(lines);
    const turns = readRecentUserTurns(p, { maxBytes: 4096 });
    expect(turns.map(t => t.text)).toEqual(['recent A', 'recent B']);
  });

  it('a missing transcript → [] (contextTurns:0), never throws', () => {
    expect(readRecentUserTurns('/no/such/transcript.jsonl')).toEqual([]);
  });

  it('undefined / non-string path → []', () => {
    expect(readRecentUserTurns(undefined)).toEqual([]);
    expect(readRecentUserTurns(123 as unknown)).toEqual([]);
  });

  it('a malformed / non-JSON transcript → [] (skips bad lines), never throws', () => {
    const p = path.join(os.tmpdir(), `sd-bad-${Math.random().toString(36).slice(2)}.jsonl`);
    fs.writeFileSync(p, 'not json\n{also bad\n');
    tmpFiles.push(p);
    expect(readRecentUserTurns(p)).toEqual([]);
  });

  it('an empty transcript → []', () => {
    const p = path.join(os.tmpdir(), `sd-empty-${Math.random().toString(36).slice(2)}.jsonl`);
    fs.writeFileSync(p, '');
    tmpFiles.push(p);
    expect(readRecentUserTurns(p)).toEqual([]);
  });

  it('mixes malformed and valid lines, keeping only the valid user prose', () => {
    const p = path.join(os.tmpdir(), `sd-mix-${Math.random().toString(36).slice(2)}.jsonl`);
    fs.writeFileSync(
      p,
      [JSON.stringify(userText('good one')), 'GARBAGE LINE', JSON.stringify(assistant('r')), JSON.stringify(userText('good two'))].join('\n') + '\n',
    );
    tmpFiles.push(p);
    expect(readRecentUserTurns(p).map(t => t.text)).toEqual(['good one', 'good two']);
  });
});
