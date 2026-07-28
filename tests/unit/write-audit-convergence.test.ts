import { describe, it, expect } from 'vitest';
import {
  parseFrontmatter,
  parseRounds,
  parseLedgerRow,
  validateDisposition,
  validateExemption,
  validateAuditReport,
  stampConverged,
} from '../../scripts/write-audit-convergence.mjs';

// A compliant converged report (2 rounds, final clean, exemption path so no git
// standing-guard resolution is needed in the unit layer).
const COMPLIANT = `---
audit: "sample-audit"
target-pattern: "silent catches"
search-surface: "src/"
converged: ""
exemption: "non-ci-expressible — the pattern needs human judgement to classify"
---

# Sample Audit

## Round 1
Search angles: grep for \`catch {}\`, ast-grep empty-catch.
Surface delta: initial sweep of src/ (0 → 120 files).

| location | behavior | bucket | disposition |
|----------|----------|--------|-------------|
| src/a.ts:10 | swallows error | silent-catch | fixed:abc1234 |
| src/b.ts:20 | empty catch | silent-catch | accepted:intentional best-effort cache write |

New findings this round: 2

## Round 2
Search angles: re-ran both greps on the post-fix tree.
Surface delta: surface unchanged (120 files).

New findings this round: 0
`;

describe('parseFrontmatter', () => {
  it('parses the first block only and strips quotes', () => {
    const { fields } = parseFrontmatter(COMPLIANT);
    expect(fields.audit).toBe('sample-audit');
    expect(fields.exemption).toContain('non-ci-expressible');
  });
  it('refuses a duplicate managed key (converged)', () => {
    const dup = COMPLIANT.replace('converged: ""', 'converged: ""\nconverged: "2020-01-01"');
    expect(() => parseFrontmatter(dup)).toThrow(/duplicate managed frontmatter key: converged/);
  });
  it('throws on a file that does not open with ---', () => {
    expect(() => parseFrontmatter('# no frontmatter\n')).toThrow(/no frontmatter/);
  });
});

describe('parseLedgerRow', () => {
  it('parses a well-formed table row', () => {
    const row = parseLedgerRow('| src/a.ts:10 | swallows | silent-catch | fixed:abc |');
    expect(row).toEqual({ location: 'src/a.ts:10', behavior: 'swallows', bucket: 'silent-catch', disposition: 'fixed:abc' });
  });
  it('returns null for a table separator', () => {
    expect(parseLedgerRow('|----|----|----|----|')).toBeNull();
  });
  it('FAIL-CLOSED: a ledger-like line with <4 fields throws, never silently skipped', () => {
    expect(() => parseLedgerRow('| src/a.ts:10 | swallows | fixed:abc |')).toThrow(/does not parse into 4/);
  });
});

describe('validateDisposition', () => {
  it('accepts fixed/accepted/deferred with a non-empty ref', () => {
    expect(validateDisposition('fixed:abc123').ok).toBe(true);
    expect(validateDisposition('accepted:a real reason').ok).toBe(true);
    expect(validateDisposition('deferred:ACT-1191').ok).toBe(true);
  });
  it('refuses an empty ref and an unknown kind', () => {
    expect(validateDisposition('fixed:').ok).toBe(false);
    expect(validateDisposition('wontfix:meh').ok).toBe(false);
  });
});

describe('validateExemption', () => {
  it('accepts a closed-enum key with a real rationale', () => {
    expect(validateExemption('non-ci-expressible — needs human judgement here').ok).toBe(true);
  });
  it('refuses an off-enum key', () => {
    expect(validateExemption('because-i-said-so — some words here').ok).toBe(false);
  });
  it('refuses too-short rationale', () => {
    expect(validateExemption('external-system — x').ok).toBe(false);
  });
});

describe('parseRounds fail-closed', () => {
  it('parses contiguous rounds', () => {
    const rounds = parseRounds(COMPLIANT);
    expect(rounds.map((r) => r.n)).toEqual([1, 2]);
    expect(rounds[0].rows.length).toBe(2);
    expect(rounds[1].rows.length).toBe(0);
  });
  it('FAIL-CLOSED: throws on a present-but-non-integer New-findings line', () => {
    const bad = COMPLIANT.replace('New findings this round: 0', 'New findings this round: none');
    // present-but-malformed must REFUSE (round-unparseable), never be read as absent/zero
    expect(() => parseRounds(bad)).toThrow(/New findings this round/);
  });
});

describe('validateAuditReport', () => {
  it('GRANTS the compliant fixture', () => {
    const r = validateAuditReport(COMPLIANT, { basenameSlug: 'sample-audit' });
    expect(r.ok).toBe(true);
    expect(r.rounds.length).toBe(2);
  });
  it('REFUSES with only 1 round', () => {
    const oneRound = COMPLIANT.split('## Round 2')[0];
    const r = validateAuditReport(oneRound, { basenameSlug: 'sample-audit' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/≥2 rounds/);
  });
  it('REFUSES a non-zero final round', () => {
    const bad = COMPLIANT.replace('New findings this round: 0', 'New findings this round: 1');
    const r = validateAuditReport(bad, { basenameSlug: 'sample-audit' });
    expect(r.ok).toBe(false);
  });
  it('REFUSES a line-vs-rows MISMATCH', () => {
    const bad = COMPLIANT.replace('New findings this round: 2', 'New findings this round: 5');
    const r = validateAuditReport(bad, { basenameSlug: 'sample-audit' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/contradicts/);
  });
  it('REFUSES basename != slug', () => {
    const r = validateAuditReport(COMPLIANT, { basenameSlug: 'wrong-name' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/basename/);
  });
  it('REFUSES a bad slug charset', () => {
    const bad = COMPLIANT.replace('audit: "sample-audit"', 'audit: "Bad_Slug!"');
    const r = validateAuditReport(bad, { basenameSlug: 'Bad_Slug!' });
    expect(r.ok).toBe(false);
  });
  it('REFUSES both standing-guard and exemption set (XOR)', () => {
    const both = COMPLIANT.replace('converged: ""', 'converged: ""\nstanding-guard: "tests/unit/x.test.ts"');
    const r = validateAuditReport(both, { basenameSlug: 'sample-audit' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/XOR/);
  });
  it('REFUSES a round missing search-angles', () => {
    const bad = COMPLIANT.replace('Search angles: grep for `catch {}`, ast-grep empty-catch.\n', '');
    const r = validateAuditReport(bad, { basenameSlug: 'sample-audit' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/search-angles/);
  });
});

describe('stampConverged byte-idempotent', () => {
  it('stamps an empty converged with the given ISO', () => {
    const out = stampConverged(COMPLIANT, 2, '2026-07-11T00:00:00.000Z');
    expect(out).toMatch(/converged: "2026-07-11T00:00:00.000Z"/);
    expect(out).toMatch(/rounds: "2"/);
  });
  it('PRESERVES an existing valid timestamp (re-run is byte-identical)', () => {
    const first = stampConverged(COMPLIANT, 2, '2026-07-11T00:00:00.000Z');
    const second = stampConverged(first, 2, '2099-01-01T00:00:00.000Z');
    expect(second).toBe(first); // idempotent — the 2099 clock is ignored
  });
});
