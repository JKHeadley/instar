// safe-git-allow: test file — execFileSync('git') builds the fixture repo + worktrees; fs.rmSync is per-test tmpdir cleanup.
/**
 * Tier 2 (integration) — the event-loop-safety proof for the worktree-reaper and
 * orphaned-work READ ROUTES.
 *
 * WHY THIS FILE EXISTS. `GET /worktrees/agent-reaper` is a non-async Express
 * handler calling `reaper.snapshot()` directly, and `snapshot()` fans out
 * `evaluate()` over every worktree, each shelling out synchronously via
 * `SafeGitExecutor.readSync` (execFileSync). Measured on a live agent
 * (2026-07-29, 48 worktrees): ONE request froze the Node event loop for 10.6s —
 * baseline `/health` 17ms, `/health` during the request 10.6s. Every route,
 * every timer, the lease heartbeat and the mesh probes stall for that window.
 *
 * DISCRIMINATION (requester constraint 1 — every test run against UNFIXED source
 * first, and anything that passes either way labelled CONTROL, never counted as
 * proof):
 *   - `does NOT starve the event loop` — FAILS on unfixed source (sampled lag is
 *     seconds, not <250ms) and passes only once the read path is genuinely
 *     non-blocking. This is the evidence.
 *   - `CONTROL:` -prefixed tests below pass BOTH before and after the fix. They
 *     pin the behavioural contract (verdicts must not change) so the fix cannot
 *     silently alter classification. They are NOT proof the hazard is gone.
 *
 * REAL WIRING (requester constraint 2 — verify the thing is wired, not merely
 * correct). These tests build the deps with the PRODUCTION factory
 * `makeAgentWorktreeReaperDeps`, let the git reads default to the real
 * `SafeGitExecutor` funnel, and exercise the REAL full-system process scan — so
 * the fan-out under measurement is the one production actually runs. The only
 * override is `githubMergeCheck: false`, because tests must not reach the network;
 * that call is non-blocking now, so excluding it hides no event-loop cost.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { AgentWorktreeReaper } from '../../src/monitoring/AgentWorktreeReaper.js';
import { makeAgentWorktreeReaperDeps } from '../../src/monitoring/agentWorktreeGit.js';

/** How many fixture worktrees to fan out over. Each costs ~3 synchronous git
 *  spawns on the unfixed path (status + rev-parse + cherry), so 12 puts the
 *  unfixed block well clear of the 250ms budget while keeping setup fast. */
const WORKTREES = 12;
const LAG_BUDGET_MS = 250;
const SAMPLE_MS = 20;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

let repo: string;
let worktreesDir: string;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'awr-elp-'));
  worktreesDir = path.join(repo, '.worktrees');
  fs.mkdirSync(worktreesDir, { recursive: true });

  git(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'x\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);

  // A mix that exercises every gate, so the fan-out is representative rather
  // than all short-circuiting at the first cheap check:
  //   - even index: clean + merged  → reaches the expensive `cherry` comparison
  //   - odd  index: dirty           → short-circuits at `isClean`
  for (let i = 0; i < WORKTREES; i++) {
    const wt = path.join(worktreesDir, `wt${i}`);
    git(repo, ['worktree', 'add', '-q', '-b', `feat/wt${i}`, wt, 'main']);
    if (i % 2 === 1) fs.writeFileSync(path.join(wt, 'dirty.txt'), 'uncommitted\n');
  }
}, 120_000);

afterAll(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
});

/**
 * Production deps, real git funnel, and the REAL full-system process scan.
 *
 * The process scan is deliberately NOT stubbed. An earlier version of this test
 * stubbed it for determinism, and the Standards-Conformance Gate correctly flagged
 * that as a No-Deferrals violation: while that scan was still synchronous it was
 * the single most expensive blocking call on this path, and stubbing it meant the
 * test could not see the very thing it claimed to guard. Now that the scan is
 * non-blocking it is safe to exercise for real — a slow host makes the request
 * slower without starving the loop, which is exactly the property under test, so
 * including it strengthens the measurement instead of destabilising it.
 *
 * `githubMergeCheck` stays off for one reason only: tests must not reach the
 * network. That call is also non-blocking now, so its exclusion no longer hides
 * any event-loop cost.
 */
function realDeps() {
  return makeAgentWorktreeReaperDeps({
    instarRepo: repo,
    worktreesDir,
    githubMergeCheck: false,
  });
}

function reaper(): AgentWorktreeReaper {
  // enabled:false + dryRun:true — the shipped default. The hazard under test is
  // on the READ ROUTE, which runs the full pass regardless of these flags.
  return new AgentWorktreeReaper(realDeps(), { enabled: false, dryRun: true });
}

/**
 * Sample event-loop drift across `body`. A synchronous blocker cannot be
 * preempted, so the stall surfaces as drift on the first timer tick AFTER it.
 *
 * THE SUBTLETY THAT MADE THE FIRST VERSION OF THIS HARNESS A NO-OP (caught by
 * running it against unfixed source, per requester constraint 1): `await body()`
 * on a SYNCHRONOUS body resolves through the MICROTASK queue, and microtasks run
 * before timers. So `clearInterval` in the `finally` executed before the sampler
 * could ever fire again, and a genuine multi-second block measured as ~0ms lag —
 * the test passed against the unfixed code and proved nothing.
 *
 * The `setTimeout` below is therefore load-bearing, not hygiene: it yields to the
 * MACROTASK queue so the post-block tick is actually observed before we stop
 * sampling. (The cartographer precedent, tests/integration/
 * cartographer-eventloop-worker.test.ts, did not need this only because the work
 * under measurement there is genuinely async and the sampler ran DURING it.)
 */
async function maxLagDuring(body: () => unknown | Promise<unknown>): Promise<number> {
  let maxLag = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    maxLag = Math.max(maxLag, now - last - SAMPLE_MS);
    last = now;
  }, SAMPLE_MS);
  try {
    // Let the sampler establish a baseline tick before the work starts.
    await new Promise<void>((r) => setTimeout(r, SAMPLE_MS * 2));
    last = Date.now();
    await body();
    // Load-bearing: drain to the macrotask queue so a synchronous stall is
    // sampled. Without this the measurement is structurally blind. See above.
    await new Promise<void>((r) => setTimeout(r, SAMPLE_MS * 2));
  } finally {
    clearInterval(timer);
  }
  return maxLag;
}

describe('AgentWorktreeReaper read path — event-loop safety', () => {
  it('snapshot() does NOT starve the event loop (max sampled lag < 250ms)', async () => {
    const r = reaper();
    const maxLag = await maxLagDuring(() => r.snapshot());
    // On unfixed source this is seconds: `snapshot()` is synchronous and shells
    // out ~3x per worktree through execFileSync, so the sampler cannot run at all
    // until the whole fan-out completes.
    expect(maxLag).toBeLessThan(LAG_BUDGET_MS);
  }, 120_000);

  it('CONTROL: snapshot() evaluates every fixture worktree', async () => {
    // Passes before AND after the fix — it pins the contract that the fix must
    // not change WHAT is reported, only how it is executed. Not hazard evidence.
    const snap = await Promise.resolve(reaper().snapshot());
    expect(snap.worktrees).toHaveLength(WORKTREES);
  }, 120_000);

  it('CONTROL: dirty worktrees are kept for uncommitted changes', async () => {
    // Passes before AND after the fix. Guards the safety-critical verdict:
    // whatever the execution model, uncommitted work must never read as
    // reclaimable. Not hazard evidence.
    const snap = await Promise.resolve(reaper().snapshot());
    const dirty = snap.worktrees.filter((w) => w.reason === 'uncommitted-changes');
    expect(dirty).toHaveLength(WORKTREES / 2);
    expect(dirty.every((w) => w.verdict === 'keep')).toBe(true);
  }, 120_000);
});
