// safe-git-allow: no git operations; isolated directory snapshots exercise the protected/candidate boundary.
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  describeProtectedExecutionAuthority,
  gradeFileReference,
  measureAnchoredEnforcement,
  resolveProtectedMeasurementSnapshot,
} from '../../scripts/lib/standards-enforcement-measurement.mjs';
import {
  __testing as executionVerifierTesting,
  isLiveAuthenticatedExecutionArtifact,
  verifyProtectedExecutionProof,
} from '../../scripts/lib/standards-enforcement-execution-verifier.mjs';

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
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  return Object.freeze(value);
};
const isDeepFrozen = (value: unknown, seen = new WeakSet<object>()): boolean => {
  if (value === null || typeof value !== 'object' || seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).every((key) =>
    isDeepFrozen((value as Record<PropertyKey, unknown>)[key], seen));
};
const readdressAndFreeze = <T extends { artifactSha256: string }>(artifact: T): T => {
  const { artifactSha256: _oldAddress, ...payload } = artifact;
  artifact.artifactSha256 = digest(canonical(payload));
  return deepFreeze(artifact);
};
const RUNNER_REF = 'scripts/lib/standards-enforcement-node-test-runner.mjs';
const TRUSTED_RUNNER_SHA256 = '04795f8857d8bb08ccf7c0a18103b7233ef644b395ac9bd576d9726e98da57f2';
const trustedRunnerContent = fs.readFileSync(path.resolve(RUNNER_REF), 'utf8');
if (digest(trustedRunnerContent) !== TRUSTED_RUNNER_SHA256) {
  throw new Error('trusted structured test runner digest does not match the independently reviewed bytes');
}
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
  protectedRoot: string,
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
  write(protectedRoot, RUNNER_REF, trustedRunnerContent);
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
      runnerSha256: TRUSTED_RUNNER_SHA256,
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

async function genuineObservedArtifact() {
  const base = makeRoot();
  const ref = 'tests/unit/w38-artifact.test.mjs';
  const subjectRef = 'src/w38-artifact-subject.mjs';
  const subjectContent = 'export const guarded = true;\n';
  const content = [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { guarded } from '../../src/w38-artifact-subject.mjs';",
    "test('observes subject', () => assert.equal(guarded, true));",
    '',
  ].join('\n');
  const protectedArticle = article('rule-w38', [ref]);
  const record = certifiedRecord(base, protectedArticle, ref, content, subjectRef, subjectContent);
  write(base, ref, content);
  write(base, subjectRef, subjectContent);

  const observed = await verifyProtectedExecutionProof({
    record,
    snapshot: resolveProtectedMeasurementSnapshot({ root: base, fixtureRoot: base }),
  });
  expect(observed.status).toBe('proven');
  expect(observed.artifact).not.toBeNull();
  return observed.artifact!;
}

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
      records: [certifiedRecord(base, protectedArticle, ref, content, subjectRef, subjectContent)],
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
      records: [certifiedRecord(base, protectedArticle, ref, content, subjectRef, subjectContent)],
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
      records: [certifiedRecord(base, protectedArticle, ref, content, subjectRef, subjectContent)],
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
    const record = certifiedRecord(base, protectedArticle, ref, content, subjectRef, subjectContent);
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
    const record = certifiedRecord(base, protectedArticle, ref, content, subjectRef, subjectContent);
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
    const record = certifiedRecord(base, protectedArticle, ref, content, subjectRef, subjectContent);
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
    const record = certifiedRecord(base, protectedArticle, ref, content, subjectRef, subjectContent);
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

  it('C2 refuses an exact-schema summary from a digest-mismatched runner before execution', async () => {
    const base = makeRoot();
    const ref = 'tests/unit/untrusted-runner-target.test.mjs';
    const subjectRef = 'src/untrusted-runner-subject.mjs';
    const markerRef = 'untrusted-runner-executed';
    const markerPath = path.join(base, markerRef);
    const subjectContent = 'export const guarded = true;\n';
    const content = [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { guarded } from '../../src/untrusted-runner-subject.mjs';",
      "test('observes subject', () => assert.equal(guarded, true));",
      '',
    ].join('\n');
    const protectedArticle = article('rule-a', [ref]);
    const record = certifiedRecord(base, protectedArticle, ref, content, subjectRef, subjectContent);
    write(base, ref, content);
    write(base, subjectRef, subjectContent);
    const forgedRunner = [
      "import fs from 'node:fs';",
      "const marker = process.env.W37_UNTRUSTED_RUNNER_MARKER;",
      "if (!marker) throw new Error('untrusted runner marker is required');",
      "fs.writeFileSync(marker, 'executed');",
      `process.send?.(${JSON.stringify({
        schema: 'standards-enforcement-node-test-events/v1',
        source: 'node:test TestsStream',
        observerRef: ref,
        testsRun: 999,
        passed: 999,
        failed: 0,
        assertionFailures: 0,
        decidingMessage: '',
      })});`,
      '',
    ].join('\n');
    write(base, RUNNER_REF, forgedRunner);
    const forgedRunnerSha256 = digest(forgedRunner);
    expect(forgedRunnerSha256).not.toBe(TRUSTED_RUNNER_SHA256);

    const previousMarker = process.env.W37_UNTRUSTED_RUNNER_MARKER;
    process.env.W37_UNTRUSTED_RUNNER_MARKER = markerPath;
    let observed;
    try {
      observed = await verifyProtectedExecutionProof({
        record,
        snapshot: resolveProtectedMeasurementSnapshot({ root: base, fixtureRoot: base }),
      });
    } finally {
      if (previousMarker === undefined) delete process.env.W37_UNTRUSTED_RUNNER_MARKER;
      else process.env.W37_UNTRUSTED_RUNNER_MARKER = previousMarker;
    }

    expect(observed).toEqual({
      status: 'unknown',
      reason: `protected structured test runner digest mismatch: expected=${TRUSTED_RUNNER_SHA256} actual=${forgedRunnerSha256}`,
      artifact: null,
    });
    expect(fs.existsSync(markerPath)).toBe(false);
    console.log(`W37_C2 expectedRunnerSha256=${TRUSTED_RUNNER_SHA256} actualRunnerSha256=${forgedRunnerSha256} runnerExecuted=false summarySchema=standards-enforcement-node-test-events/v1 outcome=UNKNOWN artifact=null deciding="protected structured test runner digest mismatch"`);
  });

  it('W38_C4 blocks mutation of copied observation fields before reusable validation', async () => {
    const artifact = await genuineObservedArtifact();
    const originalTestsRun = artifact.clean.testsRun;
    let mutationBlocked = false;
    try {
      artifact.clean.testsRun = 999;
    } catch (error) {
      mutationBlocked = error instanceof TypeError;
    }
    const liveAfterMutationAttempt = isLiveAuthenticatedExecutionArtifact(artifact);

    console.log(`W38_C4 mutationBlocked=${mutationBlocked} originalTestsRun=${originalTestsRun} currentTestsRun=${artifact.clean.testsRun} predicate=${liveAfterMutationAttempt}`);
    expect(mutationBlocked).toBe(true);
    expect(artifact.clean.testsRun).toBe(originalTestsRun);
    expect(isDeepFrozen(artifact)).toBe(true);
    expect(liveAfterMutationAttempt).toBe(true);
  });

  it('W38_C5 rejects every re-addressed copied-observation tamper', async () => {
    const artifact = await genuineObservedArtifact();
    expect(executionVerifierTesting.artifactContentIsInternallyConsistent(artifact)).toBe(true);

    const tamperCases: Array<[string, (copy: any) => void]> = [];
    for (const runName of ['clean', 'mutated', 'confirmation'] as const) {
      tamperCases.push(
        [`${runName}.testsRun`, (copy) => { copy[runName].testsRun += 1; }],
        [`${runName}.passed`, (copy) => { copy[runName].passed += 1; }],
        [`${runName}.failed`, (copy) => { copy[runName].failed += 1; }],
        [`${runName}.assertionFailures`, (copy) => { copy[runName].assertionFailures += 1; }],
        [`${runName}.decidingOutput`, (copy) => { copy[runName].decidingOutput = 'forged classification'; }],
      );
    }

    for (const [label, tamper] of tamperCases) {
      const copy = structuredClone(artifact);
      tamper(copy);
      readdressAndFreeze(copy);
      expect(
        executionVerifierTesting.artifactContentIsInternallyConsistent(copy),
        `${label} must remain linked to the signed observation even after re-addressing`,
      ).toBe(false);
      expect(isLiveAuthenticatedExecutionArtifact(copy)).toBe(false);
    }

    const wrongAddress = structuredClone(artifact);
    wrongAddress.artifactSha256 = '0'.repeat(64);
    deepFreeze(wrongAddress);
    expect(executionVerifierTesting.artifactContentIsInternallyConsistent(wrongAddress)).toBe(false);
    expect(isLiveAuthenticatedExecutionArtifact(wrongAddress)).toBe(false);
    console.log(`W38_C5 copiedObservationTampers=${tamperCases.length} readdressed=true allRejected=true wrongContentAddressRejected=true`);
  });

  it('W38_C6 labels fixtures as stand-ins and requires both canonical admissions', () => {
    const snapshot = (source: string, files: Record<string, string>) => ({
      source,
      readFile: (ref: string) => files[ref] ?? null,
    });
    const runnerRef = 'scripts/lib/standards-enforcement-node-test-runner.mjs';
    const ledgerRef = 'docs/standards-enforcement-verdicts.json';
    const runnerContent = 'protected runner bytes';
    const boundRecord = {
      articleId: 'rule-w38-authority',
      articleSha256: digest('fixture article'),
      ref: 'tests/unit/w38-authority.test.mjs',
      sha256: digest('fixture observer'),
      verdict: 'EFFECTIVE',
      proof: {
        schemaVersion: 2,
        execution: {
          runner: 'node-test-events-v1',
          runnerSha256: digest(runnerContent),
          argv: ['node', runnerRef, 'tests/unit/w38-authority.test.mjs'],
          workspaceRefs: ['src/w38-authority-subject.mjs', 'tests/unit/w38-authority.test.mjs'],
        },
        relevance: {
          articleId: 'rule-w38-authority',
          ruleSha256: digest('fixture rule'),
          observerRef: 'tests/unit/w38-authority.test.mjs',
          observerSha256: digest('fixture observer'),
          subjectRef: 'src/w38-authority-subject.mjs',
          subjectBeforeSha256: digest('before'),
        },
        mutation: {
          mutationId: 'violate-w38-authority',
          subjectRef: 'src/w38-authority-subject.mjs',
          search: 'true',
          replacement: 'false',
          subjectAfterSha256: digest('after'),
        },
      },
    };
    const boundLedger = JSON.stringify({
      schemaVersion: 3,
      records: [boundRecord],
    });
    const mismatchedLedger = JSON.stringify({
      schemaVersion: 3,
      records: [{
        ...boundRecord,
        proof: {
          ...boundRecord.proof,
          execution: { ...boundRecord.proof.execution, runnerSha256: digest('other runner') },
        },
      }],
    });

    const standIn = describeProtectedExecutionAuthority(snapshot('explicit-test-fixture', { [runnerRef]: runnerContent, [ledgerRef]: boundLedger }));
    const neither = describeProtectedExecutionAuthority(snapshot('canonical-server-content-addressed-merge-base', {}));
    const runnerOnly = describeProtectedExecutionAuthority(snapshot('canonical-server-content-addressed-merge-base', { [runnerRef]: runnerContent }));
    const ledgerOnly = describeProtectedExecutionAuthority(snapshot('canonical-server-content-addressed-merge-base', { [ledgerRef]: boundLedger }));
    const emptyLedger = describeProtectedExecutionAuthority(snapshot('canonical-server-content-addressed-merge-base', {
      [runnerRef]: runnerContent,
      [ledgerRef]: JSON.stringify({ schemaVersion: 3, records: [] }),
    }));
    const mismatched = describeProtectedExecutionAuthority(snapshot('canonical-server-content-addressed-merge-base', {
      [runnerRef]: runnerContent,
      [ledgerRef]: mismatchedLedger,
    }));
    const both = describeProtectedExecutionAuthority(snapshot('canonical-server-content-addressed-merge-base', { [runnerRef]: runnerContent, [ledgerRef]: boundLedger }));

    expect(standIn).toEqual(expect.objectContaining({ mode: 'test-stand-in', operationalOnCanonicalMain: false }));
    expect(standIn.statement).toContain('stand-in only');
    expect(neither).toEqual(expect.objectContaining({ mode: 'prospective', operationalOnCanonicalMain: false }));
    expect(neither.requiredCanonicalAdmissions[0]).toBe(runnerRef);
    expect(neither.requiredCanonicalAdmissions[1]).toContain(ledgerRef);
    expect(runnerOnly.requiredCanonicalAdmissions).toHaveLength(1);
    expect(runnerOnly.requiredCanonicalAdmissions[0]).toContain(ledgerRef);
    expect(ledgerOnly.requiredCanonicalAdmissions[0]).toBe(runnerRef);
    expect(ledgerOnly.requiredCanonicalAdmissions[1]).toContain(ledgerRef);
    expect(emptyLedger).toEqual(expect.objectContaining({ mode: 'prospective', runnerDigestBoundByVerdictLedger: false }));
    expect(emptyLedger.requiredCanonicalAdmissions[0]).toContain('schema-v3 record');
    expect(mismatched).toEqual(expect.objectContaining({ mode: 'prospective', runnerDigestBoundByVerdictLedger: false }));
    expect(both).toEqual(expect.objectContaining({ mode: 'operational', operationalOnCanonicalMain: true }));
    expect(both.runnerDigestBoundByVerdictLedger).toBe(true);
    expect(both.requiredCanonicalAdmissions).toEqual([]);
    console.log(`W38_C6 fixtureMode=${standIn.mode} canonicalNeither=${neither.mode} runnerOnly=${runnerOnly.mode} ledgerOnly=${ledgerOnly.mode} emptyLedger=${emptyLedger.mode} mismatchedDigest=${mismatched.mode} canonicalBoundRecord=${both.mode}`);
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
      records: [certifiedRecord(base, protectedArticle, ref, content, subjectRef, subjectContent)],
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
        runnerSha256: TRUSTED_RUNNER_SHA256,
        observationsReceiptBound: true,
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
    console.log(`W37_C1 protectedRunnerSha256=${TRUSTED_RUNNER_SHA256} digestCompared=true protectedRunnerMaterialized=true observationsReceiptBound=true verdict=ratchet`);
  });

  it('rejects a proof that mutates its observer instead of an independent rule subject', async () => {
    const base = makeRoot();
    const candidate = makeRoot();
    const ref = 'tests/unit/certified.test.ts';
    const content = "import { expect, it } from 'vitest'; it('observes', () => expect(subject).toBe(true));\n";
    const protectedArticle = article('rule-a', [ref]);
    const record = certifiedRecord(base, protectedArticle, ref, content, ref, content);
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
    const record = certifiedRecord(base, protectedArticle, ref, content, subjectRef, subjectContent);
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
      records: [certifiedRecord(base, protectedArticle, ref, content, subjectRef, subjectContent)],
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
      records: [certifiedRecord(base, protectedArticle, ref, content, subjectRef, subjectContent)],
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
