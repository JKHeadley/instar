/**
 * Pins the INSTAR-Bench v2 A/B-proven InputClassifier prompt edits
 * (ab-input-classifier: CLEAN-WIN 3 fixed / 0 regressed post-arbitration):
 * the defined "unsure" catch-all (undefined unsure absorbed prompts matching
 * explicit APPROVE bullets — 4/8 routes over-relayed a canonical in-project
 * edit) and the trailing answer-only contract (haiku wrapped correct verdicts
 * in prose the one-word parser rejects).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '../../src/monitoring/InputClassifier.ts'), 'utf8');

describe('InputClassifier prompt (bench-proven contract)', () => {
  it('defines the unsure catch-all instead of leaving it open', () => {
    expect(src).toContain('unsure means the prompt matches NO bullet above');
    expect(src).toContain('matching');
    expect(src).toContain('an APPROVE bullet is never unsure');
  });
  it('states that a relative path is inside the project directory', () => {
    expect(src).toContain('a relative file path with no ../ traversal is INSIDE the project');
  });
  it('closes with the answer-only reinforcement', () => {
    expect(src).toContain('Answer with the single word only — APPROVE or RELAY');
  });
});
