/**
 * CompletionEvaluator — independent "is the goal met?" judge.
 */

import { describe, it, expect } from 'vitest';
import { CompletionEvaluator } from '../../src/core/CompletionEvaluator.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';

function stubProvider(reply: string | (() => Promise<string>)): IntelligenceProvider {
  return {
    async evaluate(_prompt: string, _opts?: IntelligenceOptions): Promise<string> {
      return typeof reply === 'function' ? reply() : reply;
    },
  };
}

describe('CompletionEvaluator', () => {
  it('returns met:true on a MET verdict', async () => {
    const e = new CompletionEvaluator({ intelligence: stubProvider('MET\nAll tests in test/auth pass per the transcript.') });
    const v = await e.evaluate('all tests pass', 'ran npm test → 42 passed, 0 failed');
    expect(v.met).toBe(true);
    expect(v.reason).toMatch(/tests/i);
  });

  it('returns met:false on a NOT_MET verdict, with reason', async () => {
    const e = new CompletionEvaluator({ intelligence: stubProvider('NOT_MET\n3 tests still failing in test/auth.') });
    const v = await e.evaluate('all tests pass', 'npm test → 39 passed, 3 failed');
    expect(v.met).toBe(false);
    expect(v.reason).toMatch(/failing/i);
  });

  it('does not confuse NOT_MET with MET (substring guard)', async () => {
    const e = new CompletionEvaluator({ intelligence: stubProvider('NOT MET\nstill working') });
    expect((await e.evaluate('x', 'y')).met).toBe(false);
  });

  it('fails SAFE (met:false) on an empty response', async () => {
    const e = new CompletionEvaluator({ intelligence: stubProvider('') });
    expect((await e.evaluate('x', 'y')).met).toBe(false);
  });

  it('fails SAFE (met:false) on an ambiguous response', async () => {
    const e = new CompletionEvaluator({ intelligence: stubProvider('hmm, maybe? hard to say') });
    const v = await e.evaluate('x', 'y');
    expect(v.met).toBe(false);
    expect(v.reason).toMatch(/ambiguous/i);
  });

  it('fails SAFE (met:false) when the provider throws — never a false "done"', async () => {
    const e = new CompletionEvaluator({ intelligence: stubProvider(async () => { throw new Error('LLM down'); }) });
    const v = await e.evaluate('x', 'y');
    expect(v.met).toBe(false);
    expect(v.reason).toMatch(/error/i);
  });

  it('defaults to the fast model tier', () => {
    const e = new CompletionEvaluator({ intelligence: stubProvider('MET\nok') });
    expect(e.promptVersion).toBe('completion-eval-v1');
  });
});

describe('CompletionEvaluator.evaluateStopRationale (P13 "The Stop Reason Is the Work")', () => {
  it('STOP_BLOCKED → stopAllowed:false, with guidance', async () => {
    const e = new CompletionEvaluator({ intelligence: stubProvider('STOP_BLOCKED\nStopping because "I need your judgment" with no derived standard or artifact shown.') });
    const v = await e.evaluateStopRationale('I should stop here and get your judgment on the approach.');
    expect(v.stopAllowed).toBe(false);
    expect(v.guidance).toMatch(/judgment|derive|artifact|P13/i);
  });

  it('STOP_OK → stopAllowed:true (a built artifact was handed over)', async () => {
    const e = new CompletionEvaluator({ intelligence: stubProvider('STOP_OK\nThe run shipped PR #123 and handed it over for review.') });
    const v = await e.evaluateStopRationale('Opened PR #123 with the fix; handing it over for review.');
    expect(v.stopAllowed).toBe(true);
    expect(v.guidance).toBe('');
  });

  it('does not confuse STOP_BLOCKED with STOP_OK (space variant)', async () => {
    const e = new CompletionEvaluator({ intelligence: stubProvider('STOP BLOCKED\nneeds engineering, no artifact') });
    expect((await e.evaluateStopRationale('x')).stopAllowed).toBe(false);
  });

  it('fails OPEN (stopAllowed:true) on an empty response — never traps a genuine completion', async () => {
    const e = new CompletionEvaluator({ intelligence: stubProvider('') });
    expect((await e.evaluateStopRationale('done')).stopAllowed).toBe(true);
  });

  it('fails OPEN (stopAllowed:true) on an ambiguous verdict', async () => {
    const e = new CompletionEvaluator({ intelligence: stubProvider('hmm, not sure') });
    expect((await e.evaluateStopRationale('x')).stopAllowed).toBe(true);
  });

  it('fails OPEN (stopAllowed:true) when the provider throws', async () => {
    const e = new CompletionEvaluator({ intelligence: stubProvider(async () => { throw new Error('LLM down'); }) });
    expect((await e.evaluateStopRationale('x')).stopAllowed).toBe(true);
  });
});
