// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" test for SEC-130.
 *
 * Boots the REAL AgentServer on the production init path with an auth token: a public /health
 * keeps its status and the degradation COUNT but carries no degradation text and no LLM
 * reliability detail; the same read with the bearer token carries the degradation text.
 */
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';

const AUTH = 'test-e2e-health-detail';
const tmpDirs: string[] = [];

function mkConfig(): { config: InstarConfig; stateDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-detail-e2e-')); tmpDirs.push(tmpDir);
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
  const config = {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH, dashboardPin: '482913', requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  } as unknown as InstarConfig;
  return { config, stateDir };
}
const sm = () => ({ listRunningSessions: () => [], getSession: () => null }) as never;

afterAll(() => { for (const d of tmpDirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/health-detail-authed-alive.test.ts' }); });

describe('SEC-130 E2E (health detail is authenticated-only, alive on the real server)', () => {
  it('public /health keeps status and count but not the degradation text; the bearer read has it', async () => {
    const { config, stateDir } = mkConfig();
    const server = new AgentServer({ config, sessionManager: sm(), state: new StateManager(stateDir) });
    await server.start();
    try {
      DegradationReporter.getInstance().report({
        feature: 'Sec130E2eProbe', primary: 'probe', fallback: 'probe fallback',
        reason: 'probe reason', impact: 'probe impact naming /Users/someone/private-path',
      });
      const anon = await request(server.getApp()).get('/health');
      expect(anon.status).toBe(200);
      expect(anon.body.status).toBe('degraded');
      expect(anon.body.degradations).toBeGreaterThan(0);
      expect(anon.body.degradationSummary).toBeUndefined();
      expect(anon.body.llmReliability).toBeUndefined();
      expect(JSON.stringify(anon.body)).not.toContain('private-path');

      const authed = await request(server.getApp()).get('/health').set('Authorization', `Bearer ${AUTH}`);
      expect(authed.status).toBe(200);
      expect(Array.isArray(authed.body.degradationSummary)).toBe(true);
      expect(JSON.stringify(authed.body.degradationSummary)).toContain('private-path');
    } finally { await server.stop(); DegradationReporter.resetForTesting(); }
  });
});
