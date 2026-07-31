// safe-fs-allow: test file — SafeFsExecutor removes isolated tmpdirs.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { WorktreeEnumerationFailureStore } from '../../src/monitoring/WorktreeEnumerationFailureStore.js';

describe('WorktreeEnumerationFailureStore', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-enum-history-'));
    file = path.join(dir, 'state', 'worktree-enumeration-failures.json');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'WorktreeEnumerationFailureStore.test:cleanup' });
  });

  it('persists one independent fixed-cardinality history record per guard across restart', () => {
    const first = new WorktreeEnumerationFailureStore(file);
    first.forGuard('agent-worktree-reaper').recordFailure(100);
    first.forGuard('orphaned-work-sentinel').recordFailure(200);
    first.forGuard('agent-worktree-reaper').recordFailure(300);

    const restarted = new WorktreeEnumerationFailureStore(file);
    expect(restarted.forGuard('agent-worktree-reaper').load()).toEqual({
      enumerationFailures: 2,
      lastEnumerationFailureAt: 300,
    });
    expect(restarted.forGuard('orphaned-work-sentinel').load()).toEqual({
      enumerationFailures: 1,
      lastEnumerationFailureAt: 200,
    });
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).guards)).toHaveLength(2);
  });

  it('rejects corrupt history instead of inventing a clean zero', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, guards: { 'agent-worktree-reaper': { enumerationFailures: -1 } } }));
    expect(() => new WorktreeEnumerationFailureStore(file).forGuard('agent-worktree-reaper').load())
      .toThrow(/invalid-worktree-enumeration-failure-ledger-record/);
  });
});
