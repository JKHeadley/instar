// safe-git-allow: fixture repositories use git only to create/read controlled revisions.
/**
 * 11B-2 acceptance boundary: live Cartographer root selection, reporting, reads,
 * population, and authoring all travel through one verified-root registry.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { authMiddleware } from '../../src/server/middleware.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { runDetect } from '../../src/core/cartographerDetect.js';
import { CartographerRootRegistry } from '../../src/core/CartographerRootRegistry.js';
import type { TopicProjectBinding } from '../../src/core/ScopeVerifier.js';

const AUTH = 'root-registry-test-token';
const tempRoots: string[] = [];

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  tempRoots.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'root-test',
      GIT_AUTHOR_EMAIL: 'root@test.invalid',
      GIT_COMMITTER_NAME: 'root-test',
      GIT_COMMITTER_EMAIL: 'root@test.invalid',
    },
  }).trim();
}

function makeRepo(label: string, target: string, sibling: string, distractors = 0): string {
  const repo = tempDir(label);
  git(repo, ['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(repo, 'src', 'controls'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'controls', `${target}.ts`), `export class ${target} {}\n`);
  fs.writeFileSync(path.join(repo, 'src', 'controls', `${sibling}.ts`), `export class ${sibling} {}\n`);
  const noise = path.join(repo, 'src', 'noise');
  fs.mkdirSync(noise, { recursive: true });
  for (let i = 0; i < distractors; i += 1) {
    fs.writeFileSync(path.join(noise, `Distractor${String(i).padStart(3, '0')}.ts`), `export const distraction${i} = ${i};\n`);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'fixture']);
  return repo;
}

function inlineDetect() {
  return async (input: Parameters<typeof runDetect>[0]) => ({
    ok: true,
    result: await runDetect(input),
    durationMs: 0,
  });
}

function registry(options: {
  agentHome: string;
  stateDir: string;
  bindings: Record<string, TopicProjectBinding>;
}): CartographerRootRegistry {
  return new CartographerRootRegistry({
    agentType: 'standalone',
    agentHome: options.agentHome,
    agentName: 'root-test-agent',
    stateDir: options.stateDir,
    topicBindings: () => options.bindings,
    population: { runDetectWorker: inlineDetect() },
  });
}

function app(roots: CartographerRootRegistry, projectDir: string, stateDir: string): express.Express {
  const instance = express();
  instance.use(express.json());
  instance.use(authMiddleware(() => AUTH, 'test'));
  instance.use('/', createRoutes({
    config: {
      projectName: 'root-test-agent', projectDir, stateDir, port: 0,
      authToken: AUTH, agentType: 'standalone', sessions: {}, scheduler: {},
      cartographer: {
        enabled: true,
        freshnessSweep: {
          enabled: true, minSummaryChars: 10, maxSummaryChars: 600, maxLeafBytes: 24576,
        },
        subtreeNav: { maxNodesVisited: 200 },
      },
    } as never,
    cartographerRoots: roots,
    startTime: new Date(),
  } as unknown as RouteContext));
  return instance;
}

const bearer = (test: request.Test): request.Test => test.set('Authorization', `Bearer ${AUTH}`);

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('CartographerRootRegistry live boundary', () => {
  it('keeps two verified topics isolated at the existing 200-node navigation ceiling', async () => {
    const agentHome = tempDir('carto-noisy-home-');
    const stateDir = path.join(agentHome, '.instar');
    fs.mkdirSync(path.join(agentHome, 'src'), { recursive: true });
    fs.writeFileSync(path.join(agentHome, 'src', 'TopicAUniqueControl.ts'), 'stale lookalike\n');
    const projectA = makeRepo('carto-topic-a-', 'TopicAUniqueControl', 'CompletelySeparateAlphaSibling', 220);
    const projectB = makeRepo('carto-topic-b-', 'TopicBUniqueControl', 'CompletelySeparateBetaSibling', 220);
    const bindings: Record<string, TopicProjectBinding> = {
      '101': { projectName: 'project-a', projectDir: projectA },
      '202': { projectName: 'project-b', projectDir: projectB },
    };
    const roots = registry({ agentHome, stateDir, bindings });
    await roots.populateOnBoot();
    const server = app(roots, agentHome, stateDir);

    const a = await bearer(request(server).get('/cartographer/navigate'))
      .query({ topicId: 101, query: 'TopicAUniqueControl' });
    expect(a.status).toBe(200);
    expect(a.body.nodesVisited).toBeLessThanOrEqual(200);
    expect(a.body.rootAuthority).toMatchObject({
      verificationState: 'verified',
      kind: 'active-project-checkout',
      provenance: { source: 'topic-binding', topicId: 101, projectName: 'project-a' },
      revision: git(projectA, ['rev-parse', 'HEAD']),
    });
    const aPayload = JSON.stringify(a.body);
    const aScoredPaths = (a.body.scored as Array<{ path: string }>).map((node) => node.path);
    expect(aScoredPaths).toContain('src/controls/TopicAUniqueControl.ts');
    expect(aScoredPaths).not.toContain('src/controls/CompletelySeparateAlphaSibling.ts');
    expect(aScoredPaths).not.toContain('src/TopicAUniqueControl.ts');
    expect(aPayload).not.toContain('CompletelySeparateAlphaSibling.ts');
    expect(aPayload).not.toContain('TopicBUniqueControl.ts');
    expect(a.body.rootAuthority.canonicalPath).toBe(fs.realpathSync(projectA));

    const b = await bearer(request(server).get('/cartographer/navigate'))
      .query({ topicId: 202, query: 'TopicBUniqueControl' });
    expect(b.status).toBe(200);
    expect(b.body.rootAuthority).toMatchObject({
      verificationState: 'verified',
      provenance: { source: 'topic-binding', topicId: 202, projectName: 'project-b' },
      revision: git(projectB, ['rev-parse', 'HEAD']),
    });
    const bPayload = JSON.stringify(b.body);
    const bScoredPaths = (b.body.scored as Array<{ path: string }>).map((node) => node.path);
    expect(bScoredPaths).toContain('src/controls/TopicBUniqueControl.ts');
    expect(bScoredPaths).not.toContain('src/controls/CompletelySeparateBetaSibling.ts');
    expect(bScoredPaths).not.toContain('src/TopicAUniqueControl.ts');
    expect(bPayload).not.toContain('CompletelySeparateBetaSibling.ts');
    expect(bPayload).not.toContain('TopicAUniqueControl.ts');
    expect(b.body.rootAuthority.rootId).not.toBe(a.body.rootAuthority.rootId);
  });

  it('refuses an ambiguous standalone read instead of falling back to the noisy agent home', async () => {
    const agentHome = tempDir('carto-ambiguous-home-');
    const stateDir = path.join(agentHome, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    const roots = registry({ agentHome, stateDir, bindings: {} });

    const response = await bearer(request(app(roots, agentHome, stateDir)).get('/cartographer/health'));
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: 'cartographer-root-refused',
      reason: 'topic-binding-required',
    });
    const decisions = fs.readFileSync(
      path.join(stateDir, 'cartographer', 'root-authority-decisions.jsonl'),
      'utf8',
    ).trim().split('\n').map((line) => JSON.parse(line));
    expect(decisions.at(-1)).toMatchObject({
      operation: 'select',
      rule: 'topic-binding-required',
      outcome: { trust: 'refused' },
    });
  });

  it('keeps the durable authority decision trail under a fixed rotation bound', () => {
    const agentHome = tempDir('carto-bounded-log-home-');
    const stateDir = path.join(agentHome, '.instar');
    const roots = new CartographerRootRegistry({
      agentType: 'standalone', agentHome, agentName: 'root-test-agent', stateDir,
      topicBindings: () => ({}),
      decisionLogMaxBytes: 200,
      decisionLogKeepArchives: 1,
    });
    for (let index = 0; index < 8; index += 1) roots.resolve();

    const log = path.join(stateDir, 'cartographer', 'root-authority-decisions.jsonl');
    expect(fs.existsSync(log)).toBe(true);
    expect(fs.existsSync(`${log}.1`)).toBe(true);
    expect(fs.existsSync(`${log}.2`)).toBe(false);
    expect(fs.statSync(log).size + fs.statSync(`${log}.1`).size).toBeLessThan(2_000);
  });

  it('population re-runs EVERY BOOT under new authority: second.nodeCount === first.nodeCount + 1', async () => {
    const agentHome = tempDir('carto-reboot-home-');
    const stateDir = path.join(agentHome, '.instar');
    const project = makeRepo('carto-reboot-project-', 'FirstBootNode', 'ExistingSibling');
    const bindings = { '303': { projectName: 'reboot-project', projectDir: project } };

    const firstRegistry = registry({ agentHome, stateDir, bindings });
    const [first] = await firstRegistry.populateOnBoot();
    const inactiveCache = path.join(
      stateDir, 'cartographer', 'roots', 'root-ffffffffffffffffffffffff',
    );
    fs.mkdirSync(inactiveCache, { recursive: true });
    fs.writeFileSync(path.join(inactiveCache, 'stale-cache-marker'), 'regenerable');
    fs.writeFileSync(path.join(project, 'src', 'controls', 'SecondBootNode.ts'), 'export const secondBootNode = true;\n');
    const secondRegistry = registry({ agentHome, stateDir, bindings });
    const [second] = await secondRegistry.populateOnBoot();

    expect(second.nodeCount).toBe(first.nodeCount + 1);
    expect(secondRegistry.resolve(303).ok && secondRegistry.resolve(303).root.tree.getNode('src/controls/SecondBootNode.ts')).not.toBeNull();
    expect(fs.existsSync(inactiveCache)).toBe(false);
  });

  it('does not turn an empty binding view into delete-all cache pruning', async () => {
    const agentHome = tempDir('carto-empty-bindings-home-');
    const stateDir = path.join(agentHome, '.instar');
    const existingCache = path.join(
      stateDir, 'cartographer', 'roots', 'root-eeeeeeeeeeeeeeeeeeeeeeee',
    );
    fs.mkdirSync(existingCache, { recursive: true });
    fs.writeFileSync(path.join(existingCache, 'uncertain-cache-marker'), 'retain under uncertainty');

    const roots = registry({ agentHome, stateDir, bindings: {} });
    expect(await roots.populateOnBoot()).toEqual([]);
    expect(fs.existsSync(existingCache)).toBe(true);
  });

  it('a bound root with no readable Git HEAD publishes structural-only with freshRatio null', async () => {
    const agentHome = tempDir('carto-structural-home-');
    const stateDir = path.join(agentHome, '.instar');
    const project = tempDir('carto-structural-project-');
    git(project, ['init', '-q', '-b', 'main']);
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.writeFileSync(path.join(project, 'src', 'StructuralOnly.ts'), 'export const structuralOnly = true;\n');
    const bindings = { '404': { projectName: 'structural-project', projectDir: project } };
    const roots = registry({ agentHome, stateDir, bindings });
    await roots.populateOnBoot();

    const response = await bearer(request(app(roots, agentHome, stateDir)).get('/cartographer/health'))
      .query({ topicId: 404 });
    expect(response.status).toBe(200);
    expect(response.body.rootAuthority).toMatchObject({
      verificationState: 'structural-only',
      verificationReason: 'head-unreadable',
      revision: null,
      provenance: { source: 'topic-binding', topicId: 404 },
    });
    expect(response.body.nodeCount).toBeGreaterThan(0);
    expect(response.body.freshness.freshRatio).toBeNull();
  });

  it('refuses inline authoring after the authority-pinned revision drifts', async () => {
    const agentHome = tempDir('carto-author-home-');
    const stateDir = path.join(agentHome, '.instar');
    const project = makeRepo('carto-author-project-', 'PinnedRevisionSymbol', 'OtherSymbol');
    const bindings = { '505': { projectName: 'author-project', projectDir: project } };
    const roots = registry({ agentHome, stateDir, bindings });
    await roots.populateOnBoot();
    fs.writeFileSync(path.join(project, 'src', 'RevisionMoved.ts'), 'export const revisionMoved = true;\n');
    git(project, ['add', '-A']);
    git(project, ['commit', '-q', '-m', 'move head']);

    const response = await bearer(request(app(roots, agentHome, stateDir)).post('/cartographer/node/refresh'))
      .send({
        topicId: 505,
        path: 'src/controls/PinnedRevisionSymbol.ts',
        summary: 'Implements PinnedRevisionSymbol for the authority test.',
      });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: 'cartographer-authoring-refused',
      reason: 'revision-mismatch',
    });
  });
});
