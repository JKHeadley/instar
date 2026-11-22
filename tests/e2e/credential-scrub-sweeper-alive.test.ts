// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" test for the SEC-164 credential sweeper
 * (docs/specs/credential-scrub-at-rest.md §16 E2E): boots the REAL AgentServer (the path server.ts uses).
 * - A development agent with `inPlace` on: the sweeper runs, a planted test key in a listed log is masked
 *   in place at the same length, and GET /credential-scrub answers 200 with the count, never the value.
 * - The settings file still holds its real key (the never-touch set).
 * Fake keys are built at run time so no key-shaped literal sits in the source.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const fakeKey = 'ghp_' + 'x'.repeat(36);
const AUTH = 'test-e2e-credential-scrub';

function makeConfig(tmpDir: string, stateDir: string): InstarConfig {
  return {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
    requestTimeoutMs: 10000, version: '0.0.0', developmentAgent: true,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
}

describe('SEC-164 credential sweeper (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-scrub-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
      port: 0, projectName: 'e2e', agentName: 'E2E', developmentAgent: true,
      security: { credentialScrub: { inPlace: true } }, planted: fakeKey,
    }));
    fs.writeFileSync(path.join(stateDir, 'logs', 'planted.log'), `boot\nleaked ${fakeKey} here\n`);
    server = new AgentServer({ config: makeConfig(tmpDir, stateDir), sessionManager: { listRunningSessions: () => [], getSession: () => null } as any, state: new StateManager(stateDir) });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/credential-scrub-sweeper-alive.test.ts' });
  });

  it('the production path built the sweeper, and a pass masks the planted key in place', async () => {
    const sweeper = server.getCredentialSweeper();
    expect(sweeper).not.toBeNull();
    const before = fs.statSync(path.join(stateDir, 'logs', 'planted.log')).size;
    await sweeper!.tick();
    const after = fs.readFileSync(path.join(stateDir, 'logs', 'planted.log'), 'utf8');
    expect(after).not.toContain(fakeKey);
    expect(after).toContain('[credential removed]');
    expect(Buffer.byteLength(after)).toBe(before);
  });

  it('GET /credential-scrub answers 200 with the count and never the value', async () => {
    const res = await request(server.getApp()).get('/credential-scrub').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('on');
    const masked = Object.values(res.body.roots.logs.masked as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(masked).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(res.body)).not.toContain(fakeKey);
  });

  it('the settings file keeps its real key', () => {
    expect(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8')).toContain(fakeKey);
  });
});
