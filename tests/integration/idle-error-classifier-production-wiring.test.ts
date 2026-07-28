/**
 * Idle-error classifier — PRODUCTION wiring (CMT-1785).
 *
 * Tier 2 (integration): proves the REAL exported TERMINAL_ERROR_PATTERNS set (the one the
 * SessionManager idle path actually uses) produces the right fired/suppressed decisions on
 * REAL captured panes, AND that the SessionManager call-site is wired to the classifier with
 * the 45-row capture and the dual once-per-episode clears. This is the "do the production
 * patterns + wiring produce correct decisions" proof, stronger than source-grep alone.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { classifyIdleError } from '../../src/core/IdleErrorClassifier.js';
import { TERMINAL_ERROR_PATTERNS } from '../../src/core/SessionManager.js';

const PROMPT_TAIL = '\n╭────────────╮\n│ > \n╰────────────╯\n  ⏵⏵ bypass permissions on';

describe('production TERMINAL_ERROR_PATTERNS decisions on real panes', () => {
  it('exports exactly the 11 documented patterns', () => {
    expect(TERMINAL_ERROR_PATTERNS).toHaveLength(11);
    expect(TERMINAL_ERROR_PATTERNS).toContain('API Error:');
    expect(TERMINAL_ERROR_PATTERNS).toContain('ServiceUnavailable');
    expect(TERMINAL_ERROR_PATTERNS).toContain('rate_limit_error');
  });

  it('FIRES on a real ⏺ API Error: render using the production patterns', () => {
    const pane = '⏺ API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup).' + PROMPT_TAIL;
    expect(classifyIdleError(pane, TERMINAL_ERROR_PATTERNS).isTerminalError).toBe(true);
  });

  it('SUPPRESSES the self-collision (agent reading the patterns source) using the production patterns', () => {
    const src = "const TERMINAL_ERROR_PATTERNS = [\n  'invalid_request_error',\n  'ECONNREFUSED',\n  'ETIMEDOUT',\n];" + PROMPT_TAIL;
    expect(classifyIdleError(src, TERMINAL_ERROR_PATTERNS).isTerminalError).toBe(false);
  });
});

describe('SessionManager call-site wiring', () => {
  const SRC = fs.readFileSync(path.join(process.cwd(), 'src/core/SessionManager.ts'), 'utf-8');

  it('routes the idle-error GATE through classifyIdleError, not the bare .includes', () => {
    expect(SRC).toContain('classifyIdleError(recentOutput, TERMINAL_ERROR_PATTERNS)');
    expect(SRC).toContain('const hasError = idleErr.isTerminalError');
    // the old bare-match GATE is gone (the bare .some survives ONLY as the audit's
    // bareCandidate comparison, never as the hasError gate)
    expect(SRC).not.toContain('const hasError = TERMINAL_ERROR_PATTERNS.some');
  });

  it('captures the wider 45-row window (RATE_LIMIT_SETTLED_CAPTURE_LINES) for the idle-error scan', () => {
    expect(SRC).toContain('captureOutputMaybeAsync(session.tmuxSession, RATE_LIMIT_SETTLED_CAPTURE_LINES)');
  });

  it('clears the once-per-episode idleErrorClassified guard in BOTH the re-arm block AND sessionComplete', () => {
    const occurrences = SRC.split('this.idleErrorClassified.delete(session.id)').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    // sessionComplete clear sits alongside the errorNudgedSessions clear
    const sessionCompleteIdx = SRC.indexOf("this.on('sessionComplete'");
    const clearIdx = SRC.indexOf('this.idleErrorClassified.delete(session.id)', sessionCompleteIdx);
    expect(clearIdx).toBeGreaterThan(sessionCompleteIdx);
  });

  it('emits the structured idle-error-classify observability record (fired/suppressed)', () => {
    expect(SRC).toContain("event: 'idle-error-classify'");
    expect(SRC).toContain("result: idleErr.isTerminalError ? 'fired' : 'suppressed'");
  });
});
