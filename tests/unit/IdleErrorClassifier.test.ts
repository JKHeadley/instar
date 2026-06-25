/**
 * IdleErrorClassifier — semantic correctness, both sides of every boundary (CMT-1785).
 *
 * Pinned to REAL captured render forms (the `⏺ API Error:` / `  ⎿  API Error:` constants
 * that already appear in presence-proxy-honest-receipts.test.ts and
 * StuckSignatureClassifier.test.ts) — never hand-invented "clean" strings (Scrape/Parser
 * Fixture Realness standard).
 */
import { describe, it, expect } from 'vitest';
import { classifyIdleError } from '../../src/core/IdleErrorClassifier.js';
import { stripLineLead, wasGlyphLed, liveTail } from '../../src/core/paneTail.js';

// The production pattern set (kept in sync via the production-wiring integration test).
const PATTERNS = [
  'API Error:', 'invalid_request_error', 'Could not process', 'overloaded_error',
  'rate_limit_error', 'Request timed out', 'Internal server error', 'ServiceUnavailable',
  'ECONNREFUSED', 'ETIMEDOUT', 'fetch failed',
];

// REAL captured render forms.
const REAL_AUP = '⏺ API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup).';
const REAL_TOOL_RESULT = '  ⎿  API Error: 400 messages.9.content.20: `thinking` blocks in the latest assistant message cannot be modified.';
const REAL_THROTTLE = '  ⎿  API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited';

const PROMPT_TAIL = [
  '',
  '╭──────────────────────────────────────────────────╮',
  '│ > ',
  '╰──────────────────────────────────────────────────╯',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

describe('classifyIdleError — fires on real Claude-emitted error frames (Tier A)', () => {
  it('fires on the real ⏺ API Error: AUP render', () => {
    const r = classifyIdleError(`some prior output\n${REAL_AUP}\n${PROMPT_TAIL}`, PATTERNS);
    expect(r.isTerminalError).toBe(true);
    expect(r.matchedPattern).toBeTruthy();
  });
  it('fires on the real ⎿ API Error: tool-result render', () => {
    expect(classifyIdleError(`x\n${REAL_TOOL_RESULT}\n${PROMPT_TAIL}`, PATTERNS).isTerminalError).toBe(true);
  });
  it('fires on a column-0 (non-glyph) API Error: line (Tier A needs no glyph)', () => {
    expect(classifyIdleError(`API Error: 529 overloaded_error\n${PROMPT_TAIL}`, PATTERNS).isTerminalError).toBe(true);
  });
  it('records a structured code present on the framed line as matchedPattern', () => {
    const r = classifyIdleError(`⏺ API Error: 500 {"type":"overloaded_error"}\n${PROMPT_TAIL}`, PATTERNS);
    expect(r.isTerminalError).toBe(true);
    expect(r.matchedPattern).toBe('overloaded_error');
  });
});

describe('classifyIdleError — Tier B (glyph-led terminal token, not API Error:)', () => {
  it('fires on a glyph-led line beginning with a network pattern', () => {
    expect(classifyIdleError(`⏺ fetch failed\n${PROMPT_TAIL}`, PATTERNS).isTerminalError).toBe(true);
  });
  it('does NOT fire on a NON-glyph-led line that merely begins with a pattern mid-content', () => {
    // column-0 raw "fetch failed" with no glyph and not an API Error: → not a Claude frame
    expect(classifyIdleError(`fetch failed somewhere in tool output\n${PROMPT_TAIL}`, PATTERNS).isTerminalError).toBe(false);
  });
});

describe('classifyIdleError — suppresses the false positives the old bare match fired on', () => {
  it('SUPPRESSES a stale API Error scrolled to the TOP of a wide buffer with a clean prompt tail', () => {
    // 28 lines of real recovered work below the old error push it past the default 20-line tail.
    const stale = [REAL_AUP, ...Array.from({ length: 28 }, (_, i) => `recovered output line ${i}`), PROMPT_TAIL].join('\n');
    expect(classifyIdleError(stale, PATTERNS).isTerminalError).toBe(false);
  });
  it('SUPPRESSES a prose mention of API Error: (mid-sentence, not a frame)', () => {
    const prose = `As I mentioned, the API Error: 500 you saw earlier was transient.\n${PROMPT_TAIL}`;
    expect(classifyIdleError(prose, PATTERNS).isTerminalError).toBe(false);
  });
  it('SUPPRESSES quoted structured-code source literals (the self-collision case)', () => {
    const src = `  'invalid_request_error',\n  'ECONNREFUSED',\n  'ETIMEDOUT',\n${PROMPT_TAIL}`;
    expect(classifyIdleError(src, PATTERNS).isTerminalError).toBe(false);
  });
  it("SUPPRESSES a tool's own glyph-led Error: connect ECONNREFUSED (begins 'Error:', not a pattern)", () => {
    expect(classifyIdleError(`  ⎿  Error: connect ECONNREFUSED 127.0.0.1:5432\n${PROMPT_TAIL}`, PATTERNS).isTerminalError).toBe(false);
  });
  it('SUPPRESSES empty / whitespace-only panes (no crash)', () => {
    expect(classifyIdleError('', PATTERNS).isTerminalError).toBe(false);
    expect(classifyIdleError('   \n  \n', PATTERNS).isTerminalError).toBe(false);
  });
});

describe('classifyIdleError — whole-window scan + tail width', () => {
  it('finds a wrapped error whose API Error: lead sits ~10 non-empty lines above the prompt', () => {
    const chrome = Array.from({ length: 8 }, (_, i) => `chrome line ${i}`).join('\n');
    const pane = `${REAL_AUP}\nwrapped continuation of the error\n${chrome}\n${PROMPT_TAIL}`;
    expect(classifyIdleError(pane, PATTERNS).isTerminalError).toBe(true);
  });
  it('the input-box-chrome capture test: fires at the 45-row capture, MISSES at 30', () => {
    // ~28 PHYSICAL rows of post-error chrome but only ~10 NON-EMPTY (realistic input box:
    // box borders + blank lines + a few hint rows). Tall enough that a 30-row PHYSICAL
    // capture drops the error, but the non-empty tail still reaches it at 45 rows.
    const chromeRow = (i: number) => (i % 3 === 0 ? `│ chrome ${i}` : '');
    const chrome28 = Array.from({ length: 28 }, (_, i) => chromeRow(i)).join('\n');
    const fullPane = `prior work line\n${REAL_AUP}\n${chrome28}\n${PROMPT_TAIL}`;
    const last45 = fullPane.split('\n').slice(-45).join('\n');
    const last30 = fullPane.split('\n').slice(-30).join('\n');
    expect(classifyIdleError(last45, PATTERNS).isTerminalError).toBe(true);
    // At 30 PHYSICAL rows the error has scrolled out of the captured window → miss (the bug 45 fixes).
    expect(last30.includes('API Error:')).toBe(false);
    expect(classifyIdleError(last30, PATTERNS).isTerminalError).toBe(false);
  });
});

describe('classifyIdleError — parametrized over all 11 patterns', () => {
  for (const p of PATTERNS) {
    it(`fires when "${p}" leads a glyph-led frame, suppresses it as bare mid-content prose`, () => {
      const framed = p === 'API Error:' ? `⏺ ${p} detail` : `⏺ ${p}`;
      expect(classifyIdleError(`${framed}\n${PROMPT_TAIL}`, PATTERNS).isTerminalError).toBe(true);
      // bare, non-glyph, mid-sentence → suppressed
      expect(classifyIdleError(`the value ${p} appeared in a log line\n${PROMPT_TAIL}`, PATTERNS).isTerminalError).toBe(false);
    });
  }
});

describe('classifyIdleError — audit fields are bounded', () => {
  it('clamps matchedLine and strips newlines', () => {
    const long = '⏺ API Error: ' + 'x'.repeat(500);
    const r = classifyIdleError(`${long}\n${PROMPT_TAIL}`, PATTERNS);
    expect(r.matchedLine!.length).toBeLessThanOrEqual(200);
    expect(r.matchedLine).not.toContain('\n');
  });
});

describe('paneTail helpers', () => {
  it('liveTail returns the last N non-empty trimmed lines AS LINES', () => {
    const t = liveTail('a\n\n  b  \n\nc\n', 2);
    expect(t).toEqual(['b', 'c']);
  });
  it('stripLineLead removes leading glyphs + whitespace, exposing content', () => {
    expect(stripLineLead('  ⎿  API Error: x')).toBe('API Error: x');
    expect(stripLineLead('⏺ fetch failed')).toBe('fetch failed');
    expect(stripLineLead('plain content')).toBe('plain content');
  });
  it('wasGlyphLed is true only when a known glyph led the line', () => {
    expect(wasGlyphLed('⏺ API Error: x')).toBe(true);
    expect(wasGlyphLed('  ⎿  API Error: x')).toBe(true);
    expect(wasGlyphLed('API Error: x')).toBe(false);
    expect(wasGlyphLed('  plain content')).toBe(false);
  });
});
