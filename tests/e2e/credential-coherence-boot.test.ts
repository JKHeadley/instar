// safe-git-allow: e2e test for the boot credential-coherence sample; direct git usage is for fixture setup only.
/**
 * E2E lifecycle — boot credential-coherence sample (Phase-3 Inc-P3d).
 *
 * Tier 3 of the Testing Integrity Standard, on the PRODUCTION initialization
 * path: a REAL AgentServer.start() (the same call src/commands/server.ts
 * makes) under a polluted environment must
 *   Phase 1 — Feature is alive: write exactly one boot-coherence line to
 *             credential-resolution.jsonl whose expected identity was read
 *             from the agent repo's local git config, flagging the inherited
 *             identity env var as a divergent surface.
 *   Phase 2 — Signal-only invariant: the divergence NEVER blocks boot — the
 *             server comes up and serves authed requests (200, not 503), and
 *             a second boot with auditing disabled also comes up clean.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { sanitizedGitEnv } from '../helpers/git-test-env.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'test-cred-coherence-e2e';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

describe('boot credential-coherence E2E lifecycle (Inc-P3d)', () => {
  let tmpDir: string;
  let stateDir: string;
  let auditDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let savedAuthorName: string | undefined;

  beforeAll(async () => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cred-coherence-e2e-')));
    stateDir = path.join(tmpDir, '.instar');
    auditDir = path.join(tmpDir, 'audit-out');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'cred-coherence-e2e' }),
    );
    // The agent repo: tmpDir is a git repo with its OWN local identity — the
    // production shape of an agent home (stateDir's parent).
    const env = sanitizedGitEnv();
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: tmpDir, stdio: 'ignore', env });
    execFileSync('git', ['config', 'user.name', 'Instar Agent (e2e)'], { cwd: tmpDir, stdio: 'ignore', env });
    execFileSync('git', ['config', 'user.email', 'e2e@instar.local'], { cwd: tmpDir, stdio: 'ignore', env });

    // The Caroline shape: the spawning environment carries another
    // principal's identity at the moment the server boots.
    savedAuthorName = process.env.GIT_AUTHOR_NAME;
    process.env.GIT_AUTHOR_NAME = 'Caroline';
    process.env.INSTAR_AUDIT_LOG_DIR = auditDir;

    const config = {
      projectName: 'cred-coherence-e2e',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH,
      requestTimeoutMs: 10000,
      version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [],
      monitoring: {},
      updates: {},
    } as InstarConfig;
    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(stateDir),
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    try {
      await server.stop();
    } catch {
      /* already stopped */
    }
    delete process.env.INSTAR_AUDIT_LOG_DIR;
    if (savedAuthorName === undefined) delete process.env.GIT_AUTHOR_NAME;
    else process.env.GIT_AUTHOR_NAME = savedAuthorName;
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/credential-coherence-boot.test.ts' });
  });

  // ── Phase 1: feature is alive on the production boot path ──

  it('start() wrote exactly one boot-coherence line with the repo-local expected identity', () => {
    const file = path.join(auditDir, 'credential-resolution.jsonl');
    expect(fs.existsSync(file)).toBe(true);
    const entries = fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e: { kind: string }) => e.kind === 'boot-coherence');
    expect(entries).toHaveLength(1);
    expect(entries[0].expected.name).toBe('Instar Agent (e2e)');
    expect(entries[0].expected.email).toBe('e2e@instar.local');
    expect(entries[0].expected.source).toBe('repo-local-config');
    expect(entries[0].cwd).toBe(tmpDir);
  });

  it('flagged the inherited identity env var as a divergent surface', () => {
    const file = path.join(auditDir, 'credential-resolution.jsonl');
    const entry = fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((e: { kind: string }) => e.kind === 'boot-coherence');
    const surfaces = entry.divergences.map((d: { surface: string }) => d.surface);
    expect(surfaces).toContain('env:GIT_AUTHOR_NAME');
  });

  // ── Phase 2: signal-only — divergence never blocks boot ──

  it('the server booted and serves authed requests despite the divergence (200, not 503)', async () => {
    const res = await request(app).get('/health').set(auth());
    expect(res.status).toBe(200);
  });

  it('a boot with auditing disabled still comes up (the sample is pure observability)', async () => {
    process.env.INSTAR_AUDIT_LOG_DISABLED = '1';
    const tmp2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cred-coherence-e2e2-')));
    const stateDir2 = path.join(tmp2, '.instar');
    fs.mkdirSync(path.join(stateDir2, 'state', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(stateDir2, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e2' }));
    const config2 = {
      projectName: 'e2e2',
      projectDir: tmp2,
      stateDir: stateDir2,
      port: 0,
      authToken: AUTH,
      requestTimeoutMs: 10000,
      version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [],
      monitoring: {},
      updates: {},
    } as InstarConfig;
    const server2 = new AgentServer({
      config: config2,
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(stateDir2),
    });
    await server2.start();
    const res = await request(server2.getApp()).get('/health').set(auth());
    expect(res.status).toBe(200);
    await server2.stop();
    delete process.env.INSTAR_AUDIT_LOG_DISABLED;
    SafeFsExecutor.safeRmSync(tmp2, { recursive: true, force: true, operation: 'tests/e2e/credential-coherence-boot.test.ts' });
  });
});
