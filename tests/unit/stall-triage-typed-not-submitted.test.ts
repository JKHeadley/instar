/**
 * Tests for the StallTriageNurse fast-path heuristic that detects
 * "typed-but-not-submitted" terminal state and auto-nudges (sends Enter)
 * without invoking the LLM.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const NURSE_SRC = path.join(process.cwd(), 'src/monitoring/StallTriageNurse.ts');

describe('StallTriageNurse — typed-but-not-submitted fast path', () => {
  const source = fs.readFileSync(NURSE_SRC, 'utf-8');

  it('declares a detection function for typed-but-not-submitted', () => {
    expect(source).toMatch(/detectTypedButNotSubmitted|isTypedButNotSubmitted|typedNotSubmitted/);
  });

  it('fast-path matches bypass LLM diagnosis and choose nudge', () => {
    // The triage flow must check the heuristic BEFORE calling diagnose().
    const triageStart = source.indexOf('async triage(');
    const triageEnd = source.indexOf('\n  }', triageStart);
    const triageBody = source.slice(triageStart, triageEnd);
    // The heuristic is referenced inside triage() and precedes "diagnose"
    const heuristicIdx = triageBody.search(/detectTypedButNotSubmitted|isTypedButNotSubmitted|typedNotSubmitted/);
    const diagnoseIdx = triageBody.indexOf('this.diagnose(');
    expect(heuristicIdx).toBeGreaterThan(-1);
    expect(diagnoseIdx).toBeGreaterThan(-1);
    expect(heuristicIdx).toBeLessThan(diagnoseIdx);
  });

  it('detection checks for ❯ prompt marker with non-empty text', () => {
    const fnIdx = source.search(/function\s+detectTypedButNotSubmitted|detectTypedButNotSubmitted\s*\(/);
    const fnBlock = source.slice(fnIdx, fnIdx + 2000);
    expect(fnBlock).toContain('❯');
  });

  it('detection excludes output with processing indicators', () => {
    const fnIdx = source.search(/function\s+detectTypedButNotSubmitted|detectTypedButNotSubmitted\s*\(/);
    const fnBlock = source.slice(fnIdx, fnIdx + 2000);
    // At least one common processing indicator must be in the exclusion list
    // (⎿, ✶, ⏺, thinking, Coalescing)
    const hasProcessingCheck =
      fnBlock.includes('⎿') ||
      fnBlock.includes('✶') ||
      fnBlock.includes('⏺') ||
      fnBlock.toLowerCase().includes('coalescing') ||
      fnBlock.toLowerCase().includes('thinking');
    expect(hasProcessingCheck).toBe(true);
  });

  it('has a minimum text length threshold to avoid false positives', () => {
    const fnIdx = source.search(/function\s+detectTypedButNotSubmitted|detectTypedButNotSubmitted\s*\(/);
    const fnBlock = source.slice(fnIdx, fnIdx + 2000);
    // Some minimum length check (e.g., > 20 chars)
    expect(fnBlock).toMatch(/length\s*[>≥]=?\s*\d{2}/);
  });
});
