// safe-git-allow: test file — execFileSync('git') builds the throwaway fixture repo + worktree; fs.rmSync is per-test tmpdir cleanup.
/**
 * Tier 1 (unit) — WIRING INTEGRITY: production deps must take the NON-BLOCKING
 * read path, not merely be capable of it.
 *
 * Raised by the cross-model reviewer (codex-cli:gpt-5.5) against the spec: because
 * `makeAgentWorktreeReaperDeps` DERIVES an async reader from an injected blocking
 * `readGit` (a deliberate compatibility shim so existing sync test fakes keep
 * working), there is an implicit escape hatch — a future production wiring could
 * pass a synchronous reader and reintroduce the event-loop freeze *behind an
 * `await`*, where it would be invisible to the event-loop budget test.
 *
 * This closes it structurally: with NO reader injected (exactly how
 * `src/commands/server.ts` constructs the deps), every read must go through the
 * funnel's NON-BLOCKING primitive. `SafeGitExecutor.readSync` must not be called
 * at all.
 *
 * The primitive named here is `readAsync`, not `readStream`. Round-two review
 * found that consuming `readStream` left the funnel unable to audit how a read
 * ENDED — a failed read gating a DELETE was recorded as `allowed` with no failure
 * row. Accumulation moved inside the funnel; these assertions moved with it.
 *
 * This is the "verify it is WIRED, not merely correct" check — the requester's
 * constraint 2. It fails if someone rewires production back onto the blocking read,
 * which is the regression the compatibility shim makes possible.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { makeAgentWorktreeReaperDeps } from '../../src/monitoring/agentWorktreeGit.js';

let repo: string;
let worktreesDir: string;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'awg-wiring-'));
  worktreesDir = path.join(repo, '.worktrees');
  fs.mkdirSync(worktreesDir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'x\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'init'], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    },
  });
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feat/a', path.join(worktreesDir, 'a'), 'main'], { cwd: repo });
  // LOAD-BEARING: the worktree must be DIRTY. With a clean fixture the sentinel's
  // evaluate() short-circuits at skip('clean') and never reaches its OWN reads
  // (porcelain / workSignature / lastActivityMs) — so the wiring assertion below passed
  // even with those regressed to the blocking reader. Proven by an adversarial reviewer
  // who reverted them and watched the whole suite stay green.
  fs.writeFileSync(path.join(worktreesDir, 'a', 'dirty.txt'), 'uncommitted\n');
});

afterAll(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
});

afterEach(() => { vi.restoreAllMocks(); });

/** Deps built exactly as production builds them: no reader injected. */
const prodDeps = () => makeAgentWorktreeReaperDeps({
  instarRepo: repo,
  worktreesDir,
  githubMergeCheck: false,
});

describe('production deps wiring — non-blocking reads only', () => {
  it('listWorktrees goes through readAsync and NEVER readSync', async () => {
    const readSync = vi.spyOn(SafeGitExecutor, 'readSync');
    const readAsync = vi.spyOn(SafeGitExecutor, 'readAsync');
    const list = await prodDeps().listWorktrees();
    expect(list.length).toBeGreaterThan(0);       // proves it really read something
    expect(readAsync).toHaveBeenCalled();
    expect(readSync).not.toHaveBeenCalled();
  });

  it('isClean goes through readAsync and NEVER readSync', async () => {
    const readSync = vi.spyOn(SafeGitExecutor, 'readSync');
    const readAsync = vi.spyOn(SafeGitExecutor, 'readAsync');
    await prodDeps().isClean(path.join(worktreesDir, 'a'));
    expect(readAsync).toHaveBeenCalled();
    expect(readSync).not.toHaveBeenCalled();
  });

  it('isMerged goes through readAsync and NEVER readSync', async () => {
    const deps = prodDeps();
    const list = await deps.listWorktrees();
    const readSync = vi.spyOn(SafeGitExecutor, 'readSync');
    const readAsync = vi.spyOn(SafeGitExecutor, 'readAsync');
    await deps.isMerged(list[0]!);
    expect(readAsync).toHaveBeenCalled();
    expect(readSync).not.toHaveBeenCalled();
  });

  it('a full production snapshot pass makes ZERO blocking git reads', async () => {
    // The end-to-end wiring assertion: the whole read path, production deps, no
    // injected fakes. One readSync call anywhere here is a reintroduced freeze.
    const { AgentWorktreeReaper } = await import('../../src/monitoring/AgentWorktreeReaper.js');
    const readSync = vi.spyOn(SafeGitExecutor, 'readSync');
    const reaper = new AgentWorktreeReaper(prodDeps(), { enabled: false, dryRun: true });
    const snap = await reaper.snapshot();
    expect(snap.worktrees.length).toBeGreaterThan(0); // the pass did real work
    expect(readSync).not.toHaveBeenCalled();
  });

  it('the ORPHANED-WORK production wiring also makes ZERO blocking reads', async () => {
    // THE TEST THAT SHOULD HAVE EXISTED. The first version of this suite only covered
    // makeAgentWorktreeReaperDeps — the one construction that CANNOT exhibit the defect
    // — while makeOrphanedWorkSentinelDeps, a real production wiring, injected a
    // synchronous reader and routed its whole route back onto the blocking path. The
    // suite certified a property the shipped code violated. Four reviewers found it.
    const { makeOrphanedWorkSentinelDeps } = await import('../../src/monitoring/orphanedWorkGit.js');
    const { OrphanedWorkSentinel } = await import('../../src/monitoring/OrphanedWorkSentinel.js');
    const readSync = vi.spyOn(SafeGitExecutor, 'readSync');
    const deps = makeOrphanedWorkSentinelDeps({
      instarRepo: repo,
      worktreesDir,
      stateDir: path.join(repo, '.instar', 'state'),
      raiseAttention: () => {},
    });
    const sentinel = new OrphanedWorkSentinel(deps, { enabled: false });
    const snap = await sentinel.snapshot();
    expect(snap.evaluations.length).toBeGreaterThan(0); // it did real work
    expect(readSync).not.toHaveBeenCalled();
  });

  it('the sync-derived shim is TEST-ONLY: injecting readGit is what routes to it', async () => {
    // Documents the escape hatch rather than pretending it does not exist. An
    // injected sync reader IS used (that is the compatibility contract existing
    // tests rely on) — and the tests above are what stop production from taking it.
    const calls: string[][] = [];
    const deps = makeAgentWorktreeReaperDeps({
      instarRepo: repo,
      worktreesDir,
      githubMergeCheck: false,
      readGit: (args) => { calls.push(args); return ''; },
    });
    const readAsync = vi.spyOn(SafeGitExecutor, 'readAsync');
    await deps.isClean(path.join(worktreesDir, 'a'));
    expect(calls.length).toBeGreaterThan(0);        // the injected fake was used
    expect(readAsync).not.toHaveBeenCalled();       // and no real git ran
  });
});

/**
 * The reclaim path, driven by ASYNC signals — the shape production actually uses.
 *
 * WHY THIS EXISTS. `reclaimRaceGuard` re-confirms three signals immediately before an
 * irreversible `git worktree remove`. When those signals became `Awaitable`, the guard
 * still read them without awaiting. An un-awaited Promise is ALWAYS truthy, so:
 *   - `if (isInUse(...))` fired for every worktree  → the reaper became silently INERT;
 *   - `if (!isClean(...))` and `if (!isMerged(...))` were ALWAYS false → both re-checks
 *     were vacuous, so a worktree that went DIRTY between evaluation and reclaim would
 *     have been DELETED.
 * TypeScript permits truthiness on `boolean | Promise<boolean>`, and every pre-existing
 * reap test injected SYNC fakes, so nothing in the suite could see it. These cases drive
 * the guard with promise-returning fakes — the only shape that discriminates.
 */
describe('reclaim race guard — async deps (the shape production uses)', () => {
  const wt = { path: '/wt/a', branch: 'feat/a', headSha: 'sha1' };
  const asyncDeps = (over: Record<string, unknown> = {}) => ({
    listWorktrees: async () => [wt],
    isClean: async () => true,
    isMerged: async () => true,
    isInUse: async () => false,
    currentBranch: async () => 'feat/a',
    hasActiveBuildMarker: async () => false,
    removeWorktree: () => {},
    ...over,
  });

  it('REAPS a genuinely merged-clean-idle worktree (guard is not vacuously blocking)', async () => {
    const { AgentWorktreeReaper } = await import('../../src/monitoring/AgentWorktreeReaper.js');
    const removed: string[] = [];
    const r = new AgentWorktreeReaper(
      asyncDeps({ removeWorktree: (p: string) => { removed.push(p); } }) as never,
      { enabled: true, dryRun: false },
    );
    const res = await r.reap();
    expect(res.reaped).toEqual(['/wt/a']);
    expect(removed).toEqual(['/wt/a']);
  });

  it('KEEPS a worktree that went DIRTY between evaluation and reclaim (the delete-unsafe case)', async () => {
    const { AgentWorktreeReaper } = await import('../../src/monitoring/AgentWorktreeReaper.js');
    let call = 0;
    const removed: string[] = [];
    const r = new AgentWorktreeReaper(
      asyncDeps({
        // clean at evaluation, dirty at the reclaim re-check
        isClean: async () => { call += 1; return call === 1; },
        removeWorktree: (p: string) => { removed.push(p); },
      }) as never,
      { enabled: true, dryRun: false },
    );
    const res = await r.reap();
    expect(removed).toEqual([]);          // nothing deleted
    expect(res.reaped).toEqual([]);
    expect(res.evaluations[0]?.reason).toBe('raced-now-dirty');
  });

  it('KEEPS a worktree that became IN USE between evaluation and reclaim', async () => {
    const { AgentWorktreeReaper } = await import('../../src/monitoring/AgentWorktreeReaper.js');
    let call = 0;
    const removed: string[] = [];
    const r = new AgentWorktreeReaper(
      asyncDeps({
        isInUse: async () => { call += 1; return call > 1; },
        removeWorktree: (p: string) => { removed.push(p); },
      }) as never,
      { enabled: true, dryRun: false },
    );
    const res = await r.reap();
    expect(removed).toEqual([]);
    expect(res.evaluations[0]?.reason).toBe('raced-now-in-use');
  });
});
