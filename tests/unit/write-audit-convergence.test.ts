import { describe, it, expect } from 'vitest';
import {
  parseFrontmatter,
  parseRounds,
  parseLedgerRow,
  validateDisposition,
  validateExemption,
  validateAuditReport,
  validateStandardResponse,
  parseMetaInsight,
  stampConverged,
} from '../../scripts/write-audit-convergence.mjs';

// A compliant converged report (2 rounds, final clean, exemption path so no git
// standing-guard resolution is needed in the unit layer).
const COMPLIANT_UNSTAMPED = `---
audit: "sample-audit"
target-pattern: "silent catches"
search-surface: "src/"
converged: ""
exemption: "non-ci-expressible — the pattern needs human judgement to classify"
blind-spot-class: "presence-without-enforcement"
standard-response-kind: "no-change"
standard-response-ref: "docs/STANDARDS.md"
standard-response-article-id: "silent-catch-accountability"
standard-response-article: "Silent Catch Accountability"
standard-response-rationale: "The existing rule already covers the enforcement gap found by this audit."
---

# Sample Audit

## Meta-insight

How it arose: Individual catch sites were reviewed, but coverage was never required across the complete execution surface.
Why prior controls missed it: Earlier checks measured whether a rule existed, not whether every matching implementation path enforced it.

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
const COMPLIANT = stampConverged(COMPLIANT_UNSTAMPED, 2, '2026-07-11T00:00:00.000Z');

describe('parseFrontmatter', () => {
  it('parses the first block only and strips quotes', () => {
    const { fields } = parseFrontmatter(COMPLIANT);
    expect(fields.audit).toBe('sample-audit');
    expect(fields.exemption).toContain('non-ci-expressible');
  });
  it('refuses a duplicate managed key (converged)', () => {
    const dup = COMPLIANT_UNSTAMPED.replace('converged: ""', 'converged: ""\nconverged: "2020-01-01"');
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
    expect(r.responseKind).toBe('no-change');
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
    const both = COMPLIANT_UNSTAMPED.replace('converged: ""', 'converged: ""\nstanding-guard: "tests/unit/x.test.ts"');
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
    const out = stampConverged(COMPLIANT_UNSTAMPED, 2, '2026-07-11T00:00:00.000Z');
    expect(out).toMatch(/converged: "2026-07-11T00:00:00.000Z"/);
    expect(out).toMatch(/rounds: "2"/);
  });
  it('PRESERVES an existing valid timestamp (re-run is byte-identical)', () => {
    const first = stampConverged(COMPLIANT_UNSTAMPED, 2, '2026-07-11T00:00:00.000Z');
    const second = stampConverged(first, 2, '2099-01-01T00:00:00.000Z');
    expect(second).toBe(first); // idempotent — the 2099 clock is ignored
  });
});

describe('sixth-condition meta artifact', () => {
  it('ignores a fenced counterfeit Meta-insight and requires the one real section', () => {
    const withFence = COMPLIANT.replace('# Sample Audit', '# Sample Audit\n\n```md\n## Meta-insight\nHow it arose: fake\nWhy prior controls missed it: fake\n```');
    expect(parseMetaInsight(withFence).howItArose).toMatch(/Individual catch sites/);
  });

  it('does not let a shorter fence close a longer fence and expose counterfeit headings', () => {
    const withUnequalFence = COMPLIANT.replace(
      '# Sample Audit',
      '# Sample Audit\n\n````md\n## Meta-insight\nHow it arose: first fenced counterfeit\nWhy prior controls missed it: first fenced counterfeit\n```\n## Meta-insight\nHow it arose: exposed only if the short fence wrongly closes the long opening delimiter.\nWhy prior controls missed it: exposed only if the short fence wrongly closes the long opening delimiter.\n````',
    );
    expect(parseMetaInsight(withUnequalFence).howItArose).toMatch(/Individual catch sites/);
  });

  it('refuses duplicate causal declarations', () => {
    const duplicate = COMPLIANT.replace('Why prior controls missed it:', 'How it arose: This duplicate declaration is long enough to cross the minimum bound safely.\nWhy prior controls missed it:');
    expect(() => parseMetaInsight(duplicate)).toThrow(/exactly one/);
  });

  it('binds the timestamp and causal prose into the meta digest', () => {
    const forged = COMPLIANT.replace('meta-artifact-at: "2026-07-11T00:00:00.000Z"', 'meta-artifact-at: "2099-01-01T00:00:00.000Z"');
    const result = validateAuditReport(forged, { basenameSlug: 'sample-audit' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/meta-artifact-digest is stale/);
  });
});

describe('standard response closed matrix', () => {
  const base = `## Family\n\n### Existing Rule\n\n**Article ID.** \`existing-rule\`\n\n**Rule.** Original meaning.\n`;
  const fields = {
    'standard-response-kind': 'no-change',
    'standard-response-ref': 'docs/STANDARDS.md',
    'standard-response-article-id': 'existing-rule',
    'standard-response-article': 'Existing Rule',
  };
  const opts = (candidateText: string, baseText = base) => ({
    root: process.cwd(),
    standardEvidence: { responseChanged: true, candidateText, baseText, candidateRegular: true, candidateTracked: true },
  });

  it('accepts a true no-change response', () => {
    expect(validateStandardResponse(fields, opts(base)).ok).toBe(true);
  });

  it('refuses non-regular candidate and base Git snapshots', () => {
    const candidateSymlink = opts(base);
    candidateSymlink.standardEvidence.candidateRegular = false;
    expect(validateStandardResponse(fields, candidateSymlink).ok).toBe(false);
    const baseSymlink = opts(base);
    Object.assign(baseSymlink.standardEvidence, { baseTracked: true, baseRegular: false });
    expect(validateStandardResponse(fields, baseSymlink).ok).toBe(false);
  });

  it('refuses amended content disguised as no-change', () => {
    const candidate = base.replace('Original meaning.', 'Changed constitutional meaning.');
    expect(validateStandardResponse(fields, opts(candidate)).ok).toBe(false);
  });

  it('refuses fresh-ID-on-existing-title disguised as created', () => {
    const legacy = `## Family\n\n### Existing Rule\n\n**Rule.** Original meaning.\n`;
    const created = { ...fields, 'standard-response-kind': 'created' };
    expect(validateStandardResponse(created, opts(base, legacy)).ok).toBe(false);
  });

  it('refuses replacing an existing ID under the same title as a legacy bootstrap', () => {
    const priorId = base.replace('existing-rule', 'prior-stable-id');
    expect(validateStandardResponse(fields, opts(base, priorId)).ok).toBe(false);
    expect(validateStandardResponse({ ...fields, 'standard-response-kind': 'amended' }, opts(base.replace('Original meaning.', 'Changed meaning.'), priorId)).ok).toBe(false);
  });

  it('refuses duplicate exact article titles as ambiguous', () => {
    const duplicateTitle = `${base}\n### Existing Rule\n\n**Article ID.** \`another-rule\`\n\n**Rule.** Other meaning.\n`;
    const result = validateStandardResponse(fields, opts(duplicateTitle));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/duplicate standards article title/);
  });

  it('ignores fenced/commented/quoted counterfeit articles', () => {
    const fake = `## Family\n\n\`\`\`md\n### Existing Rule\n**Article ID.** \`existing-rule\`\n**Rule.** fake\n\`\`\`\n> ### Existing Rule\n<!--\n### Existing Rule\n**Article ID.** \`existing-rule\`\n**Rule.** fake\n-->\n`;
    expect(validateStandardResponse(fields, opts(fake, '')).ok).toBe(false);
  });

  it('does not let a shorter fence expose a counterfeit standards article', () => {
    const candidate = `${base}\n\`\`\`\`md\nshort close follows\n\`\`\`\n### Existing Rule\n\n**Article ID.** \`another-rule\`\n\n**Rule.** counterfeit\n\`\`\`\`\n`;
    expect(validateStandardResponse(fields, opts(candidate)).ok).toBe(true);
  });
});
