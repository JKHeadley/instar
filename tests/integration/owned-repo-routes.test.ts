/**
 * GET /repos over the real HTTP pipeline (docs/specs/no-data-loss-on-machine-death.md §1.7):
 * 503 when off; this machine's repositories and defects; the pool read with a live peer, a peer
 * known only from its replicated records, and a peer that is named unknown — never left out.
 * Its answer feeds the Needs-you list through the console's own model (repoNeedRows).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { OwnedRepoRegistry } from '../../src/monitoring/ownedRepos/OwnedRepoRegistry.js';
import { readGit } from '../../src/monitoring/ownedRepos/repoGit.js';
import type { OwnedRepoRouteDeps } from '../../src/server/ownedRepoRoutes.js';
import type { OwnedRepoReplica } from '../../src/core/OwnedRepoReplicatedStore.js';
// @ts-expect-error — browser-native ESM model, no types
import { buildReposPage, repoNeedRows } from '../../dashboard/console/repos-model.js';

const AUTH = 'test-owned-repo-routes';
const DAY = 86_400_000;

function makeServer(tmp: string, deps: (() => OwnedRepoRouteDeps | null) | undefined) {
  const stateDir = path.join(tmp, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'or', agentName: 'OR' }));
  const config: InstarConfig = {
    projectName: 'or', projectDir: tmp, stateDir, port: 0, authToken: AUTH, requestTimeoutMs: 10000, version: '0.10.3',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  };
  return new AgentServer({ config, sessionManager: createMockSessionManager() as never, state: new StateManager(stateDir), ownedRepos: deps });
}

function git(cwd: string, args: string[], date?: Date) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_GLOBAL: '/dev/null', ...(date ? { GIT_AUTHOR_DATE: date.toISOString(), GIT_COMMITTER_DATE: date.toISOString() } : {}) };
  SafeGitExecutor.run(args, { cwd, env, operation: 'tests/integration/owned-repo-routes.test.ts' });
}

describe('owned-repository routes', () => {
  let userHome: string;
  let off: AgentServer;
  let on: AgentServer;
  let registry: OwnedRepoRegistry;
  const replica: OwnedRepoReplica = { repoId: 'c'.repeat(64), machineId: 'm_laptop', displayPath: '~/Projects/android', class: 'candidate', remotes: [], singleCopy: true, singleCopyCommitsBucket: 8, singleCopyBranchesBucket: 1, uncommitted: false, pastGrace: true, state: 'ok', gone: false };

  beforeAll(async () => {
    userHome = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.instar-test-repo-routes-')));
    const home = path.join(userHome, '.instar', 'agents', 'echo');
    const old = new Date(Date.now() - 3 * DAY);
    fs.mkdirSync(path.join(home, 'apps', 'instar-ios'), { recursive: true });
    git(home, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(home, 'a.txt'), 'a'); git(home, ['add', '-A', 'a.txt']); git(home, ['commit', '-q', '-m', 'a'], old);
    git(home, ['remote', 'add', 'origin', 'https://github.com/JKHeadley/instar.git']); git(home, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const ios = path.join(home, 'apps', 'instar-ios');
    git(ios, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(ios, 'App.swift'), 'x'); git(ios, ['add', '-A']); git(ios, ['commit', '-q', '-m', 'app'], old);

    registry = new OwnedRepoRegistry({
      machineId: 'm_studio', machineName: () => 'Mac Studio', agentHome: home, userHome,
      stateFile: path.join(home, '.instar', 'state', 'owned-repos', 'm_studio.json'), git: readGit,
      roots: () => [], declaredRoots: () => [], otherAgentHomes: () => [],
    });
    await registry.tick();
    const fetchImpl = (async (url: string) => {
      if (url.startsWith('http://mini')) return new Response(JSON.stringify({ machineName: 'Mac Mini', repos: [{ displayPath: '~/x', state: 'ok' }], defects: [{ key: 'repos:unpushed:m_mini', kind: 'unpushed', machineId: 'm_mini', machineName: 'Mac Mini', title: '3 branches on Mac Mini have no copy anywhere else', detail: 'd', count: 3, repos: ['~/x'] }, { key: 'repos:unpushed:m_forged', kind: 'unpushed', machineId: 'm_forged', title: 'forged', detail: '', repos: [] }] }), { status: 200 });
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const deps: OwnedRepoRouteDeps = {
      registry, machineId: 'm_studio', authToken: AUTH, fetchImpl,
      peers: () => [
        { machineId: 'm_mini', name: 'Mac Mini', url: 'http://mini:4042', allowed: true },
        { machineId: 'm_laptop', name: 'Laptop', url: 'http://laptop:4042', allowed: true },
        { machineId: 'm_pc', name: 'Mama PC', url: 'http://pc:4042', allowed: true },
      ],
      replicas: () => new Map([['m_laptop', [replica]]]),
    };
    off = makeServer(fs.mkdtempSync(path.join(os.tmpdir(), 'or-off-')), undefined);
    on = makeServer(fs.mkdtempSync(path.join(os.tmpdir(), 'or-on-')), () => deps);
    await off.start(); await on.start();
  }, 60_000);

  afterAll(async () => {
    await off.stop(); await on.stop();
    SafeFsExecutor.safeRmSync(userHome, { recursive: true, force: true, operation: 'tests/integration/owned-repo-routes.test.ts' });
  });

  it('503 when the registry is off, and the Needs-you model reads that as nothing waiting', async () => {
    const res = await request(off.getApp()).get('/repos').set({ Authorization: `Bearer ${AUTH}` });
    expect(res.status).toBe(503);
    expect(repoNeedRows({ ok: false, status: 503, reason: 'switched off on this agent' })).toEqual([]);
  });

  it('requires the bearer token', async () => {
    const res = await request(on.getApp()).get('/repos');
    expect(res.status).toBe(401);
  });

  it('this machine: the repository with no remote is listed and is a defect', async () => {
    const res = await request(on.getApp()).get('/repos').set({ Authorization: `Bearer ${AUTH}` });
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('machine');
    const ios = res.body.repos.find((r: { displayPath: string }) => r.displayPath.endsWith('apps/instar-ios'));
    expect(ios.hasOffMachineRemote).toBe(false);
    expect(res.body.defects.map((d: { kind: string }) => d.kind)).toEqual(['no-remote']);
  });

  it('pool: a live peer, a peer from its replicated records, and an unreachable peer named unknown', async () => {
    const res = await request(on.getApp()).get('/repos?scope=pool').set({ Authorization: `Bearer ${AUTH}` });
    expect(res.status).toBe(200);
    const bySource = Object.fromEntries(res.body.machines.map((m: { machineId: string; source: string }) => [m.machineId, m.source]));
    expect(bySource).toEqual({ m_studio: 'self', m_mini: 'live', m_laptop: 'replicated', m_pc: 'unknown' });
    const page = buildReposPage({ ok: true, data: res.body });
    for (const target of ['m_studio', 'm_laptop']) {
      expect(page.machines?.find((m) => m.id === target)?.repos[0].line).toContain('uncommitted changes not fully checked');
    }
    expect(res.body.machines.find((m: { machineId: string }) => m.machineId === 'm_laptop')?.repos[0].uncommittedComplete).toBe(false);
    expect(res.body.couldNotRead.map((c: { machineId: string }) => c.machineId)).toEqual(['m_pc']);
    const keys = res.body.defects.map((d: { key: string }) => d.key).sort();
    expect(keys).toEqual(['repos:no-remote:m_laptop', 'repos:no-remote:m_studio', 'repos:unpushed:m_mini']);
    // A peer cannot inject a defect about another machine.
    expect(keys).not.toContain('repos:unpushed:m_forged');
    // The Needs-you rows come from the same answer, one per machine per kind, loud.
    const rows = repoNeedRows({ ok: true, status: 200, data: res.body });
    expect(rows.map((r: { key: string }) => r.key).sort()).toEqual(keys);
    expect(rows.map((r: { kind: string }) => r.kind)).toEqual(['no-remote', 'no-remote', 'unpushed']);
    expect(rows[0].href).toMatch(/^#\/capacity\/repos\?s=/);
  });

  it('a 200 of the wrong shape is unreadable, never "nothing waiting"', () => {
    expect(repoNeedRows({ ok: true, status: 200, data: { repos: [] } })).toBeNull();
    expect(repoNeedRows({ ok: false, status: 500, reason: 'the server answered 500' })).toBeNull();
  });
});
