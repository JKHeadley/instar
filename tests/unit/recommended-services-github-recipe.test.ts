/**
 * The GitHub private-backup recipe (docs/specs/recommended-services.md, First recipes: GitHub).
 *
 * A new private repository, a check that proves it is private and that the copy matches this machine,
 * pushes refused to anything public, one attention item when a backup repository has gone public.
 * Both sides of every decision, against a stand-in for GitHub and the state repository.
 */
import { describe, expect, it } from 'vitest';
import { RECOMMENDED_SERVICE_CATALOG } from '../../src/recommended/catalog.js';
import { SETUP_RECIPES, catalogWithProving, recipeFor, type StopDeps, type SyncDeps } from '../../src/recommended/recipes.js';
import { backupRepoName, parseGitHubRepo, type GitHubBackupSurface, type GitHubRepoInfo } from '../../src/recommended/githubBackup.js';

const recipe = SETUP_RECIPES.find((r) => r.id === 'github-v1')!;

function fakeGitHub(over: Partial<{ owner: string | null | undefined; repos: Record<string, GitHubRepoInfo>; createFails: boolean; pushFails: boolean; remote: string | null; localHead: string | null; remoteHead: string | null | undefined; down: boolean }> = {}) {
  const state = { owner: 'octo' as string | null | undefined, repos: {} as Record<string, GitHubRepoInfo>, createFails: false, pushFails: false, remote: null as string | null, localHead: 'aaaa' as string | null, remoteHead: undefined as string | null | undefined, down: false, ...over };
  const created: string[] = [];
  const pushes: string[] = [];
  const surface: GitHubBackupSurface = {
    tokenOwner: async (token) => (state.down ? undefined : token === 'tok' ? state.owner : null),
    repo: async (_t, fullName) => (state.down ? undefined : state.repos[fullName] ?? null),
    createPrivateRepo: async (_t, name) => {
      if (state.createFails) return null;
      const info = { fullName: `octo/${name}`, private: true, htmlUrl: `https://github.com/octo/${name}`, cloneUrl: `https://github.com/octo/${name}.git` };
      state.repos[info.fullName] = info; created.push(info.fullName); return info;
    },
    pushState: (_t, cloneUrl) => { if (state.pushFails) return null; pushes.push(cloneUrl); state.remote = cloneUrl; state.remoteHead = state.localHead; return { head: state.localHead ?? 'aaaa' }; },
    remoteHead: async () => state.remoteHead,
    localHead: () => state.localHead,
    currentRemote: () => state.remote,
  };
  return { surface, created, pushes, state };
}
const secrets = (names: Record<string, string>) => (n: string) => names[n] ?? null;
const PRIVATE: GitHubRepoInfo = { fullName: 'octo/instar-echo-state', private: true, htmlUrl: 'https://github.com/octo/instar-echo-state', cloneUrl: 'https://github.com/octo/instar-echo-state.git' };

describe('GitHub backup recipe: the check', () => {
  it('passes when the repository is private and the copy on GitHub matches this machine', async () => {
    const g = fakeGitHub({ repos: { [PRIVATE.fullName]: PRIVATE }, remote: PRIVATE.cloneUrl, remoteHead: 'aaaa' });
    const out = await recipe.verify({ readSecret: secrets({ github_backup_token: 'tok' }), github: g.surface, agentName: 'echo' });
    expect(out).toEqual({ result: 'pass', detail: 'The private repository octo/instar-echo-state holds this agent\'s backup, matching this machine.' });
  });

  it('is absent with no token and no repository, so setup starts; a set repository without a token is not absent', async () => {
    expect(await recipe.verify({ readSecret: () => null, github: fakeGitHub().surface, agentName: 'echo' })).toMatchObject({ result: 'fail', absent: true });
    const set = await recipe.verify({ readSecret: () => null, github: fakeGitHub({ remote: PRIVATE.cloneUrl }).surface, agentName: 'echo' });
    expect(set).toMatchObject({ result: 'fail' });
    expect(set.absent).toBe(false);
  });

  it('finds the repository by the agent\'s name when no remote is set yet, and says it does not exist', async () => {
    const out = await recipe.verify({ readSecret: secrets({ github_backup_token: 'tok' }), github: fakeGitHub().surface, agentName: 'echo' });
    expect(out).toMatchObject({ result: 'fail', absent: true, detail: 'The backup repository octo/instar-echo-state does not exist yet.' });
  });

  it('a public repository fails the check and asks for one attention item naming the fix', async () => {
    const pub = { ...PRIVATE, private: false };
    const out = await recipe.verify({ readSecret: secrets({ github_backup_token: 'tok' }), github: fakeGitHub({ repos: { [pub.fullName]: pub }, remote: pub.cloneUrl }).surface, agentName: 'echo' });
    expect(out.result).toBe('fail');
    expect(out.attention).toMatchObject({ id: 'recommended-service-public-repo:octo/instar-echo-state' });
    expect(out.attention!.text).toMatch(/Make it private/);
    expect(out.absent).toBeUndefined();
  });

  it('a copy that is behind or an empty remote fails; GitHub not answering is unknown, never a fail', async () => {
    const behind = await recipe.verify({ readSecret: secrets({ github_backup_token: 'tok' }), github: fakeGitHub({ repos: { [PRIVATE.fullName]: PRIVATE }, remote: PRIVATE.cloneUrl, remoteHead: 'bbbb' }).surface, agentName: 'echo' });
    expect(behind).toMatchObject({ result: 'fail', detail: 'The copy on GitHub is behind this machine (different).' });
    const empty = await recipe.verify({ readSecret: secrets({ github_backup_token: 'tok' }), github: fakeGitHub({ repos: { [PRIVATE.fullName]: PRIVATE }, remote: PRIVATE.cloneUrl, remoteHead: null }).surface, agentName: 'echo' });
    expect(empty.detail).toMatch(/empty/);
    const down = await recipe.verify({ readSecret: secrets({ github_backup_token: 'tok' }), github: fakeGitHub({ down: true }).surface, agentName: 'echo' });
    expect(down).toMatchObject({ result: 'unknown' });
    expect((await recipe.verify({ readSecret: secrets({ github_backup_token: 'tok' }), github: fakeGitHub({ repos: { [PRIVATE.fullName]: PRIVATE }, remote: PRIVATE.cloneUrl, remoteHead: undefined }).surface, agentName: 'echo' })).result).toBe('unknown');
    expect((await recipe.verify({ readSecret: secrets({ github_backup_token: 'tok' }) })).result).toBe('unknown');
  });

  it('a refused token fails plainly, and no detail ever carries the token', async () => {
    const out = await recipe.verify({ readSecret: secrets({ github_backup_token: 'nope-secret-9' }), github: fakeGitHub().surface, agentName: 'echo' });
    expect(out).toMatchObject({ result: 'fail', detail: 'GitHub refused the stored token.' });
    expect(out.detail).not.toContain('nope-secret-9');
  });
});

describe('GitHub backup recipe: the push', () => {
  const deps = (g: ReturnType<typeof fakeGitHub>, token = 'tok'): SyncDeps => ({ readSecret: secrets({ github_backup_token: token }), github: g.surface, agentName: 'echo', secretNames: () => [] });

  it('creates the private repository under the token\'s account when none exists, then pushes', async () => {
    const g = fakeGitHub();
    const out = await recipe.sync!(deps(g));
    expect(g.created).toEqual(['octo/instar-echo-state']);
    expect(g.pushes).toEqual(['https://github.com/octo/instar-echo-state.git']);
    expect(out).toMatchObject({ ok: true, copied: ['octo/instar-echo-state'] });
  });

  it('never pushes to a public repository, and says so', async () => {
    const pub = { ...PRIVATE, private: false };
    const g = fakeGitHub({ repos: { [pub.fullName]: pub }, remote: pub.cloneUrl });
    const out = await recipe.sync!(deps(g));
    expect(g.pushes).toEqual([]);
    expect(out).toMatchObject({ ok: false, copied: [] });
    expect(out.detail).toMatch(/public, so nothing was pushed/);
  });

  it('reports a refused token, a failed create, a failed push, and GitHub not answering, each without pushing', async () => {
    expect((await recipe.sync!(deps(fakeGitHub(), 'bad'))).detail).toBe('GitHub refused the stored token.');
    expect((await recipe.sync!(deps(fakeGitHub({ createFails: true })))).detail).toMatch(/refused to create/);
    const g = fakeGitHub({ pushFails: true });
    const out = await recipe.sync!(deps(g));
    expect(out).toMatchObject({ ok: false, copied: ['octo/instar-echo-state'] });
    expect(out.detail).toMatch(/push to octo\/instar-echo-state failed/);
    expect((await recipe.sync!(deps(fakeGitHub({ down: true })))).detail).toBe('GitHub did not answer.');
    expect((await recipe.sync!({ readSecret: () => null, github: fakeGitHub().surface, secretNames: () => [] })).detail).toBe('No GitHub token is stored yet.');
  });

  it('a remote this machine already points at is used as is, and a vanished one is reported, not recreated', async () => {
    const g = fakeGitHub({ repos: { [PRIVATE.fullName]: PRIVATE }, remote: PRIVATE.cloneUrl });
    expect((await recipe.sync!(deps(g))).ok).toBe(true);
    expect(g.created).toEqual([]);
    const gone = fakeGitHub({ remote: 'https://github.com/octo/old-state.git' });
    const out = await recipe.sync!(deps(gone));
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/octo\/old-state this machine points at does not exist/);
    expect(gone.created).toEqual([]);
  });
});

describe('GitHub backup recipe: switching off', () => {
  const deps = (over: Partial<StopDeps>): StopDeps => ({ readSecret: () => null, deleteSecret: () => undefined, setUpHere: true, ...over });

  it('removes the stored token, turns the config switch off, and says the repository stays', async () => {
    const deleted: string[] = []; let disabled = 0;
    const out = await recipe.stop(deps({ readSecret: secrets({ github_backup_token: 'tok' }), deleteSecret: (n) => { deleted.push(n); }, disableGitBackup: () => { disabled++; } }));
    expect(deleted).toEqual(['github_backup_token']);
    expect(disabled).toBe(1);
    expect(out).toMatchObject({ stopped: true, changed: true });
    expect(out.detail).toMatch(/private repository and what is in it stay yours/);
  });

  it('leaves everything when setup did not do it', async () => {
    let deleted = 0;
    const out = await recipe.stop(deps({ setUpHere: false, readSecret: secrets({ github_backup_token: 'tok' }), deleteSecret: () => { deleted++; } }));
    expect(deleted).toBe(0);
    expect(out).toMatchObject({ stopped: true, changed: false });
  });
});

describe('GitHub backup recipe: the brief, the names, and the catalog', () => {
  const brief = recipe.brief({ port: 4321 });

  it('is dark: proving agents only, until its live proof', () => {
    expect(recipe.service).toBe('github-state-backup');
    expect(recipe.secretName).toBe('github_backup_token');
    expect(RECOMMENDED_SERVICE_CATALOG.find((r) => r.id === 'github-state-backup')!.setupRecipe).toBeNull();
    expect(recipeFor(catalogWithProving(['github-v1'], () => true).find((r) => r.id === 'github-state-backup')!)?.id).toBe('github-v1');
    expect(catalogWithProving(['github-v1'], () => false).find((r) => r.id === 'github-state-backup')!.setupRecipe).toBeNull();
  });

  it('keeps the token out of chat, files and commands, and the push out of the session', () => {
    expect(brief).toContain('/recommended-services/github-state-backup/sync');
    expect(brief).toContain('never through echo, cat or a file');
    expect(brief).toContain('You never run git against the agent\'s state folder yourself');
    expect(brief).toContain('refuses to push to a repository that is not private');
    expect(brief).toContain('They never open a browser');
    expect(brief).not.toMatch(/ask (the person|them) to (open|go|visit|sign|run|paste|get|fetch)/i);
  });

  it('names the repository after the agent, and reads owner/name from GitHub URLs only', () => {
    expect(backupRepoName('echo')).toBe('instar-echo-state');
    expect(backupRepoName('My Agent (2)')).toBe('instar-my-agent-2-state');
    expect(parseGitHubRepo('https://github.com/octo/instar-echo-state.git')).toBe('octo/instar-echo-state');
    expect(parseGitHubRepo('git@github.com:octo/instar-echo-state.git')).toBe('octo/instar-echo-state');
    expect(parseGitHubRepo('https://gitlab.com/octo/x.git')).toBeNull();
    expect(parseGitHubRepo('https://github.com/octo')).toBeNull();
  });
});
