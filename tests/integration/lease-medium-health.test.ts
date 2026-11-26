import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { selectLeaseMedium, type LeaseMediumSelection } from '../../src/core/leaseMediumSelection.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/lease-medium-health.test.ts:cleanup' }); });

function makeRepo(): { dir: string; registry: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-health-'));
  dirs.push(dir);
  SafeGitExecutor.execSync(['init', '-q'], { cwd: dir, stdio: 'ignore', operation: 'tests/integration/lease-medium-health.test.ts:init-repo' });
  const registry = path.join(dir, '.instar/machines/registry.json');
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, '{}');
  return { dir, registry };
}

async function health(selection: LeaseMediumSelection): Promise<Record<string, string>> {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-health-http-'));
  dirs.push(projectDir);
  const stateDir = path.join(projectDir, '.instar');
  const token = crypto.randomBytes(16).toString('hex');
  const coordinator = new MultiMachineCoordinator(new StateManager(stateDir), { stateDir });
  const store = selection.medium === 'local' ? 'LocalLeaseStore' : 'GitLeaseStore';
  coordinator.attachLeaseMediumProvider(() => ({ ...selection, store }));
  const ctx = {
    config: { projectName: 'test', projectDir, stateDir, port: 0, authToken: token },
    sessionManager: { listRunningSessions: () => [], getCachedRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null },
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    correctionLedger: null, coordinator, startTime: new Date(),
  } as unknown as RouteContext;
  const router = createRoutes(ctx);
  const response = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    let status = 200;
    const headers = new Map<string, unknown>();
    const res = {
      status(code: number) { status = code; return this; },
      json(body: Record<string, unknown>) { resolve({ status, body }); return this; },
      send(body: Record<string, unknown>) { resolve({ status, body }); return this; },
      end() { resolve({ status, body: {} }); return this; },
      setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return this; },
      getHeader(name: string) { return headers.get(name.toLowerCase()); },
      removeHeader(name: string) { headers.delete(name.toLowerCase()); },
    };
    router.handle(
      { method: 'GET', url: '/health', originalUrl: '/health', headers: { authorization: `Bearer ${token}` } } as never,
      res as never,
      (err?: unknown) => err ? reject(err) : reject(new Error('health route fell through')),
    );
  });
  expect(response.status).toBe(200);
  return (response.body.multiMachine as { syncStatus: { leaseMedium: Record<string, string> } }).syncStatus.leaseMedium;
}

describe('GET /health leaseMedium — real HTTP pipeline', () => {
  it.each([
    ['tracked', (dir: string, registry: string) => SafeGitExecutor.execSync(['add', registry], { cwd: dir, stdio: 'ignore', operation: 'tests/integration/lease-medium-health.test.ts:add-registry' }), true, undefined, 'git', 'GitLeaseStore'],
    ['untracked-addable', () => {}, true, undefined, 'git', 'GitLeaseStore'],
    ['ignored', (dir: string) => fs.writeFileSync(path.join(dir, '.gitignore'), '.instar/machines/\n'), true, undefined, 'local', 'LocalLeaseStore'],
    ['no-git-sync-manager', () => {}, false, undefined, 'local', 'LocalLeaseStore'],
    ['switch-off', () => {}, true, false, 'unchecked', 'GitLeaseStore'],
  ] as const)('serves %s with medium, reason and actual store', async (reason, arrange, hasManager, enabled, medium, store) => {
    const { dir, registry } = makeRepo();
    arrange(dir, registry);
    const selection = selectLeaseMedium({
      projectDir: dir,
      registryAbsPath: registry,
      hasGitSyncManager: hasManager,
      mediumCheckEnabled: enabled,
    });
    expect(selection).toEqual({ medium, reason });
    expect(await health(selection)).toEqual({ medium, reason, store });
  });
});
