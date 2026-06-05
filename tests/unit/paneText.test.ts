/**
 * core/paneText — blank-fill-immune tail extraction (task #77).
 *
 * Earned from the 2026-06-05 cycle-2 differential finding: tmux captures
 * return PHYSICAL rows, so tall panes pad meaningful text above trailing blank
 * rows and small-tail consumers (PromptGate pre-#818, SessionManager's n=5
 * idle/age checks) read pure blank. These tests pin the shared semantics so
 * detectors can never drift apart again.
 */

import { describe, expect, it } from 'vitest';
import { meaningfulTail, trimTrailingBlankRows } from '../../src/core/paneText.js';

describe('trimTrailingBlankRows', () => {
  it('trims trailing blanks only — interior blanks are modal structure and stay', () => {
    const lines = ['❯ prompt', '', 'option 1', '', '', ''];
    expect(trimTrailingBlankRows(lines)).toEqual(['❯ prompt', '', 'option 1']);
  });

  it('whitespace-only rows count as blank', () => {
    expect(trimTrailingBlankRows(['text', '  ', '\t'])).toEqual(['text']);
  });

  it("all-blank input yields [''] — defined, empty, never a crash", () => {
    expect(trimTrailingBlankRows(['', '  ', ''])).toEqual(['']);
    expect(trimTrailingBlankRows([])).toEqual(['']);
  });

  it('no trailing blanks → unchanged', () => {
    expect(trimTrailingBlankRows(['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('meaningfulTail', () => {
  it('THE BUG SHAPE: prompt above blank fill is visible in a small tail', () => {
    // 50-row pane: idle prompt at the top, 45 blank rows below — the exact
    // capture that made n=5 idle checks read pure blank.
    const pane = ['❯ ', ...Array(45).fill('')].join('\n');
    expect(meaningfulTail(pane, 5)).toContain('❯');
  });

  it('takes the LAST n meaningful lines when there are more than n', () => {
    const pane = ['one', 'two', 'three', 'four', '', ''].join('\n');
    expect(meaningfulTail(pane, 2)).toBe('three\nfour');
  });

  it("all-blank capture returns '' — same falsy contract callers already handle", () => {
    expect(meaningfulTail('\n\n  \n', 5)).toBe('');
  });

  it('interior blank lines within the tail are preserved', () => {
    const pane = ['header', 'a', '', 'b', '', ''].join('\n');
    expect(meaningfulTail(pane, 3)).toBe('a\n\nb');
  });
});

describe('SessionManager.captureMeaningfulTail (idle-check integration)', () => {
  it('a tall idle pane now reads as idle in a 5-line window', async () => {
    const { SessionManager } = await import('../../src/core/SessionManager.js');
    const sm = Object.create(SessionManager.prototype) as InstanceType<typeof SessionManager>;
    // Stub the transport layer only — the method under test is the windowing.
    (sm as unknown as { captureOutput: (s: string, n: number) => string | null }).captureOutput =
      (_s: string, n: number) => {
        // Simulate a 50-row pane: prompt at top, blank physical fill below.
        const rows = ['❯ ', ...Array(49).fill('')];
        return rows.slice(-n).join('\n');
      };
    const tail = sm.captureMeaningfulTail('any-session', 5);
    expect(tail).toContain('❯'); // pre-fix: 5 physical rows = all blank → ACTIVE forever
  });

  it('null capture (tmux gone) stays null', async () => {
    const { SessionManager } = await import('../../src/core/SessionManager.js');
    const sm = Object.create(SessionManager.prototype) as InstanceType<typeof SessionManager>;
    (sm as unknown as { captureOutput: () => null }).captureOutput = () => null;
    expect(sm.captureMeaningfulTail('any-session', 5)).toBeNull();
  });
});
