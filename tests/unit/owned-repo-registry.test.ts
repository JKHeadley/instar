/**
 * The owned-repository registry, increment 1 (docs/specs/no-data-loss-on-machine-death.md §1.1–1.4, §1.7).
 * Real git repositories on a real disk: a fixture shaped like Echo's home, where `apps/` is untracked
 * and holds the Apple and Android app repositories with no remote (what was lost on 2026-11-20).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnedRepoRegistry, defectsFor, mainWorktreeRoot, OWNED_REPO_DEFAULTS } from '../../src/monitoring/ownedRepos/OwnedRepoRegistry.js';
import { readGit } from '../../src/monitoring/ownedRepos/repoGit.js';
import { parseRemoteUrl, inspectRepo } from '../../src/monitoring/ownedRepos/repoInspect.js';
import { isExcludedPath } from '../../src/monitoring/ownedRepos/repoDiscovery.js';
import { validateOwnedRepoReplica, ownedRepoStoreSchema, deriveOwnedRepoRecordKey, bucket, OWNED_REPO_KIND_REGISTRATION, type OwnedRepoReplica } from '../../src/core/OwnedRepoReplicatedStore.js';
import { repoBirthPath, SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const DAY = 86_400_000;
let userHome: string;

function git(cwd: string, args: string[], date?: Date) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...(date ? { GIT_AUTHOR_DATE: date.toISOString(), GIT_COMMITTER_DATE: date.toISOString() } : {}) };
  return SafeGitExecutor.run(args, { cwd, env, operation: 'tests/unit/owned-repo-registry.test.ts' });
}
function repo(dir: string, opts: { commitAt?: Date; file?: string } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, opts.file ?? 'README.md'), `hello ${dir}\n`);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'first'], opts.commitAt);
  return dir;
}

beforeEach(() => { userHome = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.instar-test-owned-repos-'))); });
afterEach(() => { SafeFsExecutor.safeRmSync(userHome, { recursive: true, force: true, operation: 'tests/unit/owned-repo-registry.test.ts' }); });

/** A fixture shaped like Echo's home. */
function echoLikeHome() {
  const home = path.join(userHome, '.instar', 'agents', 'echo');
  const old = new Date(Date.now() - 3 * DAY);
  // A bare "remote" that is NOT on this machine is simulated by a remote-tracking ref named for a github URL.
  repo(home, { commitAt: old });
  fs.writeFileSync(path.join(home, '.gitignore'), 'node_modules/\n.instar/\nignored-area/\n');
  git(home, ['add', '.gitignore']); git(home, ['commit', '-q', '-m', 'ignore'], old);
  git(home, ['remote', 'add', 'origin', 'https://user:secret-token@github.com/JKHeadley/instar.git']);
  git(home, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  // An unpushed branch, three days old.
  git(home, ['checkout', '-q', '-b', 'feature-x']);
  fs.writeFileSync(path.join(home, 'x.txt'), 'x\n'); git(home, ['add', 'x.txt']); git(home, ['commit', '-q', '-m', 'x'], old);
  git(home, ['checkout', '-q', 'main']);
  // apps/ is untracked: git folds it into one entry.
  repo(path.join(home, 'apps', 'instar-ios'), { commitAt: old });
  repo(path.join(home, 'apps', 'instar-android'), { commitAt: old });
  // Nested two levels under an untracked directory, and one under an ignored directory.
  repo(path.join(home, 'scratch', 'a', 'deep-repo'), { commitAt: old });
  repo(path.join(home, 'ignored-area', 'kept'), { commitAt: old });
  // Regenerable directories are pruned.
  repo(path.join(home, 'node_modules', 'pkg'), { commitAt: old });
  // A linked worktree of the home repository is part of the home record, not a repository of its own.
  fs.mkdirSync(path.join(home, '.instar', 'worktrees'), { recursive: true });
  git(home, ['worktree', 'add', '-q', path.join(home, '.instar', 'worktrees', 'wt1'), '-b', 'wt-branch']);
  return home;
}

function make(home: string, over: Partial<ConstructorParameters<typeof OwnedRepoRegistry>[0]> = {}) {
  const emitted: OwnedRepoReplica[] = [];
  const reg = new OwnedRepoRegistry({
    machineId: 'm_studio', machineName: () => 'Mac Studio', agentHome: home, userHome,
    stateFile: path.join(home, '.instar', 'state', 'owned-repos', 'm_studio.json'),
    git: readGit, roots: () => [], declaredRoots: () => [], otherAgentHomes: () => [],
    emit: (r) => emitted.push(r), ...over,
  });
  return { reg, emitted };
}

describe('discovery on a fixture shaped like Echo\'s home', () => {
  it('finds apps/instar-ios and apps/instar-android, and nested repositories under untracked and ignored folders', async () => {
    const home = echoLikeHome();
    const { reg } = make(home);
    await reg.tick();
    const st = reg.status();
    const paths = st.repos.map((r) => r.path).sort();
    expect(paths).toContain(path.join(home, 'apps', 'instar-ios'));
    expect(paths).toContain(path.join(home, 'apps', 'instar-android'));
    expect(paths).toContain(path.join(home, 'scratch', 'a', 'deep-repo'));
    expect(paths).toContain(path.join(home, 'ignored-area', 'kept'));
    expect(paths).toContain(home);
    // Pruned: regenerable folders and the home's own linked worktree.
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.includes(path.join('.instar', 'worktrees')))).toBe(false);
    expect(st.scan.state).toBe('complete');
  }, 60_000);

  it('classifies the home as owned and the others as candidates; another agent\'s home is skipped', async () => {
    const home = echoLikeHome();
    const other = path.join(userHome, '.instar', 'agents', 'sagemind');
    repo(other);
    const { reg } = make(home, { roots: () => [other], otherAgentHomes: () => [other] });
    await reg.tick();
    const st = reg.status();
    expect(st.repos.find((r) => r.path === home)?.class).toBe('owned');
    expect(st.repos.find((r) => r.path.endsWith('instar-ios'))?.class).toBe('candidate');
    expect(st.repos.some((r) => r.path === other)).toBe(false);
  }, 60_000);

  it('a repository registered at birth is owned', async () => {
    const home = echoLikeHome();
    const { reg } = make(home);
    reg.noteBirth(path.join(home, 'apps', 'instar-ios'), 'init:test');
    await reg.tick();
    expect(reg.status().repos.find((r) => r.path.endsWith('instar-ios'))?.class).toBe('owned');
  }, 60_000);

  it('session evidence (a working directory inside a repository) registers it; a linked worktree maps to its main repository', async () => {
    const home = path.join(userHome, 'proj-home');
    repo(home);
    const elsewhere = repo(path.join(userHome, 'Projects', 'side-thing'));
    const { reg } = make(home);
    reg.noteSessionPath(path.join(elsewhere, 'src'));
    reg.noteSessionPath('/etc'); // outside the home: never taken
    await reg.tick();
    expect(reg.status().repos.some((r) => r.path === elsewhere)).toBe(true);
    git(home, ['worktree', 'add', '-q', path.join(userHome, 'wt-of-home'), '-b', 'w2']);
    expect(mainWorktreeRoot(path.join(userHome, 'wt-of-home'))).toBe(home);
  }, 60_000);

  it('a busy session inside known repositories never crowds out a new repository elsewhere (reviewer finding)', async () => {
    const home = path.join(userHome, 'busy-home');
    repo(home);
    const { reg } = make(home);
    await reg.tick();
    for (let i = 0; i < 2000; i++) reg.noteSessionPath(path.join(home, `dir${i}`, 'file.ts'));
    expect(reg.status().candidatesQueued).toBe(0);
    expect(reg.status().candidateOverflow).toBe(0);
    const outside = repo(path.join(userHome, 'Projects', 'new-thing'));
    reg.noteSessionPath(path.join(outside, 'main.swift'));
    expect(reg.status().candidatesQueued).toBe(1);
    await reg.tick();
    expect(reg.status().repos.some((r) => r.path === outside)).toBe(true);
  }, 60_000);

  it('an overflowed session queue is reported as unknown, not silently dropped', () => {
    const now = Date.now();
    const scan = { now, enabledSince: now - 2 * DAY, lastCompletedPassAt: now, candidateOverflowAt: now - 3_600_000 };
    expect(defectsFor('m', 'M', [], scan).map((d) => d.kind)).toEqual(['unknown']);
    expect(defectsFor('m', 'M', [], { ...scan, candidateOverflowAt: now - 2 * DAY })).toEqual([]);
  });

  it('never discovers peer copies, the drill or temp', () => {
    expect(isExcludedPath(path.join(userHome, '.instar', 'peer-copies', 'echo', 'm1', 'mirrors', 'x.git'), userHome)).toBe(true);
    expect(isExcludedPath(path.join(userHome, '.instar', 'drill', 'x'), userHome)).toBe(true);
    expect(isExcludedPath(os.tmpdir(), userHome)).toBe(true);
    expect(isExcludedPath(path.join(userHome, 'Projects'), userHome)).toBe(false);
  });
});

describe('single-copy work and defects', () => {
  it('a repository with no remote is single-copy; an unpushed branch is counted; credentials never kept', async () => {
    const home = echoLikeHome();
    const { reg } = make(home);
    await reg.tick();
    const st = reg.status();
    const ios = st.repos.find((r) => r.path.endsWith('instar-ios'))!;
    expect(ios.hasOffMachineRemote).toBe(false);
    expect(ios.singleCopy.commits).toBe(1);
    expect(ios.pastGrace).toBe(true);
    const h = st.repos.find((r) => r.path === home)!;
    expect(h.hasOffMachineRemote).toBe(true);
    expect(h.singleCopy.branchNames).toContain('feature-x');
    expect(h.singleCopy.branchNames).not.toContain('main');
    expect(JSON.stringify(st)).not.toContain('secret-token');
    // One row per machine per kind, never one per repository.
    const kinds = st.defects.map((d) => d.kind).sort();
    expect(kinds).toEqual(['no-remote', 'unpushed']);
    const noRemote = st.defects.find((d) => d.kind === 'no-remote')!;
    expect(noRemote.repos).toContain('~/' + path.relative(userHome, path.join(home, 'apps', 'instar-ios')));
    expect(noRemote.title).toMatch(/Mac Studio/);
  }, 60_000);

  it('work younger than the grace window is listed but not yet a defect (both sides of the boundary)', async () => {
    const home = path.join(userHome, 'fresh-home');
    repo(home, { commitAt: new Date(Date.now() - 2 * 3_600_000) });
    const { reg } = make(home);
    await reg.tick();
    expect(reg.status().repos[0].singleCopy.commits).toBe(1);
    expect(reg.status().defects).toEqual([]);
    const risky = make(home, { atRisk: () => true, stateFile: path.join(home, '.instar', 'state', 'owned-repos', 'risky.json') }).reg;
    await risky.tick();
    expect(risky.graceMs()).toBe(OWNED_REPO_DEFAULTS.atRiskGraceMs);
    expect(risky.status().defects.map((d) => d.kind)).toEqual(['no-remote']);
  }, 60_000);

  it('a local-path remote is not a copy anywhere else', () => {
    expect(parseRemoteUrl('/Users/x/backup.git').offMachine).toBe(false);
    expect(parseRemoteUrl('file:///Users/x/backup.git').offMachine).toBe(false);
    expect(parseRemoteUrl('git@github.com:EchoOfDawn/instar-desktop-apps.git')).toEqual({ host: 'github.com', ownerAccount: 'EchoOfDawn', offMachine: true });
    expect(parseRemoteUrl('https://tok:x@github.com/JKHeadley/instar.git')).toEqual({ host: 'github.com', ownerAccount: 'JKHeadley', offMachine: true });
  });

  it('an unreadable repository is unknown, and only becomes a defect past a day', () => {
    const now = Date.now();
    const base = { displayPath: '~/x', class: 'candidate' as const, state: 'unknown' as const, hasOffMachineRemote: false, pastGrace: false, singleCopy: { commits: 0, branches: 0, oldestAt: null, branchNames: [] } };
    const scan = { now, enabledSince: now - 2 * DAY, lastCompletedPassAt: now };
    expect(defectsFor('m', 'M', [{ ...base, unknownSince: new Date(now - 3_600_000).toISOString() }], scan)).toEqual([]);
    expect(defectsFor('m', 'M', [{ ...base, unknownSince: new Date(now - 2 * DAY).toISOString() }], scan).map((d) => d.kind)).toEqual(['unknown']);
    // A scan that never finished in a day is a defect of its own.
    expect(defectsFor('m', 'M', [], { now, enabledSince: now - 2 * DAY, lastCompletedPassAt: null }).map((d) => d.kind)).toEqual(['unknown']);
    expect(defectsFor('m', 'M', [], { now, enabledSince: now - 3_600_000, lastCompletedPassAt: null })).toEqual([]);
  });

  it('reports committed history and leaves dirty working files unmeasured', async () => {
    const home = repo(path.join(userHome, 'metadata-only'));
    fs.writeFileSync(path.join(home, 'README.md'), 'uncommitted edit');
    const calls: string[] = [];
    const result = await inspectRepo(home, (cwd, args, opts) => {
      calls.push(args[0]);
      return readGit(cwd, args, opts);
    });
    expect(result.state).toBe('ok');
    expect(result.singleCopy.commits).toBe(1);
    expect(result.uncommitted).toEqual({ worktrees: 0, files: 0, bytes: 0, oldestAt: null, complete: false });
    expect(calls).toEqual(['rev-parse', 'remote', 'log', 'log', 'log']);
    expect(await readGit(home, ['status', '--porcelain=v1'])).toEqual({
      ok: false, error: 'git query is outside the owned repository inventory',
    });
    expect(await readGit(home, ['log', '--branches', '--not', '--patch', '--format=%H %ct'])).toMatchObject({ ok: false });
  });

  it('inspect never throws on a non-repository; it answers unknown', async () => {
    const r = await inspectRepo(userHome, readGit);
    expect(r.state).toBe('unknown');
  });
});

describe('replicated records (the owned-repo kind)', () => {
  it('emits disclosure-minimized records: buckets, no URL, no branch names, no timestamps', async () => {
    const home = echoLikeHome();
    const { reg, emitted } = make(home);
    await reg.tick();
    expect(emitted.length).toBeGreaterThanOrEqual(5);
    const s = JSON.stringify(emitted);
    expect(s).not.toContain('secret-token');
    expect(s).not.toContain('feature-x');
    expect(s).not.toMatch(/oldestAt|20\d\d-\d\d-\d\dT/);
    for (const e of emitted) expect(validateOwnedRepoReplica(e)).toEqual(e);
    // Unchanged state is not re-emitted on the next tick.
    const n = emitted.length;
    await reg.tick();
    expect(emitted.length).toBe(n);
  }, 60_000);

  it('the schema refuses a forged origin, a wrong key, a path escape and a URL in a host', () => {
    const rep: OwnedRepoReplica = { repoId: 'a'.repeat(64), machineId: 'm_studio', displayPath: '~/x', class: 'owned', remotes: [{ name: 'origin', host: 'github.com', ownerAccount: 'JK', offMachine: true }], singleCopy: true, singleCopyCommitsBucket: 4, singleCopyBranchesBucket: 1, uncommitted: false, pastGrace: true, state: 'ok', gone: false };
    const key = deriveOwnedRepoRecordKey('m_studio', rep.repoId);
    const ctx = {} as never;
    expect(ownedRepoStoreSchema.validate({ repo: rep, recordKey: key, origin: 'm_studio' }, ctx)).toEqual({ repo: rep });
    expect(ownedRepoStoreSchema.validate({ repo: rep, recordKey: key, origin: 'm_other' }, ctx)).toBeNull();
    expect(ownedRepoStoreSchema.validate({ repo: rep, recordKey: 'b'.repeat(64), origin: 'm_studio' }, ctx)).toBeNull();
    expect(validateOwnedRepoReplica({ ...rep, displayPath: '~/../etc' })).toBeNull();
    expect(validateOwnedRepoReplica({ ...rep, remotes: [{ name: 'o', host: 'u:p@github.com/x', ownerAccount: null, offMachine: true }] })).toBeNull();
    expect(validateOwnedRepoReplica({ ...rep, singleCopyCommitsBucket: 3 })).toBeNull();
    expect(bucket(0)).toBe(0); expect(bucket(1)).toBe(1); expect(bucket(1489)).toBe(1024);
    expect(OWNED_REPO_KIND_REGISTRATION).toMatchObject({ kind: 'owned-repo', store: 'ownedRepo' });
  });
});

describe('registration at birth (SafeGitExecutor observer path parsing)', () => {
  it('names the new repository for init and a remote clone; skips local clones and bare repositories', () => {
    expect(repoBirthPath('init', ['newrepo'], '/u/p')).toBe('/u/p/newrepo');
    expect(repoBirthPath('init', [], '/u/p')).toBe('/u/p');
    expect(repoBirthPath('init', ['--bare', 'x.git'], '/u/p')).toBeNull();
    expect(repoBirthPath('clone', ['--depth', '1', 'https://github.com/a/b.git'], '/u/p')).toBe('/u/p/b');
    expect(repoBirthPath('clone', ['-b', 'dev', 'git@github.com:a/b.git', 'here'], '/u/p')).toBe('/u/p/here');
    expect(repoBirthPath('clone', ['/u/local/repo', 'copy'], '/u/p')).toBeNull();
    expect(repoBirthPath('status', [], '/u/p')).toBeNull();
  });
});
