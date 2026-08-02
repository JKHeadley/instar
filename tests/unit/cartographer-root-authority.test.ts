// safe-git-allow: test fixture setup uses local temporary repositories only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CartographerTree } from '../../src/core/CartographerTree.js';
import {
  CartographerRootAuthority,
  normalizeCartographerGitRemote,
  selectCartographerRootCandidate,
  type CartographerRootCandidate,
  type CartographerRootDecision,
} from '../../src/core/CartographerRootAuthority.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Cartographer Test',
  GIT_AUTHOR_EMAIL: 'cartographer@test.local',
  GIT_COMMITTER_NAME: 'Cartographer Test',
  GIT_COMMITTER_EMAIL: 'cartographer@test.local',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createRepo(
  parent: string,
  name: string,
  remote?: string,
  commit = true,
): string {
  const repo = path.join(parent, name);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  if (remote) git(repo, 'remote', 'add', 'origin', remote);
  fs.writeFileSync(
    path.join(repo, 'src', `${name}.ts`),
    `export const ${name.replace(/\W/g, '_')} = true;\n`,
  );
  if (commit) {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'fixture');
  }
  return repo;
}

function activeCandidate(
  projectDir: string,
  expectedRemote?: string,
): CartographerRootCandidate {
  return {
    kind: 'active-project-checkout',
    requestedPath: projectDir,
    provenance: {
      source: 'topic-binding',
      topicId: 776,
      projectName: 'fixture',
    },
    expectedRemote,
  };
}

function createAuthority(
  decisions: CartographerRootDecision[] = [],
): CartographerRootAuthority {
  return new CartographerRootAuthority({
    recordDecision: (decision) => decisions.push(decision),
    now: () => new Date('2026-08-02T08:00:00.000Z'),
  });
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cartographer-root-authority-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('selectCartographerRootCandidate', () => {
  it('requires a topic binding for a standalone active-project root', () => {
    const selected = selectCartographerRootCandidate({
      kind: 'active-project-checkout',
      standalone: true,
      serverProject: {
        projectDir: path.join(tmp, 'agent-home'),
        projectName: 'agent-home',
      },
    });

    expect(selected).toEqual(
      expect.objectContaining({
        ok: false,
        code: 'topic-binding-required',
      }),
    );
  });

  it('selects the topic-bound checkout and never falls back to a noisy agent home', () => {
    const agentHome = path.join(tmp, 'agent-home');
    fs.mkdirSync(path.join(agentHome, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(agentHome, 'src', 'StaleLookalike.ts'),
      'export const stale = true;\n',
    );
    fs.writeFileSync(path.join(agentHome, 'screenshot.png'), 'noise');
    const project = createRepo(
      tmp,
      'trusted-project',
      'https://github.com/example/trusted-project.git',
    );

    const selected = selectCartographerRootCandidate({
      kind: 'active-project-checkout',
      standalone: true,
      serverProject: { projectDir: agentHome, projectName: 'agent-home' },
      topicBinding: {
        topicId: 776,
        projectDir: project,
        projectName: 'trusted-project',
        gitRemote: 'git@github.com:example/trusted-project.git',
      },
    });

    expect(selected).toEqual({
      ok: true,
      candidate: {
        kind: 'active-project-checkout',
        requestedPath: project,
        provenance: {
          source: 'topic-binding',
          topicId: 776,
          projectName: 'trusted-project',
        },
        expectedRemote: 'git@github.com:example/trusted-project.git',
      },
    });
  });

  it('uses the declared server project for a project-bound agent', () => {
    const project = createRepo(tmp, 'project-bound');
    const selected = selectCartographerRootCandidate({
      kind: 'active-project-checkout',
      standalone: false,
      serverProject: { projectDir: project, projectName: 'project-bound' },
    });

    expect(selected).toMatchObject({
      ok: true,
      candidate: {
        requestedPath: project,
        provenance: { source: 'server-project', projectName: 'project-bound' },
      },
    });
  });

  it('requires an explicit repository-anchored binding for Instar source', () => {
    const selected = selectCartographerRootCandidate({
      kind: 'instar-source-checkout',
      binding: {
        bindingId: 'instar-source',
        projectDir: path.join(tmp, 'instar'),
        projectName: 'instar',
        gitRemote: '',
      },
    });

    expect(selected).toMatchObject({
      ok: false,
      code: 'instar-source-binding-required',
    });
  });
});

describe('CartographerRootAuthority', () => {
  it('normalizes equivalent HTTPS, SSH, and scp-like remote identities', () => {
    expect(
      normalizeCartographerGitRemote('https://github.com/Example/Repo.git/'),
    ).toBe('github.com/example/repo');
    expect(
      normalizeCartographerGitRemote('ssh://git@github.com/Example/Repo.git'),
    ).toBe('github.com/example/repo');
    expect(
      normalizeCartographerGitRemote('git@github.com:Example/Repo.git'),
    ).toBe('github.com/example/repo');
  });

  it('preserves non-default ports and case-sensitive paths on unknown forges', () => {
    expect(
      normalizeCartographerGitRemote(
        'ssh://git@git.example.com:8443/Org/Repo.git',
      ),
    ).toBe('git.example.com:8443/Org/Repo');
    expect(
      normalizeCartographerGitRemote(
        'ssh://git@git.example.com:9443/Org/Repo.git',
      ),
    ).toBe('git.example.com:9443/Org/Repo');
    expect(
      normalizeCartographerGitRemote('https://git.example.com/Org/Repo.git'),
    ).not.toBe(
      normalizeCartographerGitRemote('https://git.example.com/org/repo.git'),
    );
  });

  it('verifies canonical Git identity and the exact readable revision', () => {
    const remote = 'https://github.com/example/project.git';
    const repo = createRepo(tmp, 'verified', remote);
    const authority = createAuthority();
    const assessment = authority.assess(
      activeCandidate(repo, 'git@github.com:example/project.git'),
    );

    expect(assessment).toMatchObject({
      trust: 'verified',
      reason: 'verified',
      structuralPopulationAllowed: true,
      paidAuthoringAllowed: true,
      identity: {
        canonicalPath: fs.realpathSync(repo),
        gitTopLevel: fs.realpathSync(repo),
        remoteUrl: remote,
        revision: git(repo, 'rev-parse', 'HEAD'),
      },
    });
    expect(assessment.identity?.rootId).toMatch(/^[a-f0-9]{24}$/);
    expect(assessment.identity?.repositoryId).toMatch(/^[a-f0-9]{24}$/);
    expect(assessment.identity?.stateNamespace).toBe(
      `root-${assessment.identity?.rootId}`,
    );
  });

  it('verifies an Instar source-signature checkout through the source-tree safety guard', () => {
    const remote = 'https://github.com/JKHeadley/instar.git';
    const repo = createRepo(tmp, 'instar-source', remote, false);
    fs.mkdirSync(path.join(repo, 'src', 'core'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ name: 'instar', version: '1.0.0' }),
    );
    fs.writeFileSync(path.join(repo, 'tsconfig.json'), '{}\n');
    fs.writeFileSync(
      path.join(repo, 'src', 'core', 'GitSync.ts'),
      'export class GitSync {}\n',
    );
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'instar source signature');

    const assessment = createAuthority().assess({
      kind: 'instar-source-checkout',
      requestedPath: repo,
      provenance: {
        source: 'operator-binding',
        bindingId: 'instar-source',
        projectName: 'instar',
      },
      expectedRemote: 'git@github.com:JKHeadley/instar.git',
    });

    expect(assessment).toMatchObject({
      trust: 'verified',
      reason: 'verified',
      structuralPopulationAllowed: true,
      paidAuthoringAllowed: true,
      identity: {
        canonicalPath: fs.realpathSync(repo),
        remoteUrl: remote,
        revision: git(repo, 'rev-parse', 'HEAD'),
      },
    });
  });

  it('keeps an unborn or unreadable HEAD structural-only instead of erasing the hierarchy', () => {
    const repo = createRepo(tmp, 'unborn', undefined, false);
    const authority = createAuthority();
    const assessment = authority.assess(activeCandidate(repo));

    expect(assessment).toMatchObject({
      trust: 'structural-only',
      reason: 'head-unreadable',
      structuralPopulationAllowed: true,
      paidAuthoringAllowed: false,
      identity: {
        canonicalPath: fs.realpathSync(repo),
        revision: null,
      },
    });
    expect(assessment.identity?.repositoryId).not.toBeNull();

    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'first readable head');
    const verified = authority.assess(activeCandidate(repo));
    expect(verified.trust).toBe('verified');
    expect(verified.identity?.stateNamespace).toBe(
      assessment.identity?.stateNamespace,
    );
  });

  it('never authorizes paid project summarization for the agent-home root kind', () => {
    const home = createRepo(tmp, 'agent-home');
    const selected = selectCartographerRootCandidate({
      kind: 'agent-home',
      agentHome: home,
      agentName: 'echo',
    });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;

    const assessment = createAuthority().assess(selected.candidate);
    expect(assessment).toMatchObject({
      trust: 'verified',
      structuralPopulationAllowed: true,
      paidAuthoringAllowed: false,
      identity: { kind: 'agent-home' },
    });
  });

  it('allows structural population for a provenance-selected non-Git directory', () => {
    const project = path.join(tmp, 'non-git');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(project, 'src', 'OnlyStructure.ts'),
      'export const structure = true;\n',
    );
    const assessment = createAuthority().assess(activeCandidate(project));

    expect(assessment).toMatchObject({
      trust: 'structural-only',
      reason: 'git-root-unreadable',
      structuralPopulationAllowed: true,
      paidAuthoringAllowed: false,
      identity: { revision: null, repositoryId: null },
    });
  });

  it('refuses a stale lookalike whose repository identity contradicts the binding', () => {
    const stale = createRepo(
      tmp,
      'stale-lookalike',
      'https://github.com/example/agent-backup.git',
    );
    fs.writeFileSync(
      path.join(stale, 'src', 'LooksLikeInstar.ts'),
      'export const plausible = true;\n',
    );
    const assessment = createAuthority().assess({
      kind: 'instar-source-checkout',
      requestedPath: stale,
      provenance: {
        source: 'operator-binding',
        bindingId: 'instar-source',
        projectName: 'instar',
      },
      expectedRemote: 'https://github.com/JKHeadley/instar.git',
    });

    expect(assessment).toMatchObject({
      trust: 'refused',
      reason: 'remote-mismatch',
      structuralPopulationAllowed: false,
      paidAuthoringAllowed: false,
    });
  });

  it('refuses remote anchors that differ only by an explicit port', () => {
    const stale = createRepo(
      tmp,
      'ported-lookalike',
      'ssh://git@git.example.com:8443/Org/Repo.git',
    );
    const decisions: CartographerRootDecision[] = [];
    const assessment = createAuthority(decisions).assess(
      activeCandidate(stale, 'ssh://git@git.example.com:9443/Org/Repo.git'),
    );

    expect(assessment).toMatchObject({
      trust: 'refused',
      reason: 'remote-mismatch',
    });
    expect(decisions[0]).toMatchObject({
      rule: 'remote-mismatch',
      signals: {
        expectedRemote: 'git.example.com:9443/Org/Repo',
        observedRemotes: ['git.example.com:8443/Org/Repo'],
      },
      outcome: { trust: 'refused', paidAuthoringAllowed: false },
    });
  });

  it('refuses a plausible subdirectory because the selected root is not the Git top level', () => {
    const repo = createRepo(tmp, 'outer');
    const nested = path.join(repo, 'src');
    const assessment = createAuthority().assess(activeCandidate(nested));
    expect(assessment).toMatchObject({
      trust: 'refused',
      reason: 'candidate-not-git-root',
    });
  });

  it('revalidation refuses revision drift before a trusted operation', () => {
    const repo = createRepo(tmp, 'drift');
    const authority = createAuthority();
    const first = authority.assess(activeCandidate(repo));
    expect(first.trust).toBe('verified');

    fs.writeFileSync(
      path.join(repo, 'src', 'later.ts'),
      'export const later = true;\n',
    );
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'advance');

    const next = authority.revalidate(first);
    expect(next).toMatchObject({
      trust: 'refused',
      reason: 'revision-mismatch',
      paidAuthoringAllowed: false,
    });
    expect(next.identity?.rootId).toBe(first.identity?.rootId);
    expect(next.identity?.stateNamespace).toBe(first.identity?.stateNamespace);
  });

  it('assigns distinct stable state namespaces to two verified roots', () => {
    const remote = 'https://github.com/example/shared.git';
    const projectA = createRepo(tmp, 'project-a', remote);
    const projectB = createRepo(tmp, 'project-b', remote);
    const authority = createAuthority();
    const a = authority.assess(activeCandidate(projectA, remote));
    const b = authority.assess(activeCandidate(projectB, remote));

    expect(a.trust).toBe('verified');
    expect(b.trust).toBe('verified');
    expect(a.identity?.repositoryId).toBe(b.identity?.repositoryId);
    expect(a.identity?.rootId).not.toBe(b.identity?.rootId);
    expect(a.identity?.stateNamespace).not.toBe(b.identity?.stateNamespace);
  });

  it('records structured signals, applied rule, and outcome for every decision', () => {
    const project = createRepo(
      tmp,
      'audited',
      'https://github.com/example/audited.git',
    );
    const decisions: CartographerRootDecision[] = [];
    const assessment = createAuthority(decisions).assess(
      activeCandidate(project, 'git@github.com:example/audited.git'),
    );

    expect(assessment.trust).toBe('verified');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      schemaVersion: 1,
      decidedAt: '2026-08-02T08:00:00.000Z',
      operation: 'assess',
      context: { candidate: { requestedPath: project } },
      signals: {
        pathState: 'directory',
        canonicalPath: fs.realpathSync(project),
        gitTopLevel: fs.realpathSync(project),
        expectedRemote: 'github.com/example/audited',
        observedRemotes: ['github.com/example/audited'],
        observedRevision: assessment.identity?.revision,
      },
      rule: 'verified',
      outcome: {
        trust: 'verified',
        structuralPopulationAllowed: true,
        paidAuthoringAllowed: true,
        rootId: assessment.identity?.rootId,
        stateNamespace: assessment.identity?.stateNamespace,
      },
    });
  });

  it('does not return an authority outcome when its required recorder fails', () => {
    const project = createRepo(tmp, 'unlogged');
    const authority = new CartographerRootAuthority({
      recordDecision: () => {
        throw new Error('decision audit unavailable');
      },
    });

    expect(() => authority.assess(activeCandidate(project))).toThrow(
      'decision audit unavailable',
    );
  });
});

describe('CartographerTree verified-root storage namespaces', () => {
  it('isolates two project indexes inside one agent state directory', () => {
    const projectA = createRepo(tmp, 'alpha');
    const projectB = createRepo(tmp, 'beta');
    const stateDir = path.join(tmp, 'agent-state');
    const authority = createAuthority();
    const a = authority.assess(activeCandidate(projectA));
    const b = authority.assess(activeCandidate(projectB));
    expect(a.identity).not.toBeNull();
    expect(b.identity).not.toBeNull();

    const treeA = new CartographerTree({
      projectDir: projectA,
      stateDir,
      stateNamespace: a.identity!.stateNamespace,
    });
    const treeB = new CartographerTree({
      projectDir: projectB,
      stateDir,
      stateNamespace: b.identity!.stateNamespace,
    });
    treeA.scaffold();
    treeB.scaffold();

    expect(treeA.getNode('src/alpha.ts')).not.toBeNull();
    expect(treeA.getNode('src/beta.ts')).toBeNull();
    expect(treeB.getNode('src/beta.ts')).not.toBeNull();
    expect(treeB.getNode('src/alpha.ts')).toBeNull();
    expect(
      fs.existsSync(
        path.join(
          stateDir,
          'cartographer',
          'roots',
          a.identity!.stateNamespace,
          'index.json',
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          stateDir,
          'cartographer',
          'roots',
          b.identity!.stateNamespace,
          'index.json',
        ),
      ),
    ).toBe(true);
  });

  it('rejects a namespace that could escape the root-state directory', () => {
    const project = createRepo(tmp, 'escape');
    expect(
      () =>
        new CartographerTree({
          projectDir: project,
          stateDir: path.join(tmp, 'state'),
          stateNamespace: '../escape',
        }),
    ).toThrow('Invalid Cartographer state namespace');
    expect(
      () =>
        new CartographerTree({
          projectDir: project,
          stateDir: path.join(tmp, 'state'),
          stateNamespace: '',
        }),
    ).toThrow('Invalid Cartographer state namespace');
    expect(
      () =>
        new CartographerTree({
          projectDir: project,
          stateDir: path.join(tmp, 'state'),
          stateNamespace: 'plausible-but-unverified',
        }),
    ).toThrow('Invalid Cartographer state namespace');
  });
});
