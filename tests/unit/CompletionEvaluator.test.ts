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
