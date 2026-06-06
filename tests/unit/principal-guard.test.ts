/**
 * Unit tests — PrincipalGuard (Know Your Principal standard, Phase 1).
 *
 * Covers both sides of every boundary, and the INCIDENT-REPLAY regression test
 * the spec mandates: the three real "Caroline" doc lines, with the topic bound
 * to Justin, must all be caught (block for mandate/credential, warn for prose);
 * the same lines attributed to the bound operator must all pass.
 */
import { describe, it, expect } from 'vitest';
import {
  establishOperator,
  detectAttributions,
  evaluatePrincipalCoherence,
} from '../../src/core/PrincipalGuard.js';

describe('establishOperator', () => {
  it('establishes from an authenticated uid (the authority)', () => {
    const op = establishOperator('7812716706', 'Justin');
    expect(op?.uid).toBe('7812716706');
    expect(op?.names).toEqual(['justin']);
  });
  it('returns null for a blank uid (unbound topic) — never invents an operator', () => {
    expect(establishOperator('', 'Justin')).toBeNull();
    expect(establishOperator('   ')).toBeNull();
  });
  it('a content name can never BECOME the operator — only the uid does', () => {
    // establishOperator takes the authenticated uid; there is no code path that
    // accepts a name from text. (The whole Caroline failure.)
    const op = establishOperator('7812716706'); // no display name
    expect(op?.names).toEqual([]);
    expect(op?.uid).toBe('7812716706');
  });
});

describe('detectAttributions', () => {
  it('catches the operator-role decision shapes', () => {
    const kinds = detectAttributions(
      'Mandate (Caroline). Locked with Caroline. Caroline approved it. ' +
        'Standing requirement from Caroline. Caroline dropped a token. on behalf of Caroline.',
    ).map((a) => a.kind);
    expect(kinds).toContain('mandate');
    expect(kinds).toContain('lock');
    expect(kinds).toContain('approval');
    expect(kinds).toContain('credential');
    expect(kinds).toContain('acting-for');
  });
  it('does NOT flag non-principal capitalized nouns', () => {
    expect(detectAttributions('Production approved the deploy.')).toHaveLength(0);
    expect(detectAttributions('The Board approved it.')).toHaveLength(0);
    expect(detectAttributions('CI approved the merge.')).toHaveLength(0);
  });
  it('does NOT flag ordinary prose with no decision attribution', () => {
    expect(detectAttributions('We shipped the feature and ran the tests.')).toHaveLength(0);
  });
});

describe('evaluatePrincipalCoherence — the boundary', () => {
  const justin = establishOperator('7812716706', 'Justin');

  it('PASSES when the decision is attributed to the bound operator', () => {
    expect(evaluatePrincipalCoherence('Justin approved it.', justin)).toHaveLength(0);
    expect(evaluatePrincipalCoherence('Mandate (Justin).', justin)).toHaveLength(0);
  });

  it('PASSES when attributed to another KNOWN user (resolves in the registry)', () => {
    expect(evaluatePrincipalCoherence('Dana approved it.', justin, ['dana'])).toHaveLength(0);
  });

  it('FLAGS an unknown principal; BLOCKS authority/credential, WARNS prose', () => {
    const f = evaluatePrincipalCoherence(
      'Mandate (Caroline). Caroline approved the page. Caroline dropped a token.',
      justin,
      ['dana'],
    );
    const byKind = Object.fromEntries(f.map((x) => [x.attribution.kind, x.verdict]));
    expect(byKind['mandate']).toBe('block');
    expect(byKind['credential']).toBe('block');
    expect(byKind['approval']).toBe('warn');
  });

  it('treats EVERY attribution as unverifiable when the topic has no bound operator', () => {
    const f = evaluatePrincipalCoherence('Caroline approved it.', null);
    expect(f).toHaveLength(1);
    expect(f[0].reason).toMatch(/no bound operator/);
  });
});

// ── The incident-replay regression test (spec §test plan) ────────────
describe('Caroline incident replay — would this have caught it?', () => {
  const justin = establishOperator('7812716706', 'Justin');
  const realDocLines = [
    'Mandate (Caroline): every EXO 3.0 feature must pass a Tier-4 verification.',
    'Locked 2026-06-04 with Caroline.',
    'Standing requirement from Caroline (2026-06-04): unit/integration/e2e do not prove agent behavior.',
    'have Caroline drop a token via Secret Drop.',
  ];

  it('catches ALL three+ real Caroline doc lines with the topic bound to Justin', () => {
    for (const line of realDocLines) {
      const f = evaluatePrincipalCoherence(line, justin, ['dana', 'codey']);
      expect(f.length, `should flag: ${line}`).toBeGreaterThan(0);
      expect(f[0].attribution.principal).toBe('caroline');
    }
  });

  it('the mandate + credential lines BLOCK (authority-bearing)', () => {
    const mandate = evaluatePrincipalCoherence(realDocLines[0], justin);
    const cred = evaluatePrincipalCoherence(realDocLines[3], justin);
    expect(mandate[0].verdict).toBe('block');
    expect(cred[0].verdict).toBe('block');
  });

  it('the SAME lines attributed to the bound operator all pass (no false positives)', () => {
    for (const line of realDocLines) {
      const asJustin = line.replace(/Caroline/g, 'Justin');
      expect(evaluatePrincipalCoherence(asJustin, justin), `should pass: ${asJustin}`).toHaveLength(0);
    }
  });
});
