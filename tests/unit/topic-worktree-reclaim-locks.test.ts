/**
 * topic-worktree-reclaim A, B, C: a session's worktree lock is released when it
 * ends; at start only locks of sessions with no running record are released; an
 * unlink that fails keeps the lock; links from another checkout folder protect a
 * checkout; a linked worktree's index lock is seen; dependency copies are marked.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { createTwoSessionHarness, type HarnessHandle } from '../fixtures/two-session-harness.js';
import { makeAgentWorktreeReaperDeps, buildInboundLinkIndex } from '../../src/monitoring/agentWorktreeGit.js';
import { DEPS_COPY_MARKER } from '../../src/core/WorktreeManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('A: worktree locks', () => {
  let h: HarnessHandle;
  beforeEach(async () => { h = await createTwoSessionHarness(); });
  afterEach(() => { h.cleanup(); });

  it('releaseForSession removes the ended session lock from the map and disk', async () => {
    const s = await h.spawn({ topicId: 101, slug: 'a' });
    const lockFile = path.join(s.cwd!, '.session.lock');
    expect(fs.existsSync(lockFile)).toBe(true);
    expect(h.manager.releaseForSession(s.sessionId)).toBe(1);
    expect(fs.existsSync(lockFile)).toBe(false);
    expect(h.manager.releaseForSession(s.sessionId)).toBe(0);
  });

  it('an unlink that fails (not ENOENT) keeps the lock and does not count', async () => {
    const s = await h.spawn({ topicId: 102, slug: 'b' });
    const orig = SafeFsExecutor.safeUnlinkSync;
    (SafeFsExecutor as unknown as { safeUnlinkSync: unknown }).safeUnlinkSync = () => { const e = new Error('EPERM') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e; };
    try {
      expect(h.manager.releaseForSession(s.sessionId)).toBe(0);
    } finally {
      (SafeFsExecutor as unknown as { safeUnlinkSync: unknown }).safeUnlinkSync = orig;
    }
    expect(h.manager.releaseForSession(s.sessionId)).toBe(1); // retried, now released
  });

  it('orphan release: only locks of sessions with no running record go; unreadable records release nothing', async () => {
    const live = await h.spawn({ topicId: 103, slug: 'live' });
    const gone = await h.spawn({ topicId: 104, slug: 'gone' });
    expect(h.manager.releaseOrphanedLocks(() => null, [])).toBe(0);
    expect(h.manager.releaseOrphanedLocks(() => false, null)).toBe(0); // pane state unknown: keep all
    // A live pane inside the 'gone' tree keeps its lock even with no running record.
    expect(h.manager.releaseOrphanedLocks((id) => id === live.sessionId, [path.join(gone.cwd!, 'src')])).toBe(0);
    const released = h.manager.releaseOrphanedLocks((id) => id === live.sessionId, []);
    expect(released).toBe(1);
    expect(fs.existsSync(path.join(live.cwd!, '.session.lock'))).toBe(true);
    expect(fs.existsSync(path.join(gone.cwd!, '.session.lock'))).toBe(false);
  });
});

let home = '';
describe('B: links and index locks across checkout folders', () => {
  afterEach(() => { if (home) SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/topic-worktree-reclaim-locks.test.ts' }); home = ''; });

  function repoWithWorktrees(): { home: string; topicDir: string; agentDir: string; topic: string; agent: string } {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'twr-b-'));
    const git = (...a: string[]) => SafeGitExecutor.execSync(['-C', home, ...a], { cwd: home, stdio: 'pipe', operation: 'tests/unit/topic-worktree-reclaim-locks.test.ts:repo' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
    const topicDir = path.join(home, '.instar', 'worktrees');
    const agentDir = path.join(home, '.worktrees');
    const topic = path.join(topicDir, 'topic-1-x');
    const agent = path.join(agentDir, 'feat');
    git('worktree', 'add', '-q', '-b', 'topic/1-x', topic);
    git('worktree', 'add', '-q', '-b', 'feat', agent);
    return { home, topicDir, agentDir, topic, agent };
  }

  it('a link from a .worktrees checkout into a topic worktree keeps the topic worktree in use', async () => {
    const r = repoWithWorktrees();
    fs.symlinkSync(path.join(r.topic, 'somewhere'), path.join(r.agent, 'node_modules'));
    const idx = await buildInboundLinkIndex(r.home, r.topicDir, { extraWorktreesDirs: [r.agentDir] });
    expect(idx).not.toBeNull();
    expect([...idx!.linked].map((p) => path.basename(p))).toContain('topic-1-x');
    const without = await buildInboundLinkIndex(r.home, r.topicDir);
    expect([...without!.linked]).toHaveLength(0);
  });

  it('a linked worktree with an index lock in its git directory is in use', async () => {
    const r = repoWithWorktrees();
    const deps = makeAgentWorktreeReaperDeps({ instarRepo: r.home, worktreesDir: r.agentDir, agentHome: r.home, githubMergeCheck: false, cwdRoots: () => new Set(), commandLines: () => [], inboundLinks: async () => new Set() });
    await deps.preparePass?.();
    expect(deps.isInUse(r.agent)).toBe(false);
    const gitDir = fs.readFileSync(path.join(r.agent, '.git'), 'utf-8').replace(/^gitdir:\s*/, '').trim();
    fs.writeFileSync(path.join(path.resolve(r.agent, gitDir), 'index.lock'), '');
    expect(deps.isInUse(r.agent)).toBe(true);
  });
});

describe('C: dependency copies are marked', () => {
  it('exports the marker name the measurement reads', () => {
    expect(DEPS_COPY_MARKER).toBe('.instar-deps-copy');
  });
});

describe('B: command lines naming a topic worktree', () => {
  afterEach(() => { if (home) SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/topic-worktree-reclaim-locks.test.ts:cl' }); home = ''; });
  it('a process naming .instar/worktrees/<slug> keeps the checkout in use', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'twr-cl-'));
    const p = path.join(home, '.instar', 'worktrees', 'topic-3-x');
    fs.mkdirSync(p, { recursive: true });
    const deps = makeAgentWorktreeReaperDeps({ instarRepo: home, worktreesDir: path.join(home, '.instar', 'worktrees'), agentHome: home, ignoreSessionLockFile: true, githubMergeCheck: false, cwdRoots: () => new Set(), inboundLinks: async () => new Set(), commandLines: () => ['node run.js --cwd .instar/worktrees/topic-3-x'] });
    await deps.preparePass?.();
    expect(deps.isInUse(p)).toBe(true);
  });
});
