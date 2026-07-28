/**
 * Unit tests — frameworkActivitySignals.
 *
 * Verifies the lookup table and pattern shape for every framework.
 * Catches regressions where someone adds a new framework to
 * IntelligenceFramework without adding a signal entry, or where the
 * Claude-code patterns get accidentally weakened.
 */

import { describe, it, expect } from 'vitest';
import {
  getActivitySignal,
  listActivitySignals,
} from '../../src/monitoring/frameworkActivitySignals.js';

describe('frameworkActivitySignals', () => {
  describe('getActivitySignal', () => {
    it('returns the claude-code signal by default when called with undefined', () => {
      const signal = getActivitySignal(undefined);
      expect(signal.displayName).toBe('Claude Code');
    });

    it('returns the claude-code signal when called with null', () => {
      const signal = getActivitySignal(null);
      expect(signal.displayName).toBe('Claude Code');
    });

    it('returns claude-code signal for "claude-code"', () => {
      const signal = getActivitySignal('claude-code');
      expect(signal.displayName).toBe('Claude Code');
    });

    it('returns codex-cli signal for "codex-cli"', () => {
      const signal = getActivitySignal('codex-cli');
      expect(signal.displayName).toBe('Codex CLI');
    });
  });

  describe('claude-code signal', () => {
    const signal = getActivitySignal('claude-code');

    it('matches Claude tool-call display strings', () => {
      expect(signal.toolCallOrSpinner.test('Read(/etc/hosts)')).toBe(true);
      expect(signal.toolCallOrSpinner.test('Bash(npm test)')).toBe(true);
      expect(signal.toolCallOrSpinner.test('Edit(src/foo.ts)')).toBe(true);
      expect(signal.toolCallOrSpinner.test('Write(plan.md)')).toBe(true);
      expect(signal.toolCallOrSpinner.test('Grep(needle)')).toBe(true);
      expect(signal.toolCallOrSpinner.test('Glob(**/*.ts)')).toBe(true);
    });

    it('matches Braille spinner glyphs Claude renders while thinking', () => {
      for (const glyph of ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']) {
        expect(signal.toolCallOrSpinner.test(glyph)).toBe(true);
      }
    });

    it('matches the "esc to interrupt" hint', () => {
      expect(signal.escapeToInterrupt.test('press esc to interrupt')).toBe(true);
      expect(signal.escapeToInterrupt.test('ESC to interrupt')).toBe(true);
    });

    it('matches the "(running)" indicator', () => {
      expect(signal.runningIndicator.test('Bash(npm test) (running)')).toBe(true);
    });

    it('does NOT match unrelated text', () => {
      expect(signal.toolCallOrSpinner.test('hello world')).toBe(false);
      expect(signal.escapeToInterrupt.test('press space to continue')).toBe(false);
      expect(signal.runningIndicator.test('finished')).toBe(false);
    });
  });

  describe('codex-cli signal', () => {
    const signal = getActivitySignal('codex-cli');

    it('matches Codex tool-call display strings', () => {
      expect(signal.toolCallOrSpinner.test('exec(npm test)')).toBe(true);
      expect(signal.toolCallOrSpinner.test('shell(ls)')).toBe(true);
      expect(signal.toolCallOrSpinner.test('apply_patch(...)')).toBe(true);
      // Bare "patch(" is NOT a Codex render token — Codex emits apply_patch(.
      expect(signal.toolCallOrSpinner.test('patch(diff)')).toBe(false);
    });

    it('matches Codex-style activity verbs', () => {
      expect(signal.toolCallOrSpinner.test('Generating response...')).toBe(true);
      // The canonical working status line.
      expect(signal.toolCallOrSpinner.test('• Working (3s • esc to interrupt)')).toBe(true);
      // Real hour-scale Codex rendering captured from a long-running report.
      expect(signal.toolCallOrSpinner.test('• Working (10h 19m 44s • esc to interrupt)')).toBe(true);
      expect(signal.liveActivity.test('• Working (10h 19m 44s • esc to interrupt)')).toBe(true);
      // Casual "working on it" is NOT a Codex render string. Matching it caused
      // idle panes to read as working — the 2026-05-23 stuck-session false positive.
      expect(signal.toolCallOrSpinner.test('working on it')).toBe(false);
    });

    it('matches the bare Codex interrupt hint, not Claude-style prefixed forms', () => {
      // Codex renders a BARE "esc to interrupt" inside its working status line.
      expect(signal.escapeToInterrupt.test('• Working (3s • esc to interrupt)')).toBe(true);
      // Claude-style prefixed phrasings are not what Codex renders.
      expect(signal.escapeToInterrupt.test('press Ctrl+C to cancel')).toBe(false);
      expect(signal.escapeToInterrupt.test('Press Ctrl-C to stop')).toBe(false);
    });

    it('matches Codex running indicator variants', () => {
      expect(signal.runningIndicator.test('shell(ls) (running)')).toBe(true);
      expect(signal.runningIndicator.test('(executing)')).toBe(true);
      expect(signal.runningIndicator.test('(streaming)')).toBe(true);
    });

    it('does NOT match Claude-specific tool names alone', () => {
      // Codex doesn't render "Read(" / "Edit(" — those are Claude tokens.
      // A bare token without a Codex marker should not match.
      expect(signal.toolCallOrSpinner.test('Read foo bar')).toBe(false);
    });
  });

  describe('listActivitySignals', () => {
    it('enumerates every supported framework', () => {
      const signals = listActivitySignals();
      const frameworks = signals.map(s => s.framework).sort();
      expect(frameworks).toEqual(['claude-code', 'codex-cli', 'gemini-cli', 'pi-cli']);
    });

    it('each entry exposes the full signal shape', () => {
      for (const { signal } of listActivitySignals()) {
        expect(typeof signal.displayName).toBe('string');
        expect(signal.toolCallOrSpinner).toBeInstanceOf(RegExp);
        expect(signal.escapeToInterrupt).toBeInstanceOf(RegExp);
        expect(signal.runningIndicator).toBeInstanceOf(RegExp);
        expect(typeof signal.promptSignaturesLine).toBe('string');
      }
    });
  });
});
