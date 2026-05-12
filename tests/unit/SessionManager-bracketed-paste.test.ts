/**
 * Regression tests for the bracketed-paste injection unification (0.28.93).
 *
 * Spec: docs/specs/tmux-bracketed-paste-unification.md
 *
 * The single-line / multi-line branch split in rawInject() was unified
 * to always use bracketed-paste markers + 500ms settle before Enter.
 * Adds a C0/C1 control-byte sanitizer before the paste wrap.
 *
 * PR #159's multi-shot verifyInjection remains in place as defense-in-depth.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeForPaste } from '../../src/core/SessionManager.js';

const SRC = fs.readFileSync(
  path.join(process.cwd(), 'src/core/SessionManager.ts'),
  'utf-8'
);

describe('sanitizeForPaste — paste-exit-marker defense', () => {
  it('strips ESC-bracket-201 (paste-end marker, 7-bit)', () => {
    const { sanitized, removed } = sanitizeForPaste('foo\x1b[201~bar');
    expect(sanitized).toContain('foo');
    expect(sanitized).toContain('bar');
    expect(sanitized).not.toContain('\x1b');
    expect(removed).toBe(1);
  });

  it('strips ESC-bracket-200 (paste-start marker)', () => {
    const { sanitized, removed } = sanitizeForPaste('a\x1b[200~b');
    expect(sanitized).not.toContain('\x1b');
    expect(removed).toBe(1);
    expect(sanitized).toContain('a');
    expect(sanitized).toContain('b');
  });

  it('strips 8-bit C1 CSI (\\x9b) — paste-marker equivalent', () => {
    const { sanitized, removed } = sanitizeForPaste('x\x9b201~y');
    expect(sanitized).not.toContain('\x9b');
    expect(removed).toBe(1);
  });

  it('strips DEL (U+007F)', () => {
    const { sanitized, removed } = sanitizeForPaste('a\x7fb');
    expect(sanitized).not.toContain('\x7f');
    expect(removed).toBe(1);
  });

  it('strips other C1 controls (\\x80-\\x9f)', () => {
    const { sanitized, removed } = sanitizeForPaste('a\x85\x90\x9fb');
    expect(removed).toBe(3);
    expect(sanitized).toBe('a………b');
  });

  it('preserves tab/LF/CR and normal text', () => {
    const input = 'hello\tworld\n\rmore';
    const { sanitized, removed } = sanitizeForPaste(input);
    expect(sanitized).toBe(input);
    expect(removed).toBe(0);
  });

  it('preserves emoji and accented characters', () => {
    const input = 'café 🎯 résumé';
    const { sanitized, removed } = sanitizeForPaste(input);
    expect(sanitized).toBe(input);
    expect(removed).toBe(0);
  });

  it('replaces with U+2026 ellipsis (non-flaggable placeholder)', () => {
    const { sanitized } = sanitizeForPaste('a\x01b');
    expect(sanitized).toBe('a…b');
  });

  it('empty string is a no-op', () => {
    const { sanitized, removed } = sanitizeForPaste('');
    expect(sanitized).toBe('');
    expect(removed).toBe(0);
  });
});

describe('rawInject — bracketed-paste unification (source wiring)', () => {
  function getRawInjectMethod(): string {
    const start = SRC.indexOf('private rawInject(');
    expect(start).toBeGreaterThan(0);
    // Method ends at the next blank-line + "  /**" doc-comment boundary
    const end = SRC.indexOf('\n  /**', start + 1);
    return SRC.slice(start, end > -1 ? end : start + 5000);
  }

  it('no longer branches on text.includes("\\n") — unified path', () => {
    const method = getRawInjectMethod();
    expect(method).not.toContain("text.includes('\\n')");
    expect(method).toContain('Unified bracketed-paste path');
  });

  it('always uses bracketed-paste markers + Enter', () => {
    const method = getRawInjectMethod();
    expect(method).toContain('\\x1b[200~');
    expect(method).toContain('\\x1b[201~');
    expect(method).toContain("'Enter'");
  });

  it('keeps the 0.5s settle delay between paste-end and Enter', () => {
    const method = getRawInjectMethod();
    const sleepMatch = method.match(/sleep.*?(['"])(\d+\.?\d*)\1/);
    expect(sleepMatch).not.toBeNull();
    expect(sleepMatch![2]).toBe('0.5');
  });

  it('sanitizes input before sending', () => {
    const method = getRawInjectMethod();
    expect(method).toContain('sanitizeForPaste(text)');
  });

  it('still calls PR #159 verifyInjection as defense in depth', () => {
    const method = getRawInjectMethod();
    expect(method).toContain('this.verifyInjection(');
  });

  it('emits control-byte-sanitized degradation when bytes are stripped', () => {
    const method = getRawInjectMethod();
    expect(method).toContain('control-byte-sanitized');
  });
});
