import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveGoverningConstitution } from '../../src/core/standardsRegistryPath.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { StandardsConformanceReviewer, parseConformanceResponse } from '../../src/core/reviewers/standards-conformance.js';

describe('complete governing constitution', () => {
  it('loads both captured master documents with exact source identity and preserves their status', () => {
    const actual = resolveGoverningConstitution();
    expect(actual.usable).toBe(true);
    if (!actual.usable) return;
    expect(actual.markdown.indexOf('Make coherence something an AI cannot lose')).toBeLessThan(actual.markdown.indexOf('One Provider Is Enough'));
    expect(actual.markdown).toContain('draft, awaiting approval');
    expect(actual.source.repo).toBe('JKHeadley/instar-2');
    expect(actual.source.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(actual.identity).toMatch(/^[a-f0-9]{64}$/);
    expect(actual.documents).toHaveLength(2);
  });

  it('does not report a clean old-registry-only context when one master document is missing or changed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'governing-context-'));
    try {
      const source = path.join(process.cwd(), 'src/data/constitution');
      fs.cpSync(source, dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'rules.md'), '\nchanged obligation');
      expect(resolveGoverningConstitution(dir)).toMatchObject({ usable: false, reason: 'integrity-mismatch' });
      fs.writeFileSync(path.join(dir, 'rules.md'), fs.readFileSync(path.join(source, 'rules.md')));
      SafeFsExecutor.safeUnlinkSync(path.join(dir, 'purpose.md'), { operation: 'tests/unit/governing-constitution.test.ts:missing-source' });
      expect(resolveGoverningConstitution(dir)).toMatchObject({ usable: false, reason: 'missing-source' });
      for (const invalid of [null, [], 42, 'not a manifest']) {
        fs.writeFileSync(path.join(dir, 'sources.json'), JSON.stringify(invalid));
        expect(resolveGoverningConstitution(dir)).toMatchObject({ usable: false, reason: 'invalid-source' });
      }
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/governing-constitution.test.ts:cleanup' });
    }
  });

  it('reviews complete inputs beyond the former arbitrary slice and discloses transport overflow', async () => {
    let seen = ''; let calls = 0;
    const reviewer = new StandardsConformanceReviewer({ async evaluate(prompt) { calls++; seen = prompt; return '[]'; } });
    const review = await reviewer.review('# Change\n' + 'ordinary code '.repeat(2500) + '\nFINAL-SOURCE-MARKER', []);
    expect(review.degraded).toBe(false);
    expect(review.requestedModelTier).toBe('capable');
    expect(review.actualModel).toBeNull();
    expect(review).not.toHaveProperty('model');
    expect(seen).toContain('FINAL-SOURCE-MARKER');
    const oversized = await reviewer.review('x'.repeat(300_000), []);
    expect(oversized).toMatchObject({ degraded: true, degradeReason: 'input-too-large' });
    expect(calls).toBe(1);
  });

  it('preserves unresolved citations as signals and retains the Rule versus Value distinction', () => {
    const context = resolveGoverningConstitution();
    const findings = parseConformanceResponse(JSON.stringify([
      { standard: 'Rule 118', reason: 'fixture rule conflict' },
      { standard: 'Purpose: the mission is the relationship', reason: 'fixture value concern' },
      { standard: 'Purpose — sign-off is kept for a short, fixed list', reason: 'captured live response citation' },
      { standard: 'Rule 9999', reason: 'fixture unresolved claim' },
    ]), [], context)!;
    expect(findings[0]).toMatchObject({ citationResolved: true, declarationKind: 'Rule' });
    expect(findings[1]).toMatchObject({ citationResolved: true, declarationKind: 'Value' });
    expect(findings[2]).toMatchObject({ citationResolved: true, declarationKind: 'Rule' });
    expect(findings[3]).toMatchObject({ citationResolved: false, family: 'Unresolved citation' });
  });
});
