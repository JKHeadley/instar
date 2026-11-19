/**
 * Integration (docs/specs/guard-runtime-state-scope.md, Testing → Integration): a throwaway
 * agent home living under a `/.instar/` parent runs the named callers' real code paths in
 * both modes — the confinement canary (fixture, link leftovers, close), a worktree create
 * and remove (rename into the trash + out-of-process delete), a node_modules clone fallback,
 * a stuck-rebase cleanup and a state-store delete. `report` yields no would-deny rows for
 * them; `enforce` refuses none of them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { configureGuardRuntimeScope, _resetGuardRuntimeScopeForTesting } from '../../src/core/guardRuntimeScope.js';
import { readLedgerSummary, _resetLedgerMemoryForTesting } from '../../src/core/guardScopeLedger.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { canaryLinkPaths, linkEffectChecks, prepareCanaryFixture } from '../../src/feedback-factory/execute/confinementCanary.js';
import { _cloneNodeModulesForTesting } from '../../src/core/InstarWorktreeManager.js';
import type { ConfinementPaths } from '../../src/feedback-factory/execute/executePolicy.js';
import { git, makeGuardFixture, type GuardFixture } from '../fixtures/guardScopeFixture.js';

let fx: GuardFixture;
const prevLedger = process.env.INSTAR_GUARD_SCOPE_LEDGER_DIR;

beforeEach(() => {
  fx = makeGuardFixture('guard-scope-int-');
  process.env.INSTAR_GUARD_SCOPE_LEDGER_DIR = fx.ledgerDir;
  _resetGuardRuntimeScopeForTesting();
  _resetLedgerMemoryForTesting();
  DegradationReporter.resetForTesting();
});
afterEach(() => {
  _resetGuardRuntimeScopeForTesting();
  DegradationReporter.resetForTesting();
  process.env.INSTAR_GUARD_SCOPE_LEDGER_DIR = prevLedger;
  fx.cleanup();
});

async function runCallers(): Promise<void> {
  const home = fx.home;
  const worktrees = path.join(home, '.worktrees');

  // 1. The confinement canary: fixture, link-probe leftovers in the workspace, close.
  const workspace = path.join(worktrees, 'feedback-fb-int-abcd1234-a1');
  fs.mkdirSync(workspace, { recursive: true });
  const paths: ConfinementPaths = {
    workspace, tmpDir: path.join(fx.outside, 'tmp'), depsCache: path.join(home, '.instar', 'state', 'deps'), agentHome: home,
    publishClone: path.join(worktrees, 'feedback-fb-int-abcd1234-a1-publish'), testRunnerHoldersFile: path.join(home, '.instar', 'state', 'holders.json'),
    homeDir: path.join(fx.outside, 'userhome'),
  };
  fs.mkdirSync(paths.homeDir!, { recursive: true });
  const canary = await prepareCanaryFixture(paths, {
    secretsDir: path.join(home, '.instar', 'state', 'feedback-factory', 'execute', 'canary'),
    configPath: path.join(home, '.instar', 'config.json'),
  });
  fs.writeFileSync(canary.siblingWritePath, 'session wrote here');
  const links = canaryLinkPaths(paths, canary);
  fs.writeFileSync(links.hardLink, '');
  fs.symlinkSync(canary.noncePath, links.symLink);
  fs.symlinkSync(canary.siblingDir, links.siblingLink);
  linkEffectChecks(paths, canary);
  await canary.close();
  for (const p of [links.hardLink, links.symLink, links.siblingLink, canary.siblingWritePath, canary.siblingNoncePath, canary.siblingDir, canary.noncePath]) {
    expect(fs.existsSync(p), p).toBe(false);
  }

  // 2. A worktree create and remove (the reaper's rename into the trash, then the out-of-process delete).
  const wt = path.join(worktrees, 'echo-int-wt');
  git(home, ['worktree', 'add', '-q', wt]);
  const trashRoot = path.join(worktrees, '.trash');
  fs.mkdirSync(trashRoot, { recursive: true });
  const scope = { worktreesDir: worktrees, trashRoot, allowedSources: [wt] };

  // 3. A node_modules clone fallback inside the listed worktree: the clone fails part-way and the
  //    staging folder is removed under nodeModulesCloneStagingScope.
  const nm = path.join(fx.outside, 'nm-source');
  fs.mkdirSync(path.join(nm, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(nm, 'pkg', 'a.js'), '1');
  fs.writeFileSync(path.join(nm, 'pkg', 'locked.js'), '2');
  fs.chmodSync(path.join(nm, 'pkg', 'locked.js'), 0o000);
  expect(_cloneNodeModulesForTesting(nm, path.join(wt, 'node_modules'))).toBe(false);
  expect(fs.readdirSync(wt).filter((n) => n.startsWith('node_modules.clone-'))).toEqual([]);

  const dest = path.join(trashRoot, `echo-int-wt-${Date.now()}`);
  SafeFsExecutor.safeRenameDirSync(wt, dest, { operation: 'int:reclaim-rename', worktreeTrashScope: scope });
  const rm = await SafeFsExecutor.safeRmTreeInSubprocess(dest, { operation: 'int:reclaim-rm', worktreeTrashScope: scope, timeoutMs: 30_000 });
  expect(rm.ok).toBe(true);
  git(home, ['worktree', 'prune']);

  // 4. A stuck-rebase cleanup (GitSync's fallback).
  const rebase = path.join(home, '.git', 'rebase-merge');
  fs.mkdirSync(rebase);
  fs.writeFileSync(path.join(rebase, 'head-name'), 'x');
  SafeFsExecutor.safeRmSync(rebase, { recursive: true, force: true, operation: 'src/core/GitSync.ts:346', gitRebaseStateScope: { projectDir: home } });
  expect(fs.existsSync(rebase)).toBe(false);

  // 5. A state-store delete and an atomic write under the home's own .instar/.
  const stateFile = path.join(home, '.instar', 'state', 'store.json');
  SafeFsExecutor.atomicWriteJsonSync(stateFile, { a: 1 });
  SafeFsExecutor.safeUnlinkSync(stateFile, { operation: 'int:state-delete' });
  expect(fs.existsSync(stateFile)).toBe(false);
}

describe('guard runtime-state scope: the named callers on an agent home under /.instar/', () => {
  it('report: everything runs as today and no would-deny row is written for them', async () => {
    await runCallers();
    const s = await readLedgerSummary(fx.ledgerDir);
    expect(s.counts.wouldDeny).toBe(0);
    expect(s.effectiveMode).toBe('report');
    expect(DegradationReporter.getInstance().getEvents().filter((e) => e.feature.startsWith('SafeFsExecutor.'))).toEqual([]);
  }, 120_000);

  it('enforce: the scoped rule refuses none of them', async () => {
    configureGuardRuntimeScope({ mode: 'enforce' });
    await runCallers();
    expect(DegradationReporter.getInstance().getEvents().filter((e) => e.feature.startsWith('SafeFsExecutor.'))).toEqual([]);
  }, 120_000);
});
