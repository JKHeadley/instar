// safe-git-allow: no git operations; isolated directory snapshots exercise the protected/candidate boundary.
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  gradeFileReference,
  measureAnchoredEnforcement,
  resolveProtectedMeasurementSnapshot,
} from '../../scripts/lib/standards-enforcement-measurement.mjs';

const roots: string[] = [];
const makeRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w34-measurement-'));
  roots.push(root);
  return root;
};
const write = (root: string, rel: string, content: string): void => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};
const article = (id: string, files: string[]) => ({
  id,
  family: 'Building',
  name: id,
  refs: { files, routes: [], markers: [] },
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('protected standards enforcement measurement', () => {
  it('does not mistake comments or prose for an executable ratchet', () => {
    expect(gradeFileReference(
      'tests/unit/hollow.test.ts',
      '// it("claims a test", () => expect(true).toBe(true))\n',
    )).toEqual(expect.objectContaining({
      proven: false,
      strength: 'documented-only',
      reason: 'reference-structurally-hollow',
    }));
  });

  it('caps candidate strength at the protected article/reference census', () => {
    const base = makeRoot();
    const candidate = makeRoot();
    const protectedRef = 'scripts/lint-protected.mjs';
    const newRef = 'tests/unit/candidate-only.test.ts';
    write(base, protectedRef, "if (problems.length) { process.exitCode = 1; }\n");
    write(candidate, protectedRef, "if (problems.length) { process.exitCode = 1; }\n");
    write(candidate, newRef, "import { expect, it } from 'vitest'; it('x', () => expect(true).toBe(true));\n");
    const result = measureAnchoredEnforcement({
      root: candidate,
      protectedArticles: [article('rule-a', [protectedRef])],
      candidateArticles: [article('rule-a', [newRef])],
      snapshot: resolveProtectedMeasurementSnapshot({ root: candidate, fixtureRoot: base }),
    });

    expect(result.articles[0].strength).toBe('documented-only');
    expect(result.unverifiedReferences).toContainEqual(expect.objectContaining({
      ref: newRef,
      reason: 'reference-not-in-protected-census',
    }));
  });

  it('uses a protected certified verdict and ignores a candidate-authored replacement ledger', () => {
    const base = makeRoot();
    const candidate = makeRoot();
    const ref = 'scripts/lint-certified.mjs';
    // The structural grader sees no executable enforcement here. The protected,
    // content-bound instrument verdict is deliberately the stronger oracle.
    const content = '// independently certified guard body\n';
    write(base, ref, content);
    write(candidate, ref, content);
    write(base, 'docs/standards-enforcement-verdicts.json', `${JSON.stringify({
      schemaVersion: 1,
      records: [{ ref, sha256: crypto.createHash('sha256').update(content).digest('hex'), verdict: 'EFFECTIVE' }],
    })}\n`);
    write(candidate, 'docs/standards-enforcement-verdicts.json', `${JSON.stringify({
      schemaVersion: 1,
      records: [{ ref, sha256: '0'.repeat(64), verdict: 'EXISTS' }],
    })}\n`);
    const result = measureAnchoredEnforcement({
      root: candidate,
      protectedArticles: [article('rule-a', [ref])],
      candidateArticles: [article('rule-a', [ref])],
      snapshot: resolveProtectedMeasurementSnapshot({ root: candidate, fixtureRoot: base }),
    });

    expect(result.articles[0]).toEqual(expect.objectContaining({ strength: 'ratchet' }));
    expect(result.articles[0].references[0]).toEqual(expect.objectContaining({
      reason: 'protected-certified-effective',
    }));
  });

  it('does not preserve a certified verdict after the candidate reference disappears', () => {
    const base = makeRoot();
    const candidate = makeRoot();
    const ref = 'scripts/lint-certified.mjs';
    const content = '// independently certified guard body\n';
    write(base, ref, content);
    write(base, 'docs/standards-enforcement-verdicts.json', `${JSON.stringify({
      schemaVersion: 1,
      records: [{ ref, sha256: crypto.createHash('sha256').update(content).digest('hex'), verdict: 'EFFECTIVE' }],
    })}\n`);
    const result = measureAnchoredEnforcement({
      root: candidate,
      protectedArticles: [article('rule-a', [ref])],
      candidateArticles: [article('rule-a', [ref])],
      snapshot: resolveProtectedMeasurementSnapshot({ root: candidate, fixtureRoot: base }),
    });

    expect(result.articles[0].strength).toBe('documented-only');
    expect(result.articles[0].references[0]).toEqual(expect.objectContaining({
      proven: false,
      reason: 'candidate-reference-unreadable',
    }));
  });

  it('records zero-of-zero as NOT-PROVEN rather than 100 percent', () => {
    const base = makeRoot();
    const candidate = makeRoot();
    const result = measureAnchoredEnforcement({
      root: candidate,
      protectedArticles: [],
      candidateArticles: [],
      snapshot: resolveProtectedMeasurementSnapshot({ root: candidate, fixtureRoot: base }),
    });

    expect(result.status).toBe('not-proven');
    expect(result.population).toEqual(expect.objectContaining({ protectedBase: 0, candidate: 0, continuity: 0 }));
    expect(result.errors.join('\n')).toContain('protected rule population is empty or unreadable');
    expect(result.errors.join('\n')).toContain('candidate rule population is empty or unreadable');
  });
});
