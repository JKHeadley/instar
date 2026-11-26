/**
 * E2E — the owned-repository registry on the production path (docs/specs/no-data-loss-on-machine-death.md
 * increment 1). Phase 1 ("is it alive"): the REAL builder (createOwnedRepos, the one server.ts uses)
 * behind the REAL AgentServer route plumbing answers 200, not 503, and lists a real repository that has
 * no remote. Wiring integrity: the development-agent gate decides on/off, the registry is real, and the
 * birth observer it installs on SafeGitExecutor really registers a repository created through the funnel.
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
import { createOwnedRepos, ownedReposEnabled, type OwnedReposHandle } from '../../src/monitoring/ownedRepos/wiring.js';
import { OwnedRepoRegistry } from '../../src/monitoring/ownedRepos/OwnedRepoRegistry.js';

const AUTH = 'test-e2e-owned-repos';

describe('owned-repository registry E2E', () => {
  let userHome: string;
  let home: string;
  let server: AgentServer;
  let handle: OwnedReposHandle;

  beforeAll(async () => {
    userHome = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.instar-test-repos-e2e-')));
    home = path.join(userHome, '.instar', 'agents', 'e2e');
    const stateDir = path.join(home, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'repos-e2e', agentName: 'E2E' }));
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_GLOBAL: '/dev/null' };
    SafeGitExecutor.run(['init', '-q', '-b', 'main'], { cwd: home, env, operation: 'tests/e2e/owned-repos-alive.test.ts' });
    fs.writeFileSync(path.join(home, '.gitignore'), '.instar/\n');
    SafeGitExecutor.run(['add', '.gitignore'], { cwd: home, env, operation: 'tests/e2e/owned-repos-alive.test.ts' });
    SafeGitExecutor.run(['commit', '-q', '-m', 'home'], { cwd: home, env, operation: 'tests/e2e/owned-repos-alive.test.ts' });

    const cfg = { developmentAgent: true };
    expect(ownedReposEnabled(cfg)).toBe(true);
    handle = createOwnedRepos({ config: cfg, stateDir, machineId: 'm_e2e', machineName: () => 'E2E Box', userHome, peers: () => [], authToken: AUTH });
    const config: InstarConfig = {
      projectName: 'repos-e2e', projectDir: home, stateDir, port: 0, authToken: AUTH, requestTimeoutMs: 10000, version: '0.10.3',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
    };
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as never, state: new StateManager(stateDir), ownedRepos: () => handle.routeDeps() });
    await server.start();
  }, 60_000);

  afterAll(async () => {
    handle.stop();
    await server.stop();
    SafeFsExecutor.safeRmSync(userHome, { recursive: true, force: true, operation: 'tests/e2e/owned-repos-alive.test.ts' });
  });

  it('the gate is dark on the fleet and an explicit value wins', () => {
    expect(ownedReposEnabled({})).toBe(false);
    expect(ownedReposEnabled({ developmentAgent: true, noDataLoss: { repos: { enabled: false } } })).toBe(false);
    expect(ownedReposEnabled({ noDataLoss: { repos: { enabled: true } } })).toBe(true);
  });

  it('wiring integrity: the route deps carry the real registry, not a stub', () => {
    const deps = handle.routeDeps();
    expect(deps.registry).toBeInstanceOf(OwnedRepoRegistry);
    expect(deps.registry).toBe(handle.registry);
    expect(typeof deps.replicas).toBe('function');
    expect(deps.replicas().size).toBe(0);
  });

  it('a repository created through SafeGitExecutor is registered at birth, then GET /repos returns 200 listing it with no remote', async () => {
    const app = path.join(home, 'apps', 'new-app');
    fs.mkdirSync(app, { recursive: true });
    SafeGitExecutor.execSync(['init', '-q', '-b', 'main'], { cwd: app, operation: 'tests/e2e/owned-repos-alive.test.ts' });
    await handle.registry.tick();
    const res = await request(server.getApp()).get('/repos').set({ Authorization: `Bearer ${AUTH}` });
    expect(res.status).toBe(200);
    expect(res.body.machineName).toBe('E2E Box');
    const listed = res.body.repos.find((r: { path: string }) => r.path === app);
    expect(listed).toBeTruthy();
    expect(listed.class).toBe('owned');
    expect(listed.via).toBe('birth');
    expect(listed.hasOffMachineRemote).toBe(false);
    expect(res.body.repos.find((r: { path: string }) => r.path === home)?.class).toBe('owned');
    const pool = await request(server.getApp()).get('/repos?scope=pool').set({ Authorization: `Bearer ${AUTH}` });
    expect(pool.status).toBe(200);
    expect(pool.body.machines).toHaveLength(1);
  }, 60_000);
});
