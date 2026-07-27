/**
 * The merged record must carry its own evidence, and the checker that reads that
 * evidence must be able to say "I could not check".
 *
 * THE DEFECT (found 2026-07-26 auditing my own project tracker). Both Tier-1
 * items of the `convergence-towards-coherence` project read
 * `pipelineStage: "merged"` and carried NO artifact fields at all — no prNumber,
 * no mergeCommitOid, no ciCheckedAt. `/projects/:id/advance` built a validation
 * context from the submitted artifact, proved four things about it (PR MERGED, a
 * format-valid merge sha, that sha reachable from canonical main, CI rollup
 * green), and then wrote ONLY `pipelineStage`. Strictness at the gate, amnesia in
 * the record. The root cause was a TYPE: `StageTransitionResult`'s success case
 * was `{ ok: true }`, one bit, while every refusal carried `reason` + `code` — so
 * the validator explained itself when it said no and said nothing when it said
 * yes, and the caller had nothing to persist.
 *
 * WHY IT MATTERED BEYOND TIDINESS. Two merged-state reconcilers select on
 * `mergeCommitOid`:
 *   - `GET /projects/:id`'s lazy reconciler (documented "may mutate"), and
 *   - `verifyMergedItemsViaGit`, which skips any child without one.
 * Nothing ever wrote the field, so the candidate set was ALWAYS empty. A
 * regression detector that scans nothing and reports nothing is indistinguishable
 * from one that finds no regressions — merged work reverted or force-pushed off
 * main would never have been noticed, and the silence read as health.
 *
 * WHY THE FIX HAD TO INCLUDE THE CONSUMER. Because the consumer had never run,
 * three defects sat in it unexercised — all three ALREADY FIXED in the advance
 * path a few hundred lines away:
 *   1. `SafeGitExecutor.run` without `sourceTreeReadOk`, so SourceTreeGuard
 *      refuses the read against an instar source tree (the #1641 defect);
 *   2. a hardcoded `origin/main`, which on a dev-agent home is the agent's FORK,
 *      where the merge commit is legitimately absent;
 *   3. `catch {}` → not verified → the caller marked the item `regressed`, i.e.
 *      "I could not check" rendered as "it was reverted".
 * Writing the evidence is what ARMS that path, so writing it alone would have
 * converted silent blindness into confident false regressions. This is the THIRD
 * recorded instance of defect class 3 (2026-05-29 failure-learning, 2026-07-25
 * projects/advance); each prior ratchet was scoped to its own subsystem.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { verifyMergedItemsViaGit } from '../../src/core/ProjectRoundExecution.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';

const REPO_ROOT = path.resolve(__dirname, '../..');
const ROUTES = path.join(REPO_ROOT, 'src/server/routes.ts');
const EXECUTION = path.join(REPO_ROOT, 'src/core/ProjectRoundExecution.ts');

/** Extract each `SafeGitExecutor.readSync(...)` call's inner text, paren-balanced. */
function readSyncCalls(file: string): string[] {
  const src = fs.readFileSync(file, 'utf-8');
  const needle = 'SafeGitExecutor.readSync(';
  const out: string[] = [];
  let i = 0;
  while ((i = src.indexOf(needle, i)) !== -1) {
    const start = i + needle.length;
    let depth = 1;
    let j = start;
    while (j < src.length && depth > 0) {
      const c = src[j];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      j++;
    }
    out.push(src.slice(start, j - 1));
    i = j;
  }
  return out;
}

/** Strip comments so a text assertion cannot be satisfied (or fooled) by prose. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('verifyMergedItemsViaGit: three states, and "could not check" is one of them', () => {
  let stateDir: string;
  let tracker: InitiativeTracker;

  beforeEach(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merged-evidence-'));
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    tracker = new InitiativeTracker(stateDir);
    const child = (id: string) => ({
      id,
      title: `child ${id}`,
      description: 'fixture child for merged-evidence verification',
      phases: [{ id: 'build', name: 'Build' }],
    });
    await tracker.create(child('has-oid'));
    await tracker.update('has-oid', { mergeCommitOid: 'a1b2c3d4e5f6' });
    await tracker.create(child('no-oid'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(stateDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/merged-record-carries-its-evidence.test.ts',
    });
  });

  it('git exit 0 → verified', async () => {
    vi.spyOn(SafeGitExecutor, 'readSync').mockReturnValue('');
    const r = await verifyMergedItemsViaGit('/tmp/repo', ['has-oid'], tracker);
    expect([...r.verified]).toEqual(['has-oid']);
    expect(r.regressed.size).toBe(0);
    expect(r.unverifiable.size).toBe(0);
  });

  it('git exit status 1 → regressed (the ONLY genuine negative)', async () => {
    vi.spyOn(SafeGitExecutor, 'readSync').mockImplementation(() => {
      const e = new Error('not an ancestor') as Error & { status?: number };
      e.status = 1;
      throw e;
    });
    const r = await verifyMergedItemsViaGit('/tmp/repo', ['has-oid'], tracker);
    expect([...r.regressed]).toEqual(['has-oid']);
    expect(r.verified.size).toBe(0);
    expect(r.unverifiable.size).toBe(0);
  });

  it('any OTHER failure → unverifiable, never regressed', async () => {
    // status 128 = bad revision (e.g. the wrong canonical-main ref); a
    // SourceTreeGuardError carries no status at all. Both are the same class:
    // the question was not answered. Collapsing them into `regressed` is how a
    // refusal becomes a fabricated factual claim.
    for (const status of [128, undefined]) {
      vi.restoreAllMocks();
      vi.spyOn(SafeGitExecutor, 'readSync').mockImplementation(() => {
        const e = new Error('could not resolve ref') as Error & { status?: number };
        if (status !== undefined) e.status = status;
        throw e;
      });
      const r = await verifyMergedItemsViaGit('/tmp/repo', ['has-oid'], tracker);
      expect(r.regressed.size, `status ${String(status)} must not demote an item`).toBe(0);
      expect(r.verified.size).toBe(0);
      expect(r.unverifiable.has('has-oid')).toBe(true);
    }
  });

  it('a child with NO recorded evidence is unverifiable, not regressed', async () => {
    vi.spyOn(SafeGitExecutor, 'readSync').mockReturnValue('');
    const r = await verifyMergedItemsViaGit('/tmp/repo', ['no-oid'], tracker);
    expect(r.regressed.size).toBe(0);
    expect(r.verified.size).toBe(0);
    expect(r.unverifiable.get('no-oid')).toMatch(/no mergeCommitOid/i);
  });

  it('checks the canonical-main ref it is GIVEN, not a hardcoded origin/main', async () => {
    const seen: string[][] = [];
    vi.spyOn(SafeGitExecutor, 'readSync').mockImplementation(((args: readonly string[]) => {
      seen.push([...args]);
      return '';
    }) as typeof SafeGitExecutor.readSync);
    await verifyMergedItemsViaGit('/tmp/repo', ['has-oid'], tracker, 'upstream/main');
    expect(seen.length).toBe(1);
    expect(seen[0]).toEqual(['merge-base', '--is-ancestor', 'a1b2c3d4e5f6', 'upstream/main']);
  });

  it('declares itself a source-tree READ (without it the guard refuses every call)', () => {
    const calls = readSyncCalls(EXECUTION).filter(c =>
      /operation\s*:\s*['"]ProjectRoundExecution\.verifyMergedItemsViaGit['"]/.test(c),
    );
    expect(calls.length, 'the verifier readSync must exist').toBe(1);
    expect(
      /\bsourceTreeReadOk\s*:\s*true\b/.test(calls[0]),
      'a project targetRepoPath IS an instar source tree on every dogfooding agent',
    ).toBe(true);
    // And the ref must come from the parameter, not be baked into the call.
    expect(
      /['"]origin\/main['"]/.test(calls[0]),
      'the canonical-main ref must be the caller-supplied parameter, not a literal',
    ).toBe(false);
  });
});

describe('the advance route records the evidence it validated', () => {
  const src = () => fs.readFileSync(ROUTES, 'utf-8');

  /** Body of the single `initiativeTracker.update(itemId, {...})` in /advance. */
  function advanceUpdateBody(): string {
    const s = src();
    const idx = s.indexOf('ctx.initiativeTracker.update(itemId, {');
    expect(idx, 'the /advance item update must exist').toBeGreaterThan(0);
    const braceStart = s.indexOf('{', idx + 'ctx.initiativeTracker.update(itemId,'.length - 1);
    let depth = 1;
    let k = braceStart + 1;
    while (k < s.length && depth > 0) {
      const c = s[k];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      k++;
    }
    return stripComments(s.slice(braceStart, k));
  }

  it('persists prNumber, mergeCommitOid and ciCheckedAt in the SAME write as the stage', () => {
    const body = advanceUpdateBody();
    expect(body).toContain('pipelineStage');
    // One write, not a follow-up: a second update could fail and leave a
    // `merged` row with no evidence — the exact state being fixed.
    for (const field of ['prNumber', 'mergeCommitOid', 'ciCheckedAt']) {
      expect(
        new RegExp(`\\b${field}\\b`).test(body),
        `${field} must be persisted alongside the stage, not discarded after validation`,
      ).toBe(true);
    }
    expect(
      /\bresult\.evidence\b/.test(body),
      'the persisted values must come from the validator verdict, not be re-derived by the caller',
    ).toBe(true);
  });
});

describe('the lazy merged-state reconciler does not invent a verdict', () => {
  const src = () => stripComments(fs.readFileSync(ROUTES, 'utf-8'));

  it('demotes to regressed ONLY on membership of the regressed set', () => {
    const s = src();
    const idx = s.indexOf('verifyMergedItemsViaGit(');
    expect(idx, 'the reconciler callsite must exist').toBeGreaterThan(0);
    const window = s.slice(idx, idx + 2600);
    // The old shape: anything not in `verified` became `regressed`.
    expect(
      /\bregressedIds\.has\(/.test(window) || /\bisRegressed\b/.test(window),
      'an item is demoted only when git said exit 1, never merely because it was absent from `verified`',
    ).toBe(true);
    // An unverifiable candidate must keep its stage — the update in that branch
    // may touch ciCheckedAt (backoff) but must not set pipelineStage.
    const guardIdx = window.indexOf('!isMerged && !isRegressed');
    expect(guardIdx, 'the unverifiable branch must exist').toBeGreaterThan(0);
    // Bound the branch at its own `continue`. A fixed character window ran past
    // the closing brace into the verdict-recording block below and matched THAT
    // block's `pipelineStage` — an assertion measuring the wrong text, which is
    // the same mistake this test file exists to punish. Caught by running it.
    const contIdx = window.indexOf('continue;', guardIdx);
    expect(contIdx, 'the unverifiable branch must end in `continue`').toBeGreaterThan(guardIdx);
    const branch = window.slice(guardIdx, contIdx);
    expect(
      /pipelineStage/.test(branch),
      'the unverifiable branch must not change pipelineStage — it has no verdict to record',
    ).toBe(false);
  });

  it('passes a resolved canonical-main ref instead of relying on the origin/main default', () => {
    const s = src();
    const idx = s.indexOf('verifyMergedItemsViaGit(');
    const call = s.slice(idx, s.indexOf(')', s.indexOf('resolveCanonicalMainRef', idx)) + 1);
    expect(
      /resolveCanonicalMainRef\(/.test(call),
      'on a fork-origin agent home origin/main does not contain the merge commit, so every healthy item would read as regressed',
    ).toBe(true);
  });
});
