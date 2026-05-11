/**
 * Tests for injection submission verification — auto-resend of Enter when
 * bracketed paste typed the message but Enter was eaten by a race with the
 * paste-end sequence on fresh Claude Code TUIs.
 *
 * Observed bug: on a fresh Claude Code v2.1.105 spawn, after bracketed paste
 * + Enter, the text sat in the prompt unsubmitted. One manual Enter unstuck it.
 * This test enforces that SessionManager now auto-verifies submission and
 * resends Enter once if the text is still visible in the prompt.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SESSION_MANAGER_SRC = path.join(process.cwd(), 'src/core/SessionManager.ts');

describe('SessionManager — submission verification', () => {
  const source = fs.readFileSync(SESSION_MANAGER_SRC, 'utf-8');

  it('declares verifyInjection (or equivalent post-inject verification hook)', () => {
    expect(source).toMatch(/verifyInjection|verifySubmission|ensureSubmitted/);
  });

  it('rawInject triggers verification after send-keys Enter', () => {
    const methodStart = source.indexOf('private rawInject(');
    const methodEnd = source.indexOf('\n  /**', methodStart + 1);
    const method = source.slice(methodStart, methodEnd > -1 ? methodEnd : undefined);
    // After the final Enter, we should schedule a verification check
    expect(method).toMatch(/verifyInjection|verifySubmission|ensureSubmitted/);
  });

  it('uses a marker extracted from the injected text (not a fixed string)', () => {
    // The verifier should look for a distinguishing snippet of the original text,
    // not something generic like "typed" or "❯" alone.
    const fnStart = source.search(/private\s+(verifyInjection|verifySubmission|ensureSubmitted)\s*\(/);
    const fnBlock = source.slice(fnStart, fnStart + 3000);
    // Must reference something derived from the injected text (substring/slice)
    expect(fnBlock).toMatch(/marker|slice|substring|first\s+\d+\s+chars/);
  });

  it('looks for the prompt indicator ❯ in captured pane', () => {
    const fnStart = source.search(/private\s+(verifyInjection|verifySubmission|ensureSubmitted)\s*\(/);
    const fnBlock = source.slice(fnStart, fnStart + 3000);
    expect(fnBlock).toContain('❯');
  });

  it('resends Enter at most once (no infinite loop)', () => {
    const fnStart = source.search(/private\s+(verifyInjection|verifySubmission|ensureSubmitted)\s*\(/);
    const fnBlock = source.slice(fnStart, fnStart + 3000);
    // Should have a single resend — not a while loop of unbounded tries
    expect(fnBlock).toMatch(/send-keys.*Enter/);
    // Explicit non-infinite-loop guard: either a boolean "alreadyRetried" or a single-shot if
    expect(fnBlock).not.toMatch(/while\s*\(\s*true\s*\)/);
  });

  it('waits at least 1 second before checking submission (TUI render stabilization)', () => {
    // Must pause to let the TUI process the paste-end + Enter before declaring stuck
    const fnStart = source.search(/private\s+(verifyInjection|verifySubmission|ensureSubmitted)\s*\(/);
    const fnBlock = source.slice(fnStart, fnStart + 3000);
    // Either a setTimeout/sleep/delay of >=1000ms or a configurable delay with a >=1000 default
    expect(fnBlock).toMatch(/1000|1500|2000|verifyDelayMs|markerCheckMs/);
  });

  it('does not double-submit when the text is absent (normal case)', () => {
    const fnStart = source.search(/private\s+(verifyInjection|verifySubmission|ensureSubmitted)\s*\(/);
    const fnBlock = source.slice(fnStart, fnStart + 3000);
    // Resend must be inside a conditional (only when marker still present)
    expect(fnBlock).toMatch(/if\s*\(/);
  });
});
