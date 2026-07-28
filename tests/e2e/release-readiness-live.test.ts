/**
 * E2E — ReleaseReadinessSentinel against REAL I/O (release-readiness-visibility).
 *
 * The "feature is alive" proof: a real fixture instar repo (real git history +
 * a real blocking NEXT.md), a real canonical remote, the REAL wiring
 * (buildReleaseReadinessDeps → real git fetch + real analyze-release.js
 * subprocess + real merge-base), driving a real sentinel tick. Only the
 * Attention HTTP sink is captured (so we can assert without standing up a
 * server). Reproduces the original silent stall and shows it now surfaces.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { buildReleaseReadinessDeps } from '../../src/monitoring/releaseReadinessWiring.js';
import { ReleaseReadinessSentinel, type AttentionItem } from '../../src/monitoring/ReleaseReadinessSentinel.js';

const REAL_SCRIPT = path.resolve(__dirname, '../../scripts/analyze-release.js');

describe('ReleaseReadinessSentinel — real I/O E2E', () => {
  let repo: string;
  let canon: string;

  function git(cwd: string, args: string[], env?: Record<string, string>): string {
    const prev: Record<string, string | undefined> = {};
    if (env) for (const k of Object.keys(env)) { prev[k] = process.env[k]; process.env[k] = env[k]; }
    try {
      return SafeGitExecutor.run(args, { cwd, operation: 'tests/e2e/release-readiness-live.test.ts:git' });
    } finally {
      if (env) for (const k of Object.keys(env)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    }
  }

  function commit(msg: string, file: string, daysAgo = 0): void {
    const full = path.join(repo, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `${file}\n${msg}\n`);
    git(repo, ['add', '-A']);
    const date = new Date(Date.now() - daysAgo * 86400_000).toISOString();
    git(repo, ['commit', '-m', msg], { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date });
  }

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-e2e-repo-'));
    canon = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-e2e-canon-'));

    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.copyFileSync(REAL_SCRIPT, path.join(repo, 'scripts', 'analyze-release.js'));
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', version: '9.9.9', type: 'module' }, null, 2));
    fs.mkdirSync(path.join(repo, 'upgrades'), { recursive: true });

    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'fixture@instar.local']);
    git(repo, ['config', 'user.name', 'Fixture']);
    git(repo, ['config', 'commit.gpgsign', 'false']);

    commit('chore: initial', 'README.md', 10);
    git(repo, ['tag', 'v0.0.1']);
    // Two unreleased feature commits, the oldest 5 days ago (past the 2-day silent threshold).
    commit('feat: add alpha endpoint', 'src/server/routes.ts', 5);
    commit('feat: add beta endpoint', 'src/server/extra.ts', 4);
    // A NEXT.md that BLOCKS publishing (still carries an auto-draft-unreviewed marker).
    fs.writeFileSync(
      path.join(repo, 'upgrades', 'NEXT.md'),
      '# Upgrade Guide — vNEXT\n<!-- bump: minor -->\n## What Changed\n<!-- auto-draft-unreviewed: what-changed -->\n- stuff\n',
    );
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'chore: seed NEXT.md'], { GIT_COMMITTER_DATE: new Date(Date.now() - 4 * 86400_000).toISOString() });

    // Canonical remote: a bare repo we push main to, registered as a remote.
    git(canon, ['init', '-q', '--bare']);
    git(repo, ['remote', 'add', 'canon', `file://${canon}`]);
    git(repo, ['push', '-q', 'canon', 'main']);
  });

  afterEach(() => {
    for (const d of [repo, canon]) {
      SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/release-readiness-live.test.ts:afterEach' });
    }
  });

  it('real git + real analyzer + real fetch → one Attention signal for the aged, blocked backlog', async () => {
    const posted: AttentionItem[] = [];
    const deps = buildReleaseReadinessDeps({
      repoPath: repo,
      statePath: path.join(repo, '.instar', 'state', 'release-readiness.json'),
      auditPath: path.join(repo, '.instar', 'logs', 'sentinel-events.jsonl'),
      port: 0,
      authToken: 'x',
      canonicalRemote: 'canon',
    });
    // Capture the Attention sink; keep ALL other deps real (git/analyzer/state).
    deps.postAttention = async (i) => { posted.push(i); return true; };

    const sentinel = new ReleaseReadinessSentinel(deps, { enabled: true });
    await sentinel.tick();

    // Real pipeline detected the blocked, aged backlog and surfaced exactly one signal.
    expect(posted).toHaveLength(1);
    expect(posted[0].title).toContain('Release blocked');
    expect(posted[0].priority === 'MEDIUM' || posted[0].priority === 'LOW' || posted[0].priority === 'HIGH').toBe(true);

    // State persisted to disk with an open episode keyed on a real commit sha.
    const state = deps.loadState();
    const open = state.episodes.filter((e) => !e.resolvedMs);
    expect(open).toHaveLength(1);
    expect(open[0].oldestSha).toMatch(/^[0-9a-f]{40}$/);
    expect(state.lastTickAt).toBeGreaterThan(0);

    // Re-tick is idempotent (deduped on the real sha).
    await sentinel.tick();
    expect(posted).toHaveLength(1);
  }, 30_000);

  it('real analyzer reports the unreleased feature commits since the tag', async () => {
    const deps = buildReleaseReadinessDeps({
      repoPath: repo, statePath: path.join(repo, '.instar', 's.json'), auditPath: path.join(repo, '.instar', 'a.jsonl'),
      port: 0, authToken: 'x', canonicalRemote: 'canon',
    });
    const fetched = await deps.fetchCanonical();
    expect(fetched.ok).toBe(true);
    const report = await deps.runAnalyzer(fetched.headSha ?? 'FETCH_HEAD');
    expect(report).not.toBeNull();
    expect(report!.analysis.commitClassification.features).toBeGreaterThanOrEqual(2);
    expect(await deps.guideBlocksPublish()).toBe(true); // unreviewed marker present
  }, 30_000);
});
