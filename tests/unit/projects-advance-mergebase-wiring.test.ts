/**
 * Wiring: the projects `/advance` merge-base check must (a) declare itself a
 * source-tree READ and (b) never translate a refusal into a factual negative.
 *
 * The live defect (2026-07-25, recording PR #1641 as merged): the route's
 * `gitMergeBaseIsAncestor` called `SafeGitExecutor.readSync` WITHOUT
 * `sourceTreeReadOk: true`. A project's `targetRepoPath` IS an instar source tree
 * on a dogfooding agent, so SourceTreeGuard refused the query every time — and the
 * helper's bare `catch { return false }` converted that refusal into "the merge
 * commit is not reachable from main". A merge that was demonstrably an ancestor
 * reported as unreachable, and the step had never once succeeded on this machine.
 *
 * Reproduced before fixing (server PATH, real worktree, real merge SHA):
 *   without the flag → SourceTreeGuardError (status undefined) → old code: false
 *   with the flag    → returns, ancestor TRUE
 *   real non-ancestor commit → status 1  (the ONLY genuine negative)
 *   nonexistent SHA          → status 128 (unverifiable, NOT a negative)
 *
 * `merge-base` is already in SOURCE_TREE_READ_TIER_VERBS — the permission for this
 * exact read existed and was simply never requested.
 *
 * Approach: static introspection, mirroring
 * `failure-learning-source-tree-readok-wiring.test.ts` (the FIRST instance of this
 * bug class, 2026-05-29, whose ratchet was scoped to that subsystem only). A mock
 * cannot catch this: mocking SafeGitExecutor is precisely how the existing
 * `/advance` tests masked the gap for as long as it existed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');
const ROUTES = path.join(REPO_ROOT, 'src/server/routes.ts');
const VALIDATOR = path.join(REPO_ROOT, 'src/core/StageTransitionValidator.ts');

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

describe('projects /advance merge-base check: source-tree wiring + honest refusal', () => {
  it('the mergeBaseIsAncestor readSync declares sourceTreeReadOk: true', () => {
    const calls = readSyncCalls(ROUTES).filter(c =>
      /operation\s*:\s*['"]projects\.advance\.mergeBaseIsAncestor['"]/.test(c),
    );
    expect(calls.length, 'expected the projects.advance.mergeBaseIsAncestor readSync to exist').toBe(1);
    expect(
      /\bsourceTreeReadOk\s*:\s*true\b/.test(calls[0]),
      'without sourceTreeReadOk, SourceTreeGuard refuses this read on any agent whose target repo is the instar source tree — which is every dogfooding agent',
    ).toBe(true);
  });

  it('the helper distinguishes git exit status 1 from every other failure', () => {
    // The load-bearing half. Fixing only the permission would make THIS case work
    // while leaving the mistranslation in place for the next one.
    const src = fs.readFileSync(ROUTES, 'utf-8');
    // Bound the helper body exactly — a generous character window around the
    // callsite swept in neighbouring functions and made this assertion meaningless
    // (it matched an unrelated `catch { return false }` next door). Brace-balance
    // from the helper's own arrow-function opening instead.
    const declIdx = src.indexOf('gitMergeBaseIsAncestor: (sha');
    expect(declIdx, 'helper declaration present').toBeGreaterThan(0);
    const braceStart = src.indexOf('{', declIdx);
    let depth = 1;
    let k = braceStart + 1;
    while (k < src.length && depth > 0) {
      const c = src[k];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      k++;
    }
    const body = src.slice(braceStart, k);
    expect(body).toContain('projects.advance.mergeBaseIsAncestor');
    // Strip comments before the negative assertion below. Without this the check
    // matched the helper's OWN comment, which quotes the forbidden
    // `catch { return false }` shape while explaining why it was removed — a
    // text-matching check fooled by prose describing the thing it forbids. Found
    // while writing this test, which is the cheapest possible place to find it.
    const code = body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(
      /status\s*===\s*1/.test(code),
      'only git exit status 1 means "not an ancestor"; the helper must test for it explicitly',
    ).toBe(true);
    expect(
      /\bthrow\b/.test(code),
      'a failure that is NOT status 1 must be rethrown as unverifiable, never returned as false',
    ).toBe(true);
    // The old shape must not come back: a bare catch returning false.
    expect(
      /catch\s*(\([^)]*\))?\s*\{\s*return\s+false\s*;?\s*\}/.test(code),
      'a bare `catch { return false }` is what fabricated the negative — it must not reappear',
    ).toBe(false);
  });

  it('the validator surfaces MERGE_BASE_UNVERIFIABLE as a code distinct from MERGE_COMMIT_UNREACHABLE', () => {
    const src = fs.readFileSync(VALIDATOR, 'utf-8');
    expect(src).toContain('MERGE_BASE_UNVERIFIABLE');
    expect(src).toContain('MERGE_COMMIT_UNREACHABLE');
    // The unverifiable path must come from catching the helper, not from a falsy return.
    const idx = src.indexOf('MERGE_BASE_UNVERIFIABLE');
    const around = src.slice(Math.max(0, idx - 900), idx + 300);
    expect(
      /catch\s*\(/.test(around),
      'MERGE_BASE_UNVERIFIABLE must be produced by catching a throwing helper',
    ).toBe(true);
  });
});
