/**
 * Git-side rules for docs/specs/reaper-removal-out-of-process.md:
 *   §5 closed-unmerged PRs count as merged only with an exact head match AND the
 *      remote PR ref holding that SHA (both sides of each condition);
 *   §2 `.trash` is skipped by buildInboundLinkIndex and listWorktrees;
 *   §4 the hourly cadence reaches existing agents holding the old 24 h default.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  buildInboundLinkIndex,
  closedUnmergedPrPreserves,
  fetchClosedPrHeads,
  lsRemotePrHead,
  makeAgentWorktreeReaperDeps,
  type ClosedPr,
  type ReadGit,
} from '../../src/monitoring/agentWorktreeGit.js';
import { migrateConfigReaperHourlyCadence } from '../../src/core/PostUpdateMigrator.js';

const OP = 'tests/unit/agent-worktree-reclaim-git.test.ts';
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

describe('closed-unmerged PRs (§5)', () => {
  const pr = (over: Partial<ClosedPr> = {}): ClosedPr => ({ number: 7, headRefOid: SHA, mergedAt: null, ...over });

  it('head match + remote ref holds the SHA ⇒ merged-equivalent', () => {
    expect(closedUnmergedPrPreserves(SHA, [pr()], () => SHA)).toBe(true);
  });
  it('head mismatch ⇒ unmerged', () => {
    expect(closedUnmergedPrPreserves(SHA, [pr({ headRefOid: OTHER })], () => SHA)).toBe(false);
  });
  it('remote ref missing or holding another SHA ⇒ unmerged', () => {
    expect(closedUnmergedPrPreserves(SHA, [pr()], () => null)).toBe(false);
    expect(closedUnmergedPrPreserves(SHA, [pr()], () => OTHER)).toBe(false);
  });
  it('no PR ⇒ unmerged; a merged PR is not this rule', () => {
    expect(closedUnmergedPrPreserves(SHA, undefined, () => SHA)).toBe(false);
    expect(closedUnmergedPrPreserves(SHA, [], () => SHA)).toBe(false);
    expect(closedUnmergedPrPreserves(SHA, [pr({ mergedAt: '2026-11-18T00:00:00Z' })], () => SHA)).toBe(false);
  });

  it('fetchClosedPrHeads asks gh for number, headRefOid and mergedAt; malformed rows and failures yield nothing', () => {
    let asked: string[] = [];
    const map = fetchClosedPrHeads('/repo', {
      runGh: (args) => {
        asked = args;
        return JSON.stringify([
          { number: 3, headRefName: 'feat', headRefOid: SHA, mergedAt: null },
          { number: 4, headRefName: 'feat', headRefOid: OTHER, mergedAt: '2026-01-01T00:00:00Z' },
          { number: 'x', headRefName: 'bad', headRefOid: SHA },
        ]);
      },
    });
    expect(asked).toEqual(['pr', 'list', '--state', 'closed', '--json', 'number,headRefName,headRefOid,mergedAt', '--limit', '500']);
    expect(map.get('feat')).toEqual([{ number: 3, headRefOid: SHA, mergedAt: null }, { number: 4, headRefOid: OTHER, mergedAt: '2026-01-01T00:00:00Z' }]);
    expect(map.has('bad')).toBe(false);
    expect(fetchClosedPrHeads('/repo', { runGh: () => null }).size).toBe(0);
    expect(fetchClosedPrHeads('/repo', { runGh: () => 'not json' }).size).toBe(0);
  });

  it('lsRemotePrHead reads `git ls-remote origin refs/pull/<n>/head` and validates the SHA', () => {
    let args: string[] = [];
    const rg: ReadGit = (a) => { args = a; return `${SHA}\trefs/pull/9/head\n`; };
    expect(lsRemotePrHead(rg, '/repo', 9)).toBe(SHA);
    expect(args).toEqual(['-C', '/repo', 'ls-remote', 'origin', 'refs/pull/9/head']);
    expect(lsRemotePrHead(() => '', '/repo', 9)).toBeNull();
    expect(lsRemotePrHead(() => { throw new Error('offline'); }, '/repo', 9)).toBeNull();
    expect(lsRemotePrHead(rg, '/repo', -1)).toBeNull();
  });
});

describe('real repo: isMerged with a closed-unmerged PR, and the trash skips', () => {
  let root: string;
  let home: string;
  let worktreesDir: string;
  const g = (cwd: string, args: string[]) => SafeGitExecutor.run(args, { cwd, operation: OP });
  const readGit: ReadGit = (args, cwd) => SafeGitExecutor.readSync(args, { cwd, encoding: 'utf-8', timeout: 30_000, operation: OP, sourceTreeReadOk: true, sourceTreeWorktreeManagerOk: true });

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-git-')));
    home = path.join(root, '.instar', 'agents', 'echo');
    fs.mkdirSync(home, { recursive: true });
    process.env.INSTAR_AUDIT_LOG_DIR = path.join(root, 'audit');
    g(home, ['init', '-q', '-b', 'main']);
    g(home, ['config', 'user.email', 't@t.l']);
    g(home, ['config', 'user.name', 'T']);
    g(home, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(home, '.gitignore'), '.worktrees/\n');
    g(home, ['add', '-A']);
    g(home, ['commit', '-qm', 'init']);
    worktreesDir = path.join(home, '.worktrees');
    fs.mkdirSync(worktreesDir);
  });
  afterEach(() => {
    delete process.env.INSTAR_AUDIT_LOG_DIR;
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: OP });
  });

  const unmergedWorktree = (slug: string) => {
    const wt = path.join(worktreesDir, slug);
    g(home, ['worktree', 'add', '-q', wt, '-b', slug, 'HEAD']);
    fs.writeFileSync(path.join(wt, 'w.txt'), slug);
    g(wt, ['add', '-A']);
    g(wt, ['commit', '-qm', 'closed work']);
    return { wt, head: g(wt, ['rev-parse', 'HEAD']).trim() };
  };

  it('a closed PR whose head is on the remote ref makes the branch merged; the race guard sees the same rule', () => {
    const { wt, head } = unmergedWorktree('closed-branch');
    const info = { path: wt, branch: 'closed-branch', headSha: head };
    const mk = (refSha: string | null) => makeAgentWorktreeReaperDeps({
      instarRepo: home, worktreesDir, readGit, githubMergeCheck: true,
      mergedPrMap: () => new Map(), closedPrMap: () => new Map([['closed-branch', [{ number: 12, headRefOid: head, mergedAt: null }]]]),
      lsRemotePrHead: () => refSha, cwdRoots: () => new Set(), commandLines: () => [], inboundLinks: async () => new Set(),
    });
    expect(mk(head).isMerged(info)).toBe(true);
    expect(mk(head).isMergedFresh(info)).toBe(true);
    expect(mk(null).isMerged(info)).toBe(false);
    expect(mk(OTHER).isMergedFresh(info)).toBe(false);
    // githubMergeCheck off ⇒ never consulted
    const off = makeAgentWorktreeReaperDeps({ instarRepo: home, worktreesDir, readGit, githubMergeCheck: false, closedPrMap: () => { throw new Error('called'); } });
    expect(off.isMerged(info)).toBe(false);
  });

  it('listWorktrees skips a registration whose folder is in .trash; buildInboundLinkIndex does not walk .trash', async () => {
    const keep = path.join(worktreesDir, 'keep');
    g(home, ['worktree', 'add', '-q', keep, '-b', 'keep', 'HEAD']);
    const trashed = path.join(worktreesDir, '.trash', 'abc');
    fs.mkdirSync(path.dirname(trashed));
    g(home, ['worktree', 'add', '-q', trashed, '-b', 'trashed', 'HEAD']);
    const deps = makeAgentWorktreeReaperDeps({ instarRepo: home, worktreesDir, readGit, githubMergeCheck: false });
    const listed = deps.listWorktrees();
    expect(listed.ok && listed.worktrees.map((w) => w.path)).toEqual([keep]);
    // A link inside the trash pointing at `keep` must not mark it linked.
    fs.symlinkSync(keep, path.join(trashed, 'link-to-keep'));
    const idx = await buildInboundLinkIndex(home, worktreesDir);
    expect(idx).not.toBeNull();
    expect(idx!.linked.has(keep)).toBe(false);
    // The same link outside the trash does.
    fs.symlinkSync(keep, path.join(home, 'link-to-keep'));
    expect((await buildInboundLinkIndex(home, worktreesDir))!.linked.has(keep)).toBe(true);
  });
});

describe('hourly cadence migration (§4)', () => {
  it('moves exactly the old 24 h default, once', () => {
    const cfg: Record<string, unknown> = { monitoring: { agentWorktreeReaper: { enabled: true, dryRun: true, reapIntervalMs: 86_400_000 } } };
    expect(migrateConfigReaperHourlyCadence(cfg)).toBe('moved');
    expect((cfg.monitoring as { agentWorktreeReaper: { reapIntervalMs: number; dryRun: boolean } }).agentWorktreeReaper).toMatchObject({ reapIntervalMs: 3_600_000, dryRun: true });
    // run-once: an operator re-setting 24 h later is never touched
    (cfg.monitoring as { agentWorktreeReaper: { reapIntervalMs: number } }).agentWorktreeReaper.reapIntervalMs = 86_400_000;
    expect(migrateConfigReaperHourlyCadence(cfg)).toBe('already');
    expect((cfg.monitoring as { agentWorktreeReaper: { reapIntervalMs: number } }).agentWorktreeReaper.reapIntervalMs).toBe(86_400_000);
  });
  it('leaves an operator value alone and handles a missing block', () => {
    const tuned: Record<string, unknown> = { monitoring: { agentWorktreeReaper: { reapIntervalMs: 7_200_000 } } };
    expect(migrateConfigReaperHourlyCadence(tuned)).toBe('none');
    expect((tuned.monitoring as { agentWorktreeReaper: { reapIntervalMs: number } }).agentWorktreeReaper.reapIntervalMs).toBe(7_200_000);
    expect(migrateConfigReaperHourlyCadence({})).toBe('none');
  });
});
