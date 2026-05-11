/**
 * Unit tests for StageTransitionValidator.
 *
 * Covers each edge in the Phase 1.2 transition table, plus the path-jail,
 * slug regex, and reconciler-bypass invariants.
 *
 * Helpers (`ghPrView`, `gitMergeBaseIsAncestor`) are mocked via the
 * `ValidationContext` interface — we never spawn `gh` or `git` from these
 * tests. The realpath checks DO touch the filesystem; we lay out a temp
 * repo in `os.tmpdir()` for each suite.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateStageTransition,
  jailPath,
  type ValidationContext,
} from '../../src/core/StageTransitionValidator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('StageTransitionValidator', () => {
  let tmpRepo: string;
  let goodSpecRel: string;
  let convergedSpecRel: string;
  let approvedSpecRel: string;

  beforeAll(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-validator-'));
    fs.mkdirSync(path.join(tmpRepo, 'docs/specs/reports'), { recursive: true });
    goodSpecRel = 'docs/specs/example-feature.md';
    convergedSpecRel = 'docs/specs/converged-feature.md';
    approvedSpecRel = 'docs/specs/approved-feature.md';

    fs.writeFileSync(
      path.join(tmpRepo, goodSpecRel),
      `---\ntitle: example\nslug: example-feature\n---\n\n# example body\n`
    );
    fs.writeFileSync(
      path.join(tmpRepo, convergedSpecRel),
      `---\ntitle: converged\nslug: converged-feature\nreview-convergence: true\n---\n\n# body\n`
    );
    fs.writeFileSync(
      path.join(tmpRepo, 'docs/specs/reports/converged-feature-convergence.md'),
      `# convergence report\n`
    );
    fs.writeFileSync(
      path.join(tmpRepo, approvedSpecRel),
      `---\ntitle: approved\nslug: approved-feature\nreview-convergence: true\napproved: true\napproved-by: Justin\napproved-date: 2026-05-11\n---\n\n# body\n`
    );
  });

  afterAll(() => {
    SafeFsExecutor.safeRmSync(tmpRepo, { recursive: true, force: true, operation: 'tests/unit/StageTransitionValidator.test.ts:afterAll-tmpRepo' });
  });

  // ── outline → spec-drafted ────────────────────────────────────────

  it('outline → spec-drafted: accepts when spec file exists and frontmatter parses', async () => {
    const r = await validateStageTransition('outline', 'spec-drafted', {
      targetRepoPath: tmpRepo,
      specPath: goodSpecRel,
    });
    expect(r.ok).toBe(true);
  });

  it('outline → spec-drafted: rejects when specPath missing', async () => {
    const r = await validateStageTransition('outline', 'spec-drafted', {
      targetRepoPath: tmpRepo,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SPEC_PATH_MISSING');
  });

  it('outline → spec-drafted: rejects when spec file does not exist', async () => {
    const r = await validateStageTransition('outline', 'spec-drafted', {
      targetRepoPath: tmpRepo,
      specPath: 'docs/specs/nonexistent.md',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SPEC_FILE_MISSING');
  });

  it('outline → spec-drafted: rejects path traversal in specPath', async () => {
    const r = await validateStageTransition('outline', 'spec-drafted', {
      targetRepoPath: tmpRepo,
      specPath: '../../etc/passwd',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SPEC_PATH_ESCAPE');
  });

  it('outline → spec-drafted: rejects non-markdown extensions', async () => {
    const txtPath = path.join(tmpRepo, 'docs/specs/spec.txt');
    fs.writeFileSync(txtPath, '---\ntitle: not md\n---\n');
    const r = await validateStageTransition('outline', 'spec-drafted', {
      targetRepoPath: tmpRepo,
      specPath: 'docs/specs/spec.txt',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SPEC_NOT_MARKDOWN');
  });

  // ── spec-drafted → spec-converged ────────────────────────────────

  it('spec-drafted → spec-converged: accepts when review-convergence:true + report exists', async () => {
    const r = await validateStageTransition('spec-drafted', 'spec-converged', {
      targetRepoPath: tmpRepo,
      specPath: convergedSpecRel,
    });
    expect(r.ok).toBe(true);
  });

  it('spec-drafted → spec-converged: rejects when review-convergence missing', async () => {
    const r = await validateStageTransition('spec-drafted', 'spec-converged', {
      targetRepoPath: tmpRepo,
      specPath: goodSpecRel,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('CONVERGENCE_TAG_MISSING');
  });

  it('spec-drafted → spec-converged: rejects invalid slug (traversal attempt)', async () => {
    // Spec with a slug attempting to escape into ../etc/passwd shape.
    const badSpec = 'docs/specs/bad-slug.md';
    fs.writeFileSync(
      path.join(tmpRepo, badSpec),
      `---\ntitle: bad\nslug: "../../../etc/passwd"\nreview-convergence: true\n---\n# body\n`
    );
    const r = await validateStageTransition('spec-drafted', 'spec-converged', {
      targetRepoPath: tmpRepo,
      specPath: badSpec,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SLUG_INVALID');
  });

  it('spec-drafted → spec-converged: rejects when convergence report missing', async () => {
    // Spec has slug pointing at a report file we haven't created.
    const orphanSpec = 'docs/specs/orphan-spec.md';
    fs.writeFileSync(
      path.join(tmpRepo, orphanSpec),
      `---\ntitle: orphan\nslug: orphan-spec\nreview-convergence: true\n---\n# body\n`
    );
    const r = await validateStageTransition('spec-drafted', 'spec-converged', {
      targetRepoPath: tmpRepo,
      specPath: orphanSpec,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('CONVERGENCE_REPORT_MISSING');
  });

  // ── spec-converged → approved ────────────────────────────────────

  it('spec-converged → approved: accepts with all three approved fields', async () => {
    const r = await validateStageTransition('spec-converged', 'approved', {
      targetRepoPath: tmpRepo,
      specPath: approvedSpecRel,
    });
    expect(r.ok).toBe(true);
  });

  it('spec-converged → approved: rejects when approved-by missing', async () => {
    const partialSpec = 'docs/specs/partial-approved.md';
    fs.writeFileSync(
      path.join(tmpRepo, partialSpec),
      `---\ntitle: partial\nslug: partial-approved\napproved: true\napproved-date: 2026-05-11\n---\n# body\n`
    );
    const r = await validateStageTransition('spec-converged', 'approved', {
      targetRepoPath: tmpRepo,
      specPath: partialSpec,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('APPROVED_BY_MISSING');
  });

  // ── approved → building ──────────────────────────────────────────

  it('approved → building: requires taskFlowRecordId', async () => {
    const ok = await validateStageTransition('approved', 'building', {
      targetRepoPath: tmpRepo,
      taskFlowRecordId: 'tf-123',
    });
    expect(ok.ok).toBe(true);

    const fail = await validateStageTransition('approved', 'building', {
      targetRepoPath: tmpRepo,
    });
    expect(fail.ok).toBe(false);
    if (!fail.ok) expect(fail.code).toBe('TASKFLOW_ID_MISSING');
  });

  // ── building → merged (squash-merge happy path) ──────────────────

  it('building → merged: accepts squash-merged PR via mocked ghPrView', async () => {
    const ctx: ValidationContext = {
      targetRepoPath: tmpRepo,
      prNumber: 42,
      ghPrView: async () => ({
        state: 'MERGED',
        // Squash merge: this is the SHA on main, NOT the PR head SHA.
        mergeCommit: { oid: 'a1b2c3d4e5f60708' },
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
      }),
      gitMergeBaseIsAncestor: (sha, branch) =>
        sha === 'a1b2c3d4e5f60708' && branch === 'origin/main',
    };
    const r = await validateStageTransition('building', 'merged', ctx);
    expect(r.ok).toBe(true);
  });

  it('building → merged: rejects when mergeCommit not reachable from origin/main', async () => {
    const ctx: ValidationContext = {
      targetRepoPath: tmpRepo,
      prNumber: 42,
      ghPrView: async () => ({
        state: 'MERGED',
        mergeCommit: { oid: 'aaaaaaa' },
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
      }),
      gitMergeBaseIsAncestor: () => false,
    };
    const r = await validateStageTransition('building', 'merged', ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('MERGE_COMMIT_UNREACHABLE');
  });

  it('building → merged: rejects when state is OPEN', async () => {
    const ctx: ValidationContext = {
      targetRepoPath: tmpRepo,
      prNumber: 42,
      ghPrView: async () => ({
        state: 'OPEN',
        mergeCommit: null,
        statusCheckRollup: [],
      }),
      gitMergeBaseIsAncestor: () => true,
    };
    const r = await validateStageTransition('building', 'merged', ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PR_NOT_MERGED');
  });

  it('building → merged: rejects when CI rollup has a failure', async () => {
    const ctx: ValidationContext = {
      targetRepoPath: tmpRepo,
      prNumber: 42,
      ghPrView: async () => ({
        state: 'MERGED',
        mergeCommit: { oid: 'a1b2c3d' },
        statusCheckRollup: [
          { conclusion: 'SUCCESS' },
          { conclusion: 'FAILURE' },
        ],
      }),
      gitMergeBaseIsAncestor: () => true,
    };
    const r = await validateStageTransition('building', 'merged', ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('CI_NOT_GREEN');
  });

  // ── *-> regressed (reconciler-only) ──────────────────────────────

  it('regressed: rejects user-initiated request', async () => {
    const r = await validateStageTransition('merged', 'regressed', {
      targetRepoPath: tmpRepo,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('REGRESSED_RECONCILER_ONLY');
  });

  it('regressed: accepts reconciler bypass', async () => {
    const r = await validateStageTransition('merged', 'regressed', {
      targetRepoPath: tmpRepo,
      bypassMode: 'reconciler',
    });
    expect(r.ok).toBe(true);
  });

  it('regressed: rejects bad from-stage even with reconciler bypass', async () => {
    const r = await validateStageTransition('outline', 'regressed', {
      targetRepoPath: tmpRepo,
      bypassMode: 'reconciler',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('REGRESSED_BAD_FROM');
  });

  // ── any → skipped ────────────────────────────────────────────────

  it('any → skipped: requires reason + by', async () => {
    const ok = await validateStageTransition('outline', 'skipped', {
      targetRepoPath: tmpRepo,
      skippedReason: 'duplicate of foo',
      skippedBy: 'echo',
    });
    expect(ok.ok).toBe(true);

    const missingBy = await validateStageTransition('outline', 'skipped', {
      targetRepoPath: tmpRepo,
      skippedReason: 'duplicate',
    });
    expect(missingBy.ok).toBe(false);
    if (!missingBy.ok) expect(missingBy.code).toBe('SKIPPED_BY_MISSING');
  });

  // ── skipped → outline ───────────────────────────────────────────

  it('skipped → outline: requires unskippedAt', async () => {
    const r = await validateStageTransition('skipped', 'outline', {
      targetRepoPath: tmpRepo,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('UNSKIPPED_AT_MISSING');

    const ok = await validateStageTransition('skipped', 'outline', {
      targetRepoPath: tmpRepo,
      unskippedAt: new Date().toISOString(),
    });
    expect(ok.ok).toBe(true);
  });
});

describe('jailPath helper', () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jail-test-'));
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/inside.md'), '');
  });

  afterAll(() => {
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/StageTransitionValidator.test.ts:afterAll-root' });
  });

  it('accepts a relative path that stays inside the root', () => {
    const r = jailPath(root, 'docs/inside.md');
    expect(r.ok).toBe(true);
  });

  it('rejects ../ traversal', () => {
    const r = jailPath(root, '../escape.md');
    expect(r.ok).toBe(false);
  });

  it('rejects absolute paths outside the root', () => {
    const r = jailPath(root, '/etc/passwd');
    expect(r.ok).toBe(false);
  });

  it('rejects when targetRepoPath is not absolute', () => {
    const r = jailPath('relative/root', 'foo');
    expect(r.ok).toBe(false);
  });

  it('rejects symlinks that escape root', () => {
    const symRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jail-sym-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jail-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.md'), 'sensitive');
    const linkPath = path.join(symRoot, 'sneaky.md');
    fs.symlinkSync(path.join(outside, 'secret.md'), linkPath);
    const r = jailPath(symRoot, 'sneaky.md');
    expect(r.ok).toBe(false);
    SafeFsExecutor.safeRmSync(symRoot, { recursive: true, force: true, operation: 'tests/unit/StageTransitionValidator.test.ts:symlinks-symRoot' });
    SafeFsExecutor.safeRmSync(outside, { recursive: true, force: true, operation: 'tests/unit/StageTransitionValidator.test.ts:symlinks-outside' });
  });
});
