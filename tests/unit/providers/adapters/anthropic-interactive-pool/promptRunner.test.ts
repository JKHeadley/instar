/**
 * Unit tests for promptRunner completion-detection logic.
 *
 * Exercises the empty-prompt detection helper directly, without spawning
 * real `claude` REPLs. The bug this defends against — idle markers
 * appearing literally in a model response (and Claude Code's static
 * status-bar markers always being present), causing brief mid-generation
 * stalls to false-trigger completion — is otherwise expensive to
 * reproduce via real API.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { statusBarHasIdleMarker } from '../../../../../src/providers/adapters/anthropic-interactive-pool/promptRunner.js';
import { resetSignatureForTests } from '../../../../../src/providers/adapters/anthropic-interactive-pool/canary/emptyPromptSignature.js';

const MARKERS = ['? for shortcuts', 'bypass permissions on', 'shift+tab to cycle'];

describe('statusBarHasIdleMarker (empty-prompt detection)', () => {
  // Sibling tests (notably emptyPromptSignaturePersistence) mutate module-level
  // signature state in `canary/emptyPromptSignature.ts`. Without a reset here,
  // running the full tests/unit/providers/ suite produces order-dependent
  // failures: this file passes alone but fails when sibling tests have run
  // first. Reset before each case so we're always operating against the
  // default signature.
  beforeEach(() => {
    resetSignatureForTests();
  });

  it('detects completion when an empty ❯ prompt is in the bottom zone', () => {
    // Claude Code's structural "ready for next prompt" signal: an empty `❯`
    // line above the status bar.
    const buf = [
      '❯ what is 2+2?',
      '⏺ 4',
      '──────────────────────────',
      '❯',
      '──────────────────────────',
      '? for shortcuts | bypass permissions on',
    ].join('\n');
    expect(statusBarHasIdleMarker(buf, MARKERS)).toBe(true);
  });

  it('does NOT trigger when the response body mentions marker substrings mid-generation', () => {
    // The bug this fix defends against. Even though the response body
    // contains every legacy idle-marker substring AND the status bar shows
    // them too, we have NOT yet seen the empty `❯` so completion must not
    // fire. Static UI strings can't distinguish generating from idle —
    // only the structural empty prompt can.
    const buf = [
      '❯ how do I cycle through Claude UI panels?',
      '⏺ Press shift+tab to cycle through the panels.',
      '  The shortcut also lists ? for shortcuts at the top.',
      '  Final tip: use bypass permissions on if a tool is gated.',
      '  (still generating ...)',
      'shift+tab to cycle | ? for shortcuts',  // status bar is always visible
    ].join('\n');
    expect(statusBarHasIdleMarker(buf, MARKERS)).toBe(false);
  });

  it('detects completion even when the response body also matches marker substrings', () => {
    // Response includes the markers in the body AND we have the empty `❯`
    // at the bottom — completion should fire (empty prompt is the signal).
    const buf = [
      '❯ how do I cycle through Claude UI panels?',
      '⏺ Press shift+tab to cycle through the panels.',
      '──────────────────────────',
      '❯',
      '──────────────────────────',
      '? for shortcuts',
    ].join('\n');
    expect(statusBarHasIdleMarker(buf, MARKERS)).toBe(true);
  });

  it('returns false on an empty buffer', () => {
    expect(statusBarHasIdleMarker('', MARKERS)).toBe(false);
  });

  it('returns false when no empty prompt is present even if static markers are', () => {
    // Response complete on the model side but Claude Code is somehow
    // showing only the response without the empty-prompt frame
    // (theoretical / defensive). We err on the side of waiting.
    const buf = [
      '❯ what is 2+2?',
      '⏺ 4',
      '? for shortcuts | bypass permissions on',
    ].join('\n');
    expect(statusBarHasIdleMarker(buf, MARKERS)).toBe(false);
  });

  it('detects the LAST ❯ line as the signal — uses most-recent prompt state', () => {
    // The most recent `❯` line is what matters. When generating, that's
    // the echoed user prompt with content. When idle, it's a fresh empty
    // line below the response.
    const generating = [
      '❯ what is 2+2?',          // most recent ❯ — non-empty
      '⏺ (still generating)',
    ].join('\n');
    const idle = [
      '❯ what is 2+2?',          // echoed prompt
      '⏺ 4',
      '❯',                        // most recent ❯ — empty
    ].join('\n');
    expect(statusBarHasIdleMarker(generating, MARKERS)).toBe(false);
    expect(statusBarHasIdleMarker(idle, MARKERS)).toBe(true);
  });

  it('accepts an empty ❯ followed by trailing whitespace (Claude renders it as "❯ ")', () => {
    // The real REPL writes the idle prompt as "❯ " with a trailing space
    // for cursor positioning. Detection must accept any-whitespace tail.
    expect(statusBarHasIdleMarker('header\n❯ ', MARKERS)).toBe(true);
    expect(statusBarHasIdleMarker('header\n❯  \t', MARKERS)).toBe(true);
  });

  it('does NOT treat a non-empty `❯ <prompt>` line as the ready-prompt signal', () => {
    // The echo of the user's just-sent prompt has `❯ <text>` form, NOT
    // empty `❯`. Must not false-trigger.
    const buf = [
      '❯ a long prompt that is being processed',
      '⏺ (model thinking, no response yet)',
    ].join('\n');
    expect(statusBarHasIdleMarker(buf, MARKERS)).toBe(false);
  });
});
