import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  observeCodexComposerFrame,
  type CodexComposerFrame,
} from '../../src/core/CodexComposerAdapter.js';

const KEY = 'cd'.repeat(32);
const status = '  gpt-5.6-sol default · /tmp/project · Main';
const viewport = (lines: string[]) => `${lines.join('\n')}\n`;

function hmac(text: string): string {
  return crypto.createHmac('sha256', KEY).update(text.normalize('NFC')).digest('hex');
}

function frame(overrides: Partial<CodexComposerFrame> = {}): CodexComposerFrame {
  return {
    ansiViewport: viewport(['history', '', '› exact draft', '', status, '']),
    joinedViewport: viewport(['history', '', '› exact draft', '', status, '']),
    cursorX: 13, cursorY: 2, width: 80, height: 6,
    alternateOn: false, paneInMode: false, stableMetadata: true,
    ...overrides,
  };
}

describe('CodexComposerAdapter', () => {
  it('correlates the complete joined composer envelope', () => {
    expect(observeCodexComposerFrame(frame(), hmac('exact draft'), KEY)).toBe('present');
    expect(observeCodexComposerFrame(frame(), hmac('exact'), KEY)).toBe('unknown');
  });

  it('reconstructs soft wraps from the joined viewport while preserving hard newlines', () => {
    const envelope = 'first long wrapped segment\nsecond line';
    const captured = frame({
      ansiViewport: viewport(['history', '› first long wrapped', '  segment', '  second line', '', status]),
      joinedViewport: viewport(['history', '› first long wrapped segment', '  second line', '', status, '']),
      cursorX: 13, cursorY: 3,
    });
    expect(observeCodexComposerFrame(captured, hmac(envelope), KEY)).toBe('present');
  });

  it('recognizes only a dim placeholder at the exact input origin as empty', () => {
    const empty = frame({
      ansiViewport: viewport(['history', '', `\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m`, '', status, '']),
      joinedViewport: viewport(['history', '', '› Ask Codex to do anything', '', status, '']),
      cursorX: 2,
    });
    expect(observeCodexComposerFrame(empty, hmac('anything'), KEY)).toBe('cleared');
    expect(observeCodexComposerFrame({ ...empty, cursorX: 3 }, hmac('anything'), KEY)).toBe('unknown');
  });

  it.each([
    ['raced metadata', { stableMetadata: false }],
    ['copy mode', { paneInMode: true }],
    ['unexpected alternate screen', { alternateOn: true }],
    ['cursor outside viewport', { cursorY: 8 }],
    ['clipped viewport', { height: 7 }],
    ['active turn', { ansiViewport: viewport(['Working (2s • esc to interrupt)', '', '› exact draft', '', status, '']) }],
    ['duplicate prompt', { joinedViewport: viewport(['› old', '', '› exact draft', '', status, '']) }],
  ])('fails closed for %s', (_label, overrides) => {
    expect(observeCodexComposerFrame(frame(overrides as Partial<CodexComposerFrame>), hmac('exact draft'), KEY)).toBe('unknown');
  });
});
