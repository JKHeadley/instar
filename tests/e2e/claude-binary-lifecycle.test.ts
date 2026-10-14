// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test — retained Claude executable
 * (CMT-798): GET /sessions/claude-binary on the REAL AgentServer boot path
 * (the same path server.ts uses) with a REAL SessionManager.
 *
 * Per TESTING-INTEGRITY-SPEC: is the feature actually alive on the production
 * init path (200, not 503), Bearer-gated, and does it reflect what the spawn
 * chokepoint did?
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('Retained Claude executable E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  let sm: SessionManager;
  let claude: string;
  const AUTH = 'test-e2e-claude-binary';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-binary-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    // The real npm shape, non-script payload (never executed here).
    const pkgDir = path.join(tmpDir, 'fake-install', 'lib', 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'fake-install', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.299' }));
    fs.writeFileSync(path.join(pkgDir, 'bin', 'claude.exe'), 'FAKE-CLAUDE-2.1.299\n', { mode: 0o755 });
    claude = path.join(tmpDir, 'fake-install', 'bin', 'claude');
    fs.symlinkSync(path.relative(path.dirname(claude), path.join(pkgDir, 'bin', 'claude.exe')), claude);

    const sessions = { claudePath: claude, maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 };
    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions,
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;

    sm = new SessionManager({
      tmuxPath: '/usr/bin/false', claudePath: claude, projectDir: tmpDir,
      maxSessions: 3, protectedSessions: [], completionPatterns: [],
      retainedClaudeBinary: { enabled: true }, // the vitest default is off (host-independent argv tests); production default is on
    }, new StateManager(stateDir));
    server = new AgentServer({ config, sessionManager: sm, state: new StateManager(stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/claude-binary-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /sessions/claude-binary is alive (200, not 503) with the retainer ON', async () => {
    const res = await request(app).get('/sessions/claude-binary').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.enabled).toBe(true);
    expect(res.body.dir).toBe(path.join(tmpDir, '.instar', 'state', 'claude-bin'));
    expect(Array.isArray(res.body.retained)).toBe(true);
  });

  it('is Bearer-gated', async () => {
    const res = await request(app).get('/sessions/claude-binary');
    expect(res.status).toBe(401);
  });

  it('reflects a real spawn-chokepoint resolution: the retained copy exists on disk and the route names it', async () => {
    const launched = sm.resolveLaunchBinary('claude-code', claude);
    expect(launched).toBe(path.join(tmpDir, '.instar', 'state', 'claude-bin', '2.1.299', 'claude'));
    expect(fs.statSync(launched).nlink).toBeGreaterThan(0);
    const res = await request(app).get('/sessions/claude-binary').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.current).toEqual({ key: '2.1.299', version: '2.1.299', path: launched });
    expect(res.body.lastResolution.source).toBe('retained');
    const prune = await request(app).post('/sessions/claude-binary/prune').set(auth());
    expect(prune.status).toBe(200);
    expect(prune.body.keptCurrent).toEqual(['2.1.299']);
  });
});
