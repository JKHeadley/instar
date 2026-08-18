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
import { verifyProtectedExecutionProof } from '../../scripts/lib/standards-enforcement-execution-verifier.mjs';

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
  mutationSearch = 'true',
  mutationReplacement = 'false',
) => {
  const subjectAfter = subjectContent.replace(mutationSearch, mutationReplacement);
  return ({
  articleId: protectedArticle.id,
  articleSha256: protectedArticle.articleSha256,
  ref,
  sha256: digest(observerContent),
  verdict,
  proof: {
    schemaVersion: 2,
    execution: {
      runner: 'node-test-events-v1',
      argv: ['node', 'scripts/lib/standards-enforcement-node-test-runner.mjs', ref],
      workspaceRefs: [...new Set([ref, subjectRef])].sort(),
    },
    relevance: {
      articleId: protectedArticle.id,
      ruleSha256: protectedArticle.ruleSha256,
      observerRef: ref,
      observerSha256: digest(observerContent),
      subjectRef,
      subjectBeforeSha256: digest(subjectContent),
    },
    mutation: {
      mutationId: 'violate-fixture-rule',
      subjectRef,
      search: mutationSearch,
      replacement: mutationReplacement,
      subjectAfterSha256: digest(subjectAfter),
    },
  },
  });
};

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

  it('C3a keeps a fully shaped expect-true record unverified after its subject mutation survives', async () => {
    const base = makeRoot();
    const candidate = makeRoot();
    const ref = 'tests/unit/vacuous.test.mjs';
    const subjectRef = 'src/vacuous-subject.mjs';
    const subjectContent = 'export const guarded = true;\n';
    const content = [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      'const expect = (actual) => ({ toBe: (expected) => assert.equal(actual, expected) });',
      "test('does not observe the rule', () => expect(true).toBe(true));",
      '',
    ].join('\n');
    const protectedArticle = article('rule-a', [ref]);
    write(base, ref, content);
    write(candidate, ref, content);
    write(base, subjectRef, subjectContent);
    write(candidate, subjectRef, subjectContent);
    write(base, 'docs/standards-enforcement-verdicts.json', `${JSON.stringify({
      schemaVersion: 3,
      records: [certifiedRecord(protectedArticle, ref, content, subjectRef, subjectContent)],
    })}\n`);
    expect(fs.readFileSync(path.join(candidate, ref), 'utf8')).toContain('expect(true).toBe(true)');
    const result = await measureAnchoredEnforcement({
      root: candidate,
      protectedArticles: [protectedArticle],
      candidateArticles: [protectedArticle],
      snapshot: resolveProtectedMeasurementSnapshot({ root: candidate, fixtureRoot: base }),
    });

    expect(result.articles[0].strength).toBe('documented-only');
    expect(result.articles[0].references[0]).toEqual(expect.objectContaining({
      proven: false,
      evidenceStatus: 'not-proven',
      reason: 'protected-execution-proof-not-proven:observer-survived-subject-mutation',
      execution: expect.objectContaining({
        cleanExitCode: 0,
        cleanTestsRun: 1,
        mutatedExitCode: 0,
        mutatedTestsRun: 1,
        mutationLanded: true,
      }),
    }));
    console.log('W35_C3A schemaValid=true observer="expect(true).toBe(true)" mutationLanded=true cleanExit=0 mutatedExit=0 property=NOT-PROVEN deciding="observer-survived-subject-mutation"');
  });

  it('C3b keeps a mutation-surviving subject observer unverified', async () => {
    const base = makeRoot();
    const candidate = makeRoot();
    const ref = 'tests/unit/insensitive.test.mjs';
    const subjectRef = 'src/insensitive-subject.mjs';
    const subjectContent = 'export const guarded = true;\n';
    const content = [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { guarded } from '../../src/insensitive-subject.mjs';",
      "test('imports but does not discriminate', () => assert.equal(typeof guarded, 'boolean'));",
      '',
    ].join('\n');
    const protectedArticle = article('rule-a', [ref]);
    for (const root of [base, candidate]) {
      write(root, ref, content);
      write(root, subjectRef, subjectContent);
    }
    write(base, 'docs/standards-enforcement-verdicts.json', `${JSON.stringify({
      schemaVersion: 3,
      records: [certifiedRecord(protectedArticle, ref, content, subjectRef, subjectContent)],
    })}\n`);

    const result = await measureAnchoredEnforcement({
      root: candidate,
      protectedArticles: [protectedArticle],
      candidateArticles: [protectedArticle],
      snapshot: resolveProtectedMeasurementSnapshot({ root: candidate, fixtureRoot: base }),
    });

    expect(result.articles[0].strength).toBe('documented-only');
    expect(result.articles[0].references[0]).toEqual(expect.objectContaining({
      proven: false,
      evidenceStatus: 'not-proven',
      reason: 'protected-execution-proof-not-proven:observer-survived-subject-mutation',
      execution: expect.objectContaining({ cleanExitCode: 0, mutatedExitCode: 0, mutationLanded: true }),
    }));
    console.log('W35_C3B schemaValid=true observer=imports-subject mutationLanded=true cleanExit=0 mutatedExit=0 property=NOT-PROVEN deciding="observer-survived-subject-mutation"');
  });

  it('C3c requires discrimination to reset so host-external observer state cannot fabricate proof', async () => {
    const base = makeRoot();
    const candidate = makeRoot();
    const externalStateRoot = makeRoot();
    const markerPath = path.join(externalStateRoot, 'observer-state');
    const ref = 'tests/unit/stateful-hollow.test.mjs';
    const subjectRef = 'src/stateful-hollow-subject.mjs';
    const subjectContent = 'export const guarded = true;\n';
    const content = [
      "import assert from 'node:assert/strict';",
      "import fs from 'node:fs';",
      "import test from 'node:test';",
      `const marker = ${JSON.stringify(markerPath)};`,
      'const first = !fs.existsSync(marker);',
      "if (first) fs.writeFileSync(marker, 'seen');",
      "test('stateful hollow', () => assert.equal(first, true));",
      '',
    ].join('\n');
    const protectedArticle = article('rule-a', [ref]);
    for (const root of [base, candidate]) {
      write(root, ref, content);
      write(root, subjectRef, subjectContent);
    }
    write(base, 'docs/standards-enforcement-verdicts.json', `${JSON.stringify({
      schemaVersion: 3,
      records: [certifiedRecord(protectedArticle, ref, content, subjectRef, subjectContent)],
    })}\n`);

    const result = await measureAnchoredEnforcement({
      root: candidate,
      protectedArticles: [protectedArticle],
      candidateArticles: [protectedArticle],
      snapshot: resolveProtectedMeasurementSnapshot({ root: candidate, fixtureRoot: base }),
    });

    expect(result.articles[0].references[0]).toEqual(expect.objectContaining({
      proven: false,
      evidenceStatus: 'not-proven',
      reason: 'protected-execution-proof-not-proven:observer-discrimination-did-not-reset-in-pristine-confirmation',
      execution: expect.objectContaining({
        cleanExitCode: 0,
        mutatedExitCode: 1,
        confirmationExitCode: 1,
        mutationLanded: true,
      }),
    }));
    console.log('W35_C3C hostExternalState=true observer=stateful-hollow mutationLanded=true cleanExit=0 mutatedExit=1 confirmationExit=1 property=NOT-PROVEN deciding="discrimination-did-not-reset"');
  });

  it('binds every declared workspace input to candidate continuity', async () => {
    const base = makeRoot();
    const candidate = makeRoot();
    const ref = 'tests/unit/helper-bound.test.mjs';
    const subjectRef = 'src/helper-bound-subject.mjs';
    const helperRef = 'src/helper-bound-input.mjs';
    const subjectContent = 'export const guarded = true;\n';
    const helperContent = 'export const helper = true;\n';
    const content = [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { guarded } from '../../src/helper-bound-subject.mjs';",
      "import { helper } from '../../src/helper-bound-input.mjs';",
      "test('observes all inputs', () => assert.equal(guarded && helper, true));",
      '',
    ].join('\n');
    const protectedArticle = article('rule-a', [ref]);
    const record = certifiedRecord(protectedArticle, ref, content, subjectRef, subjectContent);
    record.proof.execution.workspaceRefs = [helperRef, subjectRef, ref].sort();
    for (const root of [base, candidate]) {
      write(root, ref, content);
      write(root, subjectRef, subjectContent);
    }
    write(base, helperRef, helperContent);
    write(candidate, helperRef, 'export const helper = false;\n');
    write(base, 'docs/standards-enforcement-verdicts.json', `${JSON.stringify({
      schemaVersion: 3,
      records: [record],
    })}\n`);

    const result = await measureAnchoredEnforcement({
      root: candidate,
      protectedArticles: [protectedArticle],
      candidateArticles: [protectedArticle],
      snapshot: resolveProtectedMeasurementSnapshot({ root: candidate, fixtureRoot: base }),
    });

    expect(result.articles[0].references[0]).toEqual(expect.objectContaining({
      proven: false,
      evidenceStatus: 'not-proven',
      reason: `candidate-execution-workspace-input-changed:${helperRef}`,
    }));
  });

  it('labels a looked-at mutation digest mismatch NOT-PROVEN rather than UNKNOWN', async () => {
    const base = makeRoot();
    const candidate = makeRoot();
    const ref = 'tests/unit/mutation-digest.test.mjs';
    const subjectRef = 'src/mutation-digest-subject.mjs';
    const subjectContent = 'export const guarded = true;\n';
    const content = [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { guarded } from '../../src/mutation-digest-subject.mjs';",
      "test('observes subject', () => assert.equal(guarded, true));",
      '',
    ].join('\n');
    const protectedArticle = article('rule-a', [ref]);
    const record = certifiedRecord(protectedArticle, ref, content, subjectRef, subjectContent);
    record.proof.mutation.subjectAfterSha256 = digest('wrong but well-shaped after bytes');
    for (const root of [base, candidate]) {
      write(root, ref, content);
      write(root, subjectRef, subjectContent);
    }
    write(base, 'docs/standards-enforcement-verdicts.json', `${JSON.stringify({
      schemaVersion: 3,
      records: [record],
    })}\n`);

    const result = await measureAnchoredEnforcement({
      root: candidate,
      protectedArticles: [protectedArticle],
      candidateArticles: [protectedArticle],
      snapshot: resolveProtectedMeasurementSnapshot({ root: candidate, fixtureRoot: base }),
    });

    expect(result.articles[0].references[0]).toEqual(expect.objectContaining({
      proven: false,
      evidenceStatus: 'not-proven',
      reason: 'protected-execution-proof-not-proven:declared subject mutation after-digest does not match the landed bytes',
    }));
  });

  it('returns UNKNOWN when an executed observer exceeds the bounded runtime', async () => {
    const base = makeRoot();
    const ref = 'tests/unit/hanging.test.mjs';
    const subjectRef = 'src/hanging-subject.mjs';
    const subjectContent = 'export const guarded = true;\n';
    const content = [
      "import test from 'node:test';",
      "test('passes but leaves the process alive', () => {});",
      'setInterval(() => {}, 1_000);',
      '',
    ].join('\n');
    const protectedArticle = article('rule-a', [ref]);
    const record = certifiedRecord(protectedArticle, ref, content, subjectRef, subjectContent);
    write(base, ref, content);
    write(base, subjectRef, subjectContent);
    const snapshot = resolveProtectedMeasurementSnapshot({ root: base, fixtureRoot: base });

    const observed = await verifyProtectedExecutionProof({
      record,
      snapshot,
      observerTimeoutMs: 100,
    });

    expect(observed).toEqual({
      status: 'unknown',
      reason: 'clean observer execution timed out',
      artifact: null,
    });
  });

  it('C3d bounds timeout even when an observer descendant inherits the captured pipes', async () => {
    const base = makeRoot();
    const ref = 'tests/unit/descendant-holds-stdio.test.mjs';
    const subjectRef = 'src/descendant-holds-stdio-subject.mjs';
    const subjectContent = 'export const guarded = true;\n';
    const content = [
      "import { spawn } from 'node:child_process';",
      "import test from 'node:test';",
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
      "test('parent never settles', async () => new Promise(() => {}));",
      '',
    ].join('\n');
    const protectedArticle = article('rule-a', [ref]);
    const record = certifiedRecord(protectedArticle, ref, content, subjectRef, subjectContent);
    write(base, ref, content);
    write(base, subjectRef, subjectContent);
    const snapshot = resolveProtectedMeasurementSnapshot({ root: base, fixtureRoot: base });
    const startedAt = Date.now();

    const observed = await verifyProtectedExecutionProof({
      record,
      snapshot,
      observerTimeoutMs: 100,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(observed).toEqual({
      status: 'unknown',
      reason: 'clean observer execution timed out',
      artifact: null,
    });
    expect(elapsedMs).toBeLessThan(1_000);
    console.log(`W35_C3D descendantHoldsStdio=true timeoutMs=100 elapsedMs=${elapsedMs} property=UNKNOWN deciding="clean observer execution timed out"`);
  });

  it('caps candidate strength at the protected article/reference census', async () => {
    const base = makeRoot();
    const candidate = makeRoot();
    const protectedRef = 'scripts/lint-protected.mjs';
    const newRef = 'tests/unit/candidate-only.test.ts';
    write(base, protectedRef, "if (problems.length) { process.exitCode = 1; }\n");
    write(candidate, protectedRef, "if (problems.length) { process.exitCode = 1; }\n");
    write(candidate, newRef, "import { expect, it } from 'vitest'; it('x', () => expect(true).toBe(true));\n");
    const result = await measureAnchoredEnforcement({
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

  it('C1 promotes only real clean and mutated executions that discriminate', async () => {
    const base = makeRoot();
    const candidate = makeRoot();
    const ref = 'tests/unit/certified.test.mjs';
    const subjectRef = 'src/certified-subject.mjs';
    const subjectContent = 'export const guarded = true;\n';
    const protectedArticle = article('rule-a', [ref]);
    const content = [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { guarded } from '../../src/certified-subject.mjs';",
      "console.log('# tests 999\\n# pass 999\\n# fail 0\\nℹ tests 999');",
      "test('observes the protected subject', () => assert.equal(guarded, true));",
      '',
    ].join('\n');
    write(base, ref, content);
    write(candidate, ref, content);
    write(base, subjectRef, subjectContent);
    write(candidate, subjectRef, subjectContent);
    write(base, 'docs/standards-enforcement-verdicts.json', `${JSON.stringify({
      schemaVersion: 3,
      records: [certifiedRecord(protectedArticle, ref, content, subjectRef, subjectContent)],
    })}\n`);
    write(candidate, 'docs/standards-enforcement-verdicts.json', `${JSON.stringify({
      schemaVersion: 3,
      records: [],
    })}\n`);
    const result = await measureAnchoredEnforcement({
      root: candidate,
      protectedArticles: [protectedArticle],
      candidateArticles: [protectedArticle],
      snapshot: resolveProtectedMeasurementSnapshot({ root: candidate, fixtureRoot: base }),
    });

    expect(result.articles[0]).toEqual(expect.objectContaining({ strength: 'ratchet' }));
    expect(result.articles[0].references[0]).toEqual(expect.objectContaining({
      reason: 'protected-observed-effective-with-authenticated-fail-direction',
      evidenceStatus: 'proven',
      execution: expect.objectContaining({
        observationSource: 'node:test TestsStream',
        runnerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        cleanExitCode: 0,
        cleanTestsRun: 1,
        mutatedExitCode: 1,
        mutatedTestsRun: 1,
        confirmationExitCode: 0,
        confirmationTestsRun: 1,
        mutationLanded: true,
        decidingOutput: expect.stringContaining('ERR_ASSERTION'),
      }),
    }));
    expect(result.articles[0].references[0].execution?.decidingOutput).not.toContain('999');
    console.log('W36_C1 source="node:test TestsStream" misleadingRendererCounts=ignored mutationLanded=true cleanExit=0 cleanTests=1 mutatedExit=1 mutatedTests=1 confirmationExit=0 confirmationTests=1 failureKind=assertion artifact=authenticated verdict=ratchet');
  });

  it('rejects a proof that mutates its observer instead of an independent rule subject', async () => {
    const base = makeRoot();
    const candidate = makeRoot();
    const ref = 'tests/unit/certified.test.ts';
    const content = "import { expect, it } from 'vitest'; it('observes', () => expect(subject).toBe(true));\n";
    const protectedArticle = article('rule-a', [ref]);
    const record = certifiedRecord(protectedArticle, ref, content, ref, content);
    record.proof.execution.workspaceRefs = ['src/unused.ts', ref].sort();
    write(base, ref, content);
    write(candidate, ref, content);
    write(base, 'docs/standards-enforcement-verdicts.json', `${JSON.stringify({
      schemaVersion: 3,
      records: [record],
    })}\n`);
    const result = await measureAnchoredEnforcement({
      root: candidate,
      protectedArticles: [protectedArticle],
      candidateArticles: [protectedArticle],
      snapshot: resolveProtectedMeasurementSnapshot({ root: candidate, fixtureRoot: base }),
    });

    expect(result.status).toBe('not-proven');
    expect(result.articles[0].strength).toBe('documented-only');
    expect(result.errors.join('\n')).toContain('crosses the subject/observer boundary');
  });

  it('rejects candidate-authored execution outcomes in the protected plan', async () => {
    const base = makeRoot();
    const candidate = makeRoot();
    const ref = 'tests/unit/certified.test.ts';
    const subjectRef = 'src/certified-subject.ts';
    const content = "import { expect, it } from 'vitest'; it('observes', () => expect(subject).toBe(true));\n";
    const subjectContent = 'export const subject = true;\n';
    const protectedArticle = article('rule-a', [ref]);
    const record = certifiedRecord(protectedArticle, ref, content, subjectRef, subjectContent);
    (record.proof as typeof record.proof & { control: unknown }).control = {
      exitCode: 0,
      testsRun: 1,
      outputSha256: digest('candidate says this passed'),
    };
    write(base, ref, content);
    write(candidate, ref, content);
    write(base, subjectRef, subjectContent);
    write(candidate, subjectRef, subjectContent);
    write(base, 'docs/standards-enforcement-verdicts.json', `${JSON.stringify({
      schemaVersion: 3,
      records: [record],
    })}\n`);
    const result = await measureAnchoredEnforcement({
      root: candidate,
      protectedArticles: [protectedArticle],
      candidateArticles: [protectedArticle],
      snapshot: resolveProtectedMeasurementSnapshot({ root: candidate, fixtureRoot: base }),
    });

    expect(result.status).toBe('not-proven');
    expect(result.articles[0].strength).toBe('documented-only');
    expect(result.errors.join('\n')).toContain('proof envelope is malformed');
  });

  it('does not carry protected proof onto a changed candidate rule with the same identity and observer', async () => {
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
      schemaVersion: 3,
      records: [certifiedRecord(protectedArticle, ref, content, subjectRef, subjectContent)],
    })}\n`);
    const result = await measureAnchoredEnforcement({
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

  it('does not preserve a certified verdict after the candidate reference disappears', async () => {
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
      schemaVersion: 3,
      records: [certifiedRecord(protectedArticle, ref, content, subjectRef, subjectContent)],
    })}\n`);
    const result = await measureAnchoredEnforcement({
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

  it('records zero-of-zero as NOT-PROVEN rather than 100 percent', async () => {
    const base = makeRoot();
    const candidate = makeRoot();
    const result = await measureAnchoredEnforcement({
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
