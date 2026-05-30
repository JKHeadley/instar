// Unit tests for the canonical "Claude Code is mid-turn" footer signal shared
// by StuckInputSentinel, SessionManager.verifyInjection, and CompactionSentinel.

import { describe, it, expect } from 'vitest';
import {
  CLAUDE_WORKING_INDICATORS,
  paneShowsClaudeWorking,
} from '../../src/core/claudeActivityIndicators.js';

describe('claudeActivityIndicators', () => {
  it('exposes the three canonical footer hints', () => {
    expect(CLAUDE_WORKING_INDICATORS).toContain('esc to interrupt');
    expect(CLAUDE_WORKING_INDICATORS).toContain('tokens · esc');
    expect(CLAUDE_WORKING_INDICATORS).toContain('ctrl+t to hide tasks');
  });

  describe('paneShowsClaudeWorking', () => {
    it('detects an in-flight turn from the "esc to interrupt" footer', () => {
      const pane = [
        '⏺ Working on the task…',
        '  ⎿ Running Bash(npm test)',
        '',
        '✻ Thinking… (12s · ↑ 4.1k tokens · esc to interrupt)',
      ].join('\n');
      expect(paneShowsClaudeWorking(pane)).toBe(true);
    });

    it('detects the token-counting footer variant', () => {
      expect(paneShowsClaudeWorking('  · 1.2k tokens · esc to interrupt')).toBe(true);
      expect(paneShowsClaudeWorking('foo tokens · esc bar')).toBe(true);
    });

    it('detects the multi-task footer variant', () => {
      expect(paneShowsClaudeWorking('press ctrl+t to hide tasks')).toBe(true);
    });

    it('returns false for an idle prompt (no in-flight turn)', () => {
      const idle = [
        '╭──────────────────────────────────────╮',
        '│ >                                    │',
        '╰──────────────────────────────────────╯',
        '  ⏵⏵ bypass permissions on',
      ].join('\n');
      expect(paneShowsClaudeWorking(idle)).toBe(false);
    });

    it('returns false for empty / null / undefined panes', () => {
      expect(paneShowsClaudeWorking('')).toBe(false);
      expect(paneShowsClaudeWorking(null)).toBe(false);
      expect(paneShowsClaudeWorking(undefined)).toBe(false);
    });

    it('does NOT false-positive on prose that merely mentions interrupting', () => {
      // The exact footer substring is required — generic words don't match.
      expect(paneShowsClaudeWorking('You can press escape to stop me anytime.')).toBe(false);
      expect(paneShowsClaudeWorking('the build emitted 5000 tokens total')).toBe(false);
    });
  });
});
