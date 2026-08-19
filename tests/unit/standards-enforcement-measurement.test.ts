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
const digest = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
const article = (id: string, files: string[]) => {
  const rule = `fixture rule ${id}`;
  return {
    id,
    family: 'Building',
    name: id,
    ruleSha256: digest(`standards-rule-v1\0${rule}`),
    articleSha256: digest(`fixture-article\0${id}\0${files.join('\0')}`),
    refs: { files, routes: [], markers: [] },
  };
};
const certifiedRecord = (
  protectedArticle: ReturnType<typeof article>,
  ref: string,
  observerContent: string,
  subjectRef: string,
  subjectContent: string,
  verdict: 'EFFECTIVE' | 'WIRED' | 'EXISTS' = 'EFFECTIVE',
) => ({
  articleId: protectedArticle.id,
  articleSha256: protectedArticle.articleSha256,
  ref,
  sha256: digest(observerContent),
  verdict,
  proof: {
    schemaVersion: 1,
    observerCommandSha256: digest('npx vitest run tests/unit/certified.test.ts'),
    relevance: {
      articleId: protectedArticle.id,
      ruleSha256: protectedArticle.ruleSha256,
      observerRef: ref,
      observerSha256: digest(observerContent),
      subjectRef,
      subjectBeforeSha256: digest(subjectContent),
    },
    control: {
      exitCode: 0,
      testsRun: 3,
      outputSha256: digest('3 tests passed'),
    },
    violation: {
      mutationId: 'violate-fixture-rule',
      subjectAfterSha256: digest(`${subjectContent}\n// violated`),
      landed: true,
      exitCode: 1,
      testsRun: 3,
      failureKind: 'assertion',
      outputSha256: digest('1 assertion failed; 2 tests passed'),
      decidingOutput: 'expected guarded result, received violated result',
    },
  },
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

  it('C3d refuses proven strength to an already-censused executable but vacuous assertion', () => {
    const base = makeRoot();
    const candidate = makeRoot();
    const ref = 'tests/unit/vacuous.test.ts';
    const content = "import { expect, it } from 'vitest';\nit('does not observe the rule', () => expect(true).toBe(true));\n";
    write(base, ref, content);
    write(candidate, ref, content);
    expect(fs.readFileSync(path.join(candidate, ref), 'utf8')).toContain('expect(true).toBe(true)');
    const result = measureAnchoredEnforcement({
      root: candidate,
      protectedArticles: [article('rule-a', [ref])],
      candidateArticles: [article('rule-a', [ref])],
      snapshot: resolveProtectedMeasurementSnapshot({ root: candidate, fixtureRoot: base }),
    });

    expect(result.articles[0].strength).toBe('documented-only');
    expect(result.unverifiedReferences).toContainEqual(expect.objectContaining({
      articleId: 'rule-a',
      ref,
      reason: 'protected-relevance-proof-missing',
    }));
    console.log('W34_C3D landed=already-censused-expect-true strength=documented-only deciding="protected-relevance-proof-missing"');
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
    const subjectRef = 'src/certified-subject.ts';
    const subjectContent = 'export const guarded = true;\n';
    const protectedArticle = article('rule-a', [ref]);
    // The structural grader sees no executable enforcement here. The protected,
    // content-bound instrument verdict is deliberately the stronger oracle.
    const content = '// independently certified guard body\n';
    write(base, ref, content);
    write(candidate, ref, content);
    write(base, subjectRef, subjectContent);
    write(candidate, subjectRef, subjectContent);
    write(base, 'docs/standards-enforcement-verdicts.json', `${JSON.stringify({
      schemaVersion: 2,
      records: [certifiedRecord(protectedArticle, ref, content, subjectRef, subjectContent)],
    })}\n`);
    write(candidate, 'docs/standards-enforcement-verdicts.json', `${JSON.stringify({
      schemaVersion: 2,
      records: [],
    })}\n`);
    const result = measureAnchoredEnforcement({
      root: candidate,
      protectedArticles: [protectedArticle],
      candidateArticles: [protectedArticle],
      snapshot: resolveProtectedMeasurementSnapshot({ root: candidate, fixtureRoot: base }),
    });

    expect(result.articles[0]).toEqual(expect.objectContaining({ strength: 'ratchet' }));
    expect(result.articles[0].references[0]).toEqual(expect.objectContaining({
      reason: 'protected-certified-effective-with-relevance-and-fail-direction',
    }));
  });

  it('rejects a proof that mutates its observer instead of an independent rule subject', () => {
    const base = makeRoot();
    const candidate = makeRoot();
    const ref = 'tests/unit/certified.test.ts';
    const content = "import { expect, it } from 'vitest'; it('observes', () => expect(subject).toBe(true));\n";
    const protectedArticle = article('rule-a', [ref]);
    const record = certifiedRecord(protectedArticle, ref, content, ref, content);
    write(base, ref, content);
    write(candidate, ref, content);
    write(base, 'docs/standards-enforcement-verdicts.json', `${JSON.stringify({
      schemaVersion: 2,
      records: [record],
    })}\n`);
    const result = measureAnchoredEnforcement({
      root: candidate,
      protectedArticles: [protectedArticle],
      candidateArticles: [protectedArticle],
      snapshot: resolveProtectedMeasurementSnapshot({ root: candidate, fixtureRoot: base }),
    });

    expect(result.status).toBe('not-proven');
    expect(result.articles[0].strength).toBe('documented-only');
    expect(result.errors.join('\n')).toContain('crosses the subject/observer boundary');
  });

  it('rejects compile-only red evidence in place of an executed assertion failure', () => {
    const base = makeRoot();
    const candidate = makeRoot();
    const ref = 'tests/unit/certified.test.ts';
    const subjectRef = 'src/certified-subject.ts';
    const content = "import { expect, it } from 'vitest'; it('observes', () => expect(subject).toBe(true));\n";
    const subjectContent = 'export const subject = true;\n';
    const protectedArticle = article('rule-a', [ref]);
    const record = certifiedRecord(protectedArticle, ref, content, subjectRef, subjectContent);
    record.proof.violation.failureKind = 'compile';
    record.proof.violation.testsRun = 0;
    write(base, ref, content);
    write(candidate, ref, content);
    write(base, subjectRef, subjectContent);
    write(candidate, subjectRef, subjectContent);
    write(base, 'docs/standards-enforcement-verdicts.json', `${JSON.stringify({
      schemaVersion: 2,
      records: [record],
    })}\n`);
    const result = measureAnchoredEnforcement({
      root: candidate,
      protectedArticles: [protectedArticle],
      candidateArticles: [protectedArticle],
      snapshot: resolveProtectedMeasurementSnapshot({ root: candidate, fixtureRoot: base }),
    });

    expect(result.status).toBe('not-proven');
    expect(result.articles[0].strength).toBe('documented-only');
    expect(result.errors.join('\n')).toContain('did not execute the same tests to an assertion failure');
  });

  it('does not carry protected proof onto a changed candidate rule with the same identity and observer', () => {
    const base = makeRoot();
    const candidate = makeRoot();
    const ref = 'tests/unit/certified.test.ts';
    const subjectRef = 'src/certified-subject.ts';
    const content = "import { expect, it } from 'vitest'; it('observes', () => expect(subject).toBe(true));\n";
    const subjectContent = 'export const subject = true;\n';
    const protectedArticle = article('rule-a', [ref]);
    const changedCandidateArticle = {
      ...protectedArticle,
      ruleSha256: digest('a different candidate rule'),
      articleSha256: digest('the candidate article containing that different rule'),
    };
    write(base, ref, content);
    write(candidate, ref, content);
    write(base, subjectRef, subjectContent);
    write(candidate, subjectRef, subjectContent);
    write(base, 'docs/standards-enforcement-verdicts.json', `${JSON.stringify({
      schemaVersion: 2,
      records: [certifiedRecord(protectedArticle, ref, content, subjectRef, subjectContent)],
    })}\n`);
    const result = measureAnchoredEnforcement({
      root: candidate,
      protectedArticles: [protectedArticle],
      candidateArticles: [changedCandidateArticle],
      snapshot: resolveProtectedMeasurementSnapshot({ root: candidate, fixtureRoot: base }),
    });

    expect(result.articles[0].strength).toBe('documented-only');
    expect(result.unverifiedReferences).toContainEqual(expect.objectContaining({
      articleId: 'rule-a',
      ref,
      reason: 'candidate-cited-rule-changed',
    }));
  });

  it('does not preserve a certified verdict after the candidate reference disappears', () => {
    const base = makeRoot();
    const candidate = makeRoot();
    const ref = 'scripts/lint-certified.mjs';
    const subjectRef = 'src/certified-subject.ts';
    const subjectContent = 'export const guarded = true;\n';
    const protectedArticle = article('rule-a', [ref]);
    const content = '// independently certified guard body\n';
    write(base, ref, content);
    write(base, subjectRef, subjectContent);
    write(base, 'docs/standards-enforcement-verdicts.json', `${JSON.stringify({
      schemaVersion: 2,
      records: [certifiedRecord(protectedArticle, ref, content, subjectRef, subjectContent)],
    })}\n`);
    const result = measureAnchoredEnforcement({
      root: candidate,
      protectedArticles: [protectedArticle],
      candidateArticles: [protectedArticle],
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
