/**
 * E2E — Disk Steward on the production path (spec docs/specs/disk-steward.md).
 *
 * Phase 1 ("is it alive"): the REAL wiring (createDiskSteward) behind the REAL
 * AgentServer route plumbing returns 200 with a real statfs reading, not 503.
 * Test-agent rung (§Maturation plan): a REAL prune child (the built
 * dist/monitoring/diskStewardMain.js) runs against a throwaway HOME holding a
 * fake npm cache and Xcode DerivedData, and removes only what the rules allow.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createDiskSteward } from '../../src/monitoring/diskSteward/wiring.js';

const AUTH = 'test-e2e-disk-steward';
const DIST_MAIN = path.resolve(__dirname, '../../dist/monitoring/diskStewardMain.js');

describe('Disk Steward E2E lifecycle', () => {
  let tmp: string;
  let server: AgentServer;
  let wired: ReturnType<typeof createDiskSteward>;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-e2e-'));
    const stateDir = path.join(tmp, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'ds-e2e', agentName: 'DS' }));
    const state = new StateManager(stateDir);
    wired = createDiskSteward({
      readConfig: () => ({ diskSteward: {}, developmentAgent: false }),
      stateDir, agentHome: tmp, agentName: 'ds-e2e', machineId: 'm_e2e', machineName: () => 'E2E Box',
      isHolder: () => true, peers: () => [], authToken: AUTH,
      getTopicId: () => state.get<number>('agent-disk-topic') ?? null, setTopicId: (id) => state.set('agent-disk-topic', id),
      canCreateTopic: () => false,
    });
    const config: InstarConfig = {
      projectName: 'ds-e2e', projectDir: tmp, stateDir, port: 0, authToken: AUTH, requestTimeoutMs: 10000, version: '0.10.3',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
    };
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as never, state,
      diskSteward: () => ({ steward: wired.steward, runner: wired.runner, machineId: 'm_e2e', peers: () => [], authToken: AUTH }) });
    await server.start();
  });

  afterAll(async () => {
    wired.steward.stop();
    await server.stop();
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/e2e/disk-steward-lifecycle.test.ts' });
  });

  it('GET /disk-steward returns 200 with a real reading through the real server plumbing', async () => {
    await wired.steward.tick();
    const res = await request(server.getApp()).get('/disk-steward').set({ Authorization: `Bearer ${AUTH}` });
    expect(res.status).toBe(200);
    expect(res.body.measured).toBe(true);
    expect(res.body.totalBytes).toBeGreaterThan(0);
    expect(res.body.freeBytes).toBeGreaterThan(0);
    expect(res.body.thresholds.floor).toBeGreaterThan(0);
    expect(res.body.machine.name).toBe('E2E Box');
  });

  it('test-agent rung: a real prune child removes only the old Xcode-named build folder and the npm cache', () => {
    expect(fs.existsSync(DIST_MAIN)).toBe(true);
    const home = path.join(tmp, 'home');
    const npmCache = path.join(home, '.npm');
    fs.mkdirSync(path.join(npmCache, '_cacache', 'content-v2'), { recursive: true });
    fs.writeFileSync(path.join(npmCache, '_cacache', 'content-v2', 'blob'), Buffer.alloc(64 * 1024));
    const dd = path.join(home, 'Library', 'Developer', 'Xcode', 'DerivedData');
    const old = new Date(Date.now() - 3 * 86_400_000);
    const mk = (name: string, when: Date) => {
      fs.mkdirSync(path.join(dd, name, 'Logs', 'Build'), { recursive: true });
      fs.writeFileSync(path.join(dd, name, 'Build.db'), 'x');
      for (const p of [path.join(dd, name, 'Logs', 'Build'), path.join(dd, name, 'Logs'), path.join(dd, name)]) fs.utimesSync(p, when, when);
    };
    mk('App-abcdefghijklmnopqrstuvwxyzab', old);
    mk('App-bcdefghijklmnopqrstuvwxyzabc', new Date());
    mk('MyProject', old);
    const runId = 'a'.repeat(24);
    const resultPath = path.join(tmp, 'result.json');
    const input = {
      runId, agent: 'ds-e2e', agentHome: tmp, trigger: 'manual', requestedBy: null, dryRun: false,
      npmCacheMaxGiB: 0.00001, categoryBudgetMs: 120_000, measure: false, resultPath, auditPath: path.join(tmp, 'audit.jsonl'),
    };
    const npmOk = spawnSync('npm', ['--version'], { encoding: 'utf-8' }).status === 0;
    const r = spawnSync(process.execPath, [DIST_MAIN, '--run-id', runId, '--input-json', JSON.stringify(input)], {
      env: { ...process.env, HOME: home, npm_config_cache: npmCache }, encoding: 'utf-8', timeout: 180_000,
    });
    expect(r.status).toBe(0);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    expect(fs.readFileSync(input.auditPath, 'utf8')).toContain('"event":"prune-run"');
    const byCat = Object.fromEntries(result.categories.map((c: { category: string }) => [c.category, c]));
    if (npmOk) {
      expect(byCat['npm-cache'].removedItems).toBe(1);
      expect(fs.existsSync(path.join(npmCache, '_cacache', 'content-v2', 'blob'))).toBe(false);
    }
    if (process.platform === 'darwin') {
      const xcodeRunning = (() => { try { return /\b(xcodebuild|XCBBuildService|SourceKitService|Xcode)\b/.test(execFileSync('ps', ['-axo', 'comm'], { encoding: 'utf-8' })); } catch { return true; } })();
      if (!xcodeRunning) {
        expect(fs.existsSync(path.join(dd, 'App-abcdefghijklmnopqrstuvwxyzab'))).toBe(false);
      }
      expect(fs.existsSync(path.join(dd, 'App-bcdefghijklmnopqrstuvwxyzabc'))).toBe(true); // fresh
      expect(fs.existsSync(path.join(dd, 'MyProject'))).toBe(true); // not named by Xcode
    } else {
      expect(byCat['derived-data'].skipped).toBe('not-macos');
    }
  });
});
