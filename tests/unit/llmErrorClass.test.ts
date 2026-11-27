/**
 * CMT-2289 — classifyLlmError maps a thrown provider error to ONE fixed label
 * and never returns message text.
 */
import { describe, it, expect } from 'vitest';
import { classifyLlmError, isLlmErrorClass, LLM_ERROR_CLASSES } from '../../src/core/llmErrorClass.js';
import { RateLimitError } from '../../src/core/LlmCircuitBreaker.js';
import { LlmCapacityUnavailableError } from '../../src/core/SpawnCapIntelligenceProvider.js';

describe('classifyLlmError', () => {
  const cases: Array<[string, unknown, string]> = [
    ['RateLimitError instance', new RateLimitError('429 too many requests'), 'rate-limit'],
    ['rate-limit wording', new Error('Claude CLI error: Command failed — usage limit reached, resets at 5pm'), 'rate-limit'],
    ['spawn capacity error', new LlmCapacityUnavailableError('acquire-timeout', 2000), 'capacity'],
    ['auth verdict appended by the claude provider', new Error('Claude CLI error: Command failed: claude — auth: not-logged-in'), 'auth'],
    ['codex account missing', new Error('CodexCliIntelligenceProvider: required subscription account missing'), 'auth'],
    ['gate race timeout', new Error('timeout'), 'timeout'],
    ['AbortError', Object.assign(new Error('aborted'), { name: 'AbortError' }), 'timeout'],
    ['killed child', Object.assign(new Error('Command failed: gemini'), { killed: true }), 'timeout'],
    ['max turns', new Error('Error: Reached max turns (1)'), 'max-turns'],
    ['missing binary', new Error('spawn gemini ENOENT'), 'spawn-error'],
    ['router framework unavailable', new Error("IntelligenceRouter: required framework 'gemini-cli' unavailable"), 'no-route'],
    ['launch guard', new Error('CodexCliIntelligenceProvider: launch guard refused'), 'no-route'],
    ['empty completion', new Error('pi CLI returned an empty completion'), 'parse'],
    ['SyntaxError', new SyntaxError('Unexpected token < in JSON at position 0'), 'parse'],
    ['plain non-zero exit', new Error('Gemini CLI error: Command failed: gemini -p … exit code 1'), 'cli-exit'],
    ['unrecognised', new Error('something odd happened'), 'other'],
    ['non-error value', 42, 'other'],
    ['null', null, 'other'],
  ];
  for (const [name, err, want] of cases) {
    it(`${name} → ${want}`, () => {
      expect(classifyLlmError(err)).toBe(want);
    });
  }

  it('the most specific signal wins: a rate-limit inside a failed command is rate-limit, not cli-exit', () => {
    expect(classifyLlmError(new Error('Command failed: claude — 429 rate limit exceeded'))).toBe('rate-limit');
  });

  it('always returns a closed-set label, never any part of the message (no-text guarantee)', () => {
    const secretish = 'Command failed: security add-generic-password -w SUPERSECRETVALUE123 prompt text here';
    const out = classifyLlmError(new Error(secretish));
    expect(LLM_ERROR_CLASSES as readonly string[]).toContain(out);
    expect(out).not.toContain('SUPERSECRET');
    expect(out.length).toBeLessThanOrEqual(12);
  });

  it('never throws on a hostile error object', () => {
    const hostile = new Proxy({}, { get() { throw new Error('boom'); } });
    expect(() => classifyLlmError(hostile)).not.toThrow();
    expect(classifyLlmError(hostile)).toBe('other');
  });

  it('isLlmErrorClass accepts only the closed set', () => {
    for (const c of LLM_ERROR_CLASSES) expect(isLlmErrorClass(c)).toBe(true);
    expect(isLlmErrorClass('Command failed: x')).toBe(false);
    expect(isLlmErrorClass(undefined)).toBe(false);
  });
});
