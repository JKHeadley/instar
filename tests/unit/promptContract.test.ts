/**
 * promptContract library tests — the pure contract-manifest helpers of the
 * Prompt↔Parser Contract standard (docs/specs/prompt-parser-contract-standard.md).
 *
 * These cover `deriveRejectedForms`, the mechanical generator for the
 * counter-examples a per-callsite contract test feeds the REAL parser to prove
 * its fail-closed behavior. The generator is the anti-gaming arm of the standard
 * (spec §2: "a hand-only list invites trivial rejects"), so its mutation logic —
 * the exact B15 prefix-truncation shape included — is pinned here.
 *
 * Dark-by-construction: the library has no runtime caller in this increment; it
 * is exercised only by these tests and, later, by the per-callsite contract
 * tests that graduate on the shrink-only schedule.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveRejectedForms,
  type PromptContract,
  type ContractForm,
} from '../../src/core/promptContract.js';

describe('deriveRejectedForms', () => {
  it('derives the historical B15 prefix-truncation shape', () => {
    const forms = deriveRejectedForms(['B15_CONTEXT_DEATH_STOP']);
    // The exact defect: the model emits the leading segment the parser rejects.
    expect(forms).toContain('B15');
    // Separator-stripped form is also derived.
    expect(forms).toContain('B15CONTEXTDEATHSTOP');
  });

  it('derives case mutations (upper / lower / first-letter-flipped)', () => {
    const forms = deriveRejectedForms(['Warn']);
    expect(forms).toContain('WARN');
    expect(forms).toContain('warn');
  });

  it('first-letter-flip flips only the first character', () => {
    const forms = deriveRejectedForms(['WARN']);
    // 'WARN' → flip leading 'W' to 'w', keep the rest → 'wARN'
    expect(forms).toContain('wARN');
  });

  it('appends hand-picked extras', () => {
    const forms = deriveRejectedForms(['B15_CONTEXT_DEATH_STOP'], ['', 'totally-made-up']);
    expect(forms).toContain('');
    expect(forms).toContain('totally-made-up');
  });

  it('EXCLUDES any derived/extra form that collides with a promised token', () => {
    // 'PASS' is a promised token; its own upper-case mutation must not appear as
    // a "rejected form" (that would make fail-closed contradict acceptance).
    const forms = deriveRejectedForms(['PASS', 'block_message']);
    expect(forms).not.toContain('PASS');
    // an extra that happens to equal a promised token is also excluded
    const forms2 = deriveRejectedForms(['PASS'], ['PASS']);
    expect(forms2).not.toContain('PASS');
  });

  it('de-duplicates and returns a stable set', () => {
    const forms = deriveRejectedForms(['A_B', 'A_B']);
    const counts = new Map<string, number>();
    for (const f of forms) counts.set(f, (counts.get(f) ?? 0) + 1);
    for (const [, n] of counts) expect(n).toBe(1);
  });

  it('honors a custom separator set', () => {
    const forms = deriveRejectedForms(['ROLE::ADMIN'], [], { separators: [':'] });
    // prefix-truncation at the first ':' → 'ROLE'
    expect(forms).toContain('ROLE');
    // separator-stripped → 'ROLEADMIN'
    expect(forms).toContain('ROLEADMIN');
  });

  it('ignores empty / non-string vocabulary entries without throwing', () => {
    expect(() => deriveRejectedForms(['', 'OK'])).not.toThrow();
    const forms = deriveRejectedForms(['', 'OK']);
    // an empty promised token contributes nothing; 'OK' still mutates
    expect(forms).toContain('ok');
  });

  it('is a PURE function — the same inputs yield an equal result', () => {
    const a = deriveRejectedForms(['B15_CONTEXT_DEATH_STOP'], ['B15']);
    const b = deriveRejectedForms(['B15_CONTEXT_DEATH_STOP'], ['B15']);
    expect(a).toEqual(b);
  });
});

describe('PromptContract type surface', () => {
  it('a fallback-form manifest type-checks with a real parser reference', () => {
    const RULE_IDS = ['B15_CONTEXT_DEATH_STOP', 'B16_FATIGUE_STOP'] as const;
    const parseVerdict = (raw: string): string | null =>
      (RULE_IDS as readonly string[]).includes(raw) ? raw : null;

    const contract: PromptContract<string | null> = {
      promisedOutputs: RULE_IDS,
      rejectedForms: deriveRejectedForms(RULE_IDS, ['B15', '']),
      hazardPatterns: [/\bB\d+\b(?!_)/],
      envelope: { shape: 'json', verdictField: 'rule' },
      acceptedAliases: [],
      parser: parseVerdict,
    };

    // The parser reference is real and the derived rejects genuinely reject.
    expect(contract.parser('B15_CONTEXT_DEATH_STOP')).toBe('B15_CONTEXT_DEATH_STOP');
    expect(contract.parser('B15')).toBeNull();
    expect(contract.rejectedForms).toContain('B15');
    expect(contract.rejectedForms).not.toContain('B16_FATIGUE_STOP');
  });

  it('ContractForm is the two-value election used by the coverage record', () => {
    const forms: ContractForm[] = ['single-source', 'manifest'];
    expect(forms).toHaveLength(2);
  });
});
