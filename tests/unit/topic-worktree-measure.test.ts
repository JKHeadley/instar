/**
 * topic-worktree-reclaim D: the read-only measurement. One real repo with topic
 * worktrees covering every bucket and out-of-scope reason the spec names.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { measureTopicWorktrees, classifyStatus, isTopicResidue } from '../../src/monitoring/topicWorktreeMeasure.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let home = '';
afterEach(() => { if (home) SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/topic-worktree-measure.test.ts' }); home = ''; });

function setup() {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'twr-d-')));
  const stateDir = path.join(home, '.instar');
  const topicDir = path.join(stateDir, 'worktrees');
  fs.mkdirSync(topicDir, { recursive: true });
  const git = (cwd: string, ...a: string[]) => SafeGitExecutor.execSync(['-C', cwd, ...a], { cwd, stdio: 'pipe', operation: 'tests/unit/topic-worktree-measure.test.ts:git' });
  git(home, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(home, 'package-lock.json'), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(home, '.gitignore'), 'node_modules/\n.husky/_/\n');
  git(home, 'add', '.');
  git(home, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');
  const history: string[] = [];
  const mk = (name: string, opts: { history?: boolean; context?: boolean } = {}) => {
    const p = path.join(topicDir, name);
    git(home, 'worktree', 'add', '-q', '-b', `topic/${name}`, p);
    if (opts.history !== false) history.push(JSON.stringify({ kind: 'binding-created', machineId: 'mx', worktreePath: p }) + '\tsig');
    if (opts.context !== false) { fs.mkdirSync(path.join(p, '.instar'), { recursive: true }); fs.writeFileSync(path.join(p, '.instar', 'session-context.json'), '{}'); }
    fs.writeFileSync(path.join(p, '.session.lock'), '{}');
    return p;
  };
  const clean = mk('topic-1-clean');
  const marked = mk('topic-2-marked');
  fs.mkdirSync(path.join(marked, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(marked, 'node_modules', '.instar-deps-copy'), '{}');
  const unmarked = mk('topic-3-unmarked');
  fs.mkdirSync(path.join(unmarked, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(unmarked, 'node_modules', 'x', 'index.js'), '');
  const dirty = mk('topic-4-dirty');
  fs.writeFileSync(path.join(dirty, 'notes.md'), 'work');
  const unmerged = mk('topic-5-unmerged');
  fs.writeFileSync(path.join(unmerged, 'f.txt'), 'x');
  git(unmerged, 'add', 'f.txt');
  git(unmerged, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'unmerged work');
  const inuse = mk('topic-6-inuse');
  mk('topic-7-noprov', { history: false });
  mk('topic-8-creating', { context: false });
  fs.mkdirSync(path.join(topicDir, 'aa-handmade'));
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state', 'sessions', 's1.json'), JSON.stringify({ status: 'running', cwd: inuse }));
  fs.writeFileSync(path.join(stateDir, 'state', 'binding-history-log.jsonl'), history.join('\n') + '\n');
  return { stateDir, clean };
}

const base = (stateDir: string, over: Record<string, unknown> = {}) => ({
  agentHome: home, stateDir, projectDir: home, worktreeMachineId: 'mx', githubMergeCheck: false,
  deadlineAt: Date.now() + 120_000, sizeOf: async () => 1000, ...over,
});

describe('measureTopicWorktrees', () => {
  it('sorts every entry into its bucket or reason, and audits the eligible ones', async () => {
    const { stateDir } = setup();
    const plan = await measureTopicWorktrees(base(stateDir));
    expect(plan.partial).toBe(false);
    expect(plan.eligible.count).toBe(1);
    expect(plan.eligibleIfMarkedDepsAccepted.count).toBe(1);
    expect(plan.eligibleIfUnmarkedDepsAccepted.count).toBe(1);
    expect(plan.kept['work-files']).toBe(1);
    expect(plan.kept.unmerged).toBe(1);
    expect(plan.kept['in-use']).toBe(1);
    expect(plan.kept.creating).toBe(1);
    expect(plan.outOfScope['no-provenance-record']).toBe(1);
    expect(plan.outOfScope['hand-made']).toBe(1);
    expect(plan.audit.agrees).toBe(3);
    expect(plan.falseEligibility.count).toBe(0);
    expect(plan.eligible.bytes).toBe(1000);
    const rows = JSON.parse(fs.readFileSync(path.join(stateDir, 'local-state', 'topic-worktree-plan.json'), 'utf8')).rows;
    expect(rows.length).toBe(8);
  });

  it('a passed deadline measures nothing and marks the row partial', async () => {
    const { stateDir } = setup();
    const plan = await measureTopicWorktrees(base(stateDir, { deadlineAt: Date.now() - 1 }));
    expect(plan.partial).toBe(true);
    // Past the deadline even the worktree listing is refused, so the count is unknown (-1), never 0.
    expect(plan.notMeasured).toBe(-1);
    expect(plan.eligible.count).toBe(0);
  });

  it('an unparsable session record keeps every entry in use', async () => {
    const { stateDir } = setup();
    fs.writeFileSync(path.join(stateDir, 'state', 'sessions', 'bad.json'), '{not json');
    const plan = await measureTopicWorktrees(base(stateDir));
    expect(plan.eligible.count + plan.eligibleIfMarkedDepsAccepted.count + plan.eligibleIfUnmarkedDepsAccepted.count).toBe(0);
  });

  it('history from another machine is not provenance here', async () => {
    const { stateDir } = setup();
    const plan = await measureTopicWorktrees(base(stateDir, { worktreeMachineId: 'other' }));
    expect(plan.outOfScope['no-provenance-record']).toBe(8);
  });
});

describe('residue', () => {
  it('only WorktreeManager-written files are residue', () => {
    expect(isTopicResidue('.session.lock')).toBe(true);
    expect(isTopicResidue('.session.lock.tmp.123')).toBe(true);
    expect(isTopicResidue('.instar/session-context.json')).toBe(true);
    expect(isTopicResidue('.husky/_/pre-commit')).toBe(true);
    expect(isTopicResidue('notes.md')).toBe(false);
    expect(classifyStatus('?? notes.md\0!! .husky/_/\0', '/nowhere').work).toEqual(['notes.md']);
  });
});

describe('measureTopicWorktrees audit and gates', () => {
  // A topic branch with two commits, squash-merged onto main as one commit (cherry cannot see it).
  function squashSetup(opts: { mergeCommitOnMain: boolean; base?: string }) {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'twr-sq-')));
    const stateDir = path.join(home, '.instar');
    const topicDir = path.join(stateDir, 'worktrees');
    fs.mkdirSync(topicDir, { recursive: true });
    const git = (cwd: string, ...a: string[]) => SafeGitExecutor.execSync(['-C', cwd, ...a], { cwd, stdio: 'pipe', operation: 'tests/unit/topic-worktree-measure.test.ts:sq' }).toString();
    const read = (cwd: string, ...a: string[]) => String(SafeGitExecutor.readSync(['-C', cwd, ...a], { cwd, encoding: 'utf-8', operation: 'tests/unit/topic-worktree-measure.test.ts:sq' }));
    const c = (cwd: string, m: string) => git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', m);
    git(home, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(home, 'package-lock.json'), '{}\n');
    fs.writeFileSync(path.join(home, '.gitignore'), 'node_modules/\n');
    git(home, 'add', '.'); c(home, 'base');
    const p = path.join(topicDir, 'topic-9-sq');
    git(home, 'worktree', 'add', '-q', '-b', 'topic/sq', p);
    fs.writeFileSync(path.join(p, 'a.txt'), 'a\n'); git(p, 'add', 'a.txt'); c(p, 'one');
    fs.writeFileSync(path.join(p, 'a.txt'), 'a\nb\n'); git(p, 'add', 'a.txt'); c(p, 'two');
    const head = read(p, 'rev-parse', 'HEAD').trim();
    let merge = 'f'.repeat(40);
    if (opts.mergeCommitOnMain) {
      fs.writeFileSync(path.join(home, 'a.txt'), 'a\nb\n'); git(home, 'add', 'a.txt'); c(home, 'squash of topic/sq');
      merge = read(home, 'rev-parse', 'HEAD').trim();
    }
    fs.mkdirSync(path.join(p, '.instar'), { recursive: true }); fs.writeFileSync(path.join(p, '.instar', 'session-context.json'), '{}');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state', 'binding-history-log.jsonl'), JSON.stringify({ kind: 'binding-created', machineId: 'mx', worktreePath: p }) + '\tsig\n');
    const runGh = (args: string[]) => {
      if (!args.includes('merged')) return '[]';
      return JSON.stringify([{ headRefName: 'topic/sq', headRefOid: head, baseRefName: opts.base ?? 'main', mergeCommit: { oid: merge } }]);
    };
    return { stateDir, runGh };
  }

  it('(l) squash-merged with the merge commit present: eligible, audit agrees (corroborated)', async () => {
    const { stateDir, runGh } = squashSetup({ mergeCommitOnMain: true });
    const plan = await measureTopicWorktrees({ ...base(stateDir), githubMergeCheck: true, runGh });
    expect(plan.eligible.count).toBe(1);
    expect(plan.audit.agrees).toBe(1);
  });

  it('(l2) squash-merged with the merge commit absent locally: audit could not verify', async () => {
    const { stateDir, runGh } = squashSetup({ mergeCommitOnMain: false });
    const plan = await measureTopicWorktrees({ ...base(stateDir), githubMergeCheck: true, runGh });
    expect(plan.audit.couldNotVerify).toBe(1);
    expect(plan.falseEligibility.count).toBe(0);
  });

  it('(m) a PR merged into another branch does not count: unmerged', async () => {
    const { stateDir, runGh } = squashSetup({ mergeCommitOnMain: false, base: 'release-1' });
    const plan = await measureTopicWorktrees({ ...base(stateDir), githubMergeCheck: true, runGh });
    expect(plan.kept.unmerged).toBe(1);
  });

  it('(j) an unreadable sessions directory keeps every entry in use', async () => {
    const { stateDir } = setup();
    SafeFsExecutor.safeRmSync(path.join(stateDir, 'state', 'sessions'), { recursive: true, force: true, operation: 'tests/unit/topic-worktree-measure.test.ts:j' });
    fs.writeFileSync(path.join(stateDir, 'state', 'sessions'), 'not a directory');
    const plan = await measureTopicWorktrees(base(stateDir));
    expect(plan.eligible.count + plan.eligibleIfMarkedDepsAccepted.count + plan.eligibleIfUnmarkedDepsAccepted.count).toBe(0);
  });

  it('no WorktreeManager machine id: provenance is unreadable, nothing in scope', async () => {
    const { stateDir } = setup();
    const plan = await measureTopicWorktrees(base(stateDir, { worktreeMachineId: null }));
    expect(plan.outOfScope['provenance-unreadable']).toBe(8);
  });
});
