import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { JobDefinition } from '../../src/core/types.js';
import { generateSigningKeyPair } from '../../src/core/MachineIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { JobCoverageStore, acceptJobCoverage, assignJobCoverageGeneration, compareJobCoverage, projectJobCoverage, signJobCoverage } from '../../src/core/JobCoverage.js';
import { PromotionCatchUpStore } from '../../src/scheduler/PromotionCatchUpStore.js';
import { readRecentPromotion, requestRoleRestart } from '../../src/core/roleFollowRestart.js';

const machineA = 'm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const machineB = 'm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
function job(slug: string, overrides: Partial<JobDefinition> = {}): JobDefinition {
  return { slug, name: slug, description: slug, schedule: '0 * * * *', enabled: true,
    execute: { type: 'prompt', value: 'token=do-not-copy' }, gate: 'echo secret',
    priority: 'low', expectedDurationMinutes: 5, model: 'sonnet', ...overrides } as JobDefinition;
}
function temp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-job-coverage-')); }

describe('signed lease job coverage', () => {
  it('sends only metadata and binds the response to the intended machine and nonce', () => {
    const keys = generateSigningKeyPair();
    const payload = projectJobCoverage(machineA, [job('gci', { catchUpPolicy: 'ask' })]);
    const wire = signJobCoverage(payload, 'a'.repeat(64), keys.privateKey);
    expect(JSON.stringify(wire)).not.toContain('do-not-copy');
    expect(JSON.stringify(wire)).not.toContain('echo secret');
    expect(acceptJobCoverage(wire, machineA, 'a'.repeat(64), keys.publicKey)).toEqual(payload);
    expect(acceptJobCoverage(wire, machineB, 'a'.repeat(64), keys.publicKey)).toBeNull();
    expect(acceptJobCoverage(wire, machineA, 'b'.repeat(64), keys.publicKey)).toBeNull();
    expect(acceptJobCoverage({ ...wire, jobs: [] }, machineA, 'a'.repeat(64), keys.publicKey)).toBeNull();
  });

  it('keeps a last good offline snapshot and reports a missing job after takeover', () => {
    const dir = temp();
    try {
      const store = new JobCoverageStore(dir);
      const full = projectJobCoverage(machineA, [job('gci')]);
      store.record(full, new Date('2026-10-26T00:00:00Z'));
      store.markUnavailable(machineA, 'offline');
      store.record(projectJobCoverage(machineA, [], false), new Date('2026-10-27T00:00:00Z'));
      const observed = store.list(Date.parse('2026-10-28T00:00:00Z'));
      expect(observed[machineA].payload.jobs.map(j => j.slug)).toEqual(['gci']);
      expect(observed[machineA].observedAt).toBe('2026-10-26T00:00:00.000Z');
      expect(compareJobCoverage([], observed, machineB, 'studio')).toMatchObject([
        { slug: 'gci', reason: 'missing', sourceMachineId: machineA, stale: true },
      ]);
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'lease-job-coverage-test-cleanup' }); }
  });

  it('reports a changed schedule and a machine pin from a verified peer', () => {
    const dir = temp();
    try {
      const store = new JobCoverageStore(dir);
      store.record(projectJobCoverage(machineA, [job('gci'), job('pinned')]));
      const observed = store.list();
      const local = projectJobCoverage(machineB, [
        job('gci', { schedule: '0 2 * * *' }),
        job('pinned', { machines: [machineA] }),
      ]);
      expect(compareJobCoverage(local.jobs, observed, machineB, 'studio')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ slug: 'gci', reason: 'conflict' }),
          expect.objectContaining({ slug: 'pinned', reason: 'pinned' }),
        ]),
      );
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'lease-job-coverage-test-cleanup' }); }
  });

  it('assigns monotonic source generations and rejects an older observed version', () => {
    const dir = temp();
    try {
      const first = assignJobCoverageGeneration(projectJobCoverage(machineA, [job('gci')]), dir);
      const same = assignJobCoverageGeneration(projectJobCoverage(machineA, [job('gci')]), dir);
      const second = assignJobCoverageGeneration(projectJobCoverage(machineA, [job('gci'), job('audit')]), dir);
      expect(same.generation).toBe(first.generation);
      expect(parseInt(second.generation.split(':')[0], 16)).toBeGreaterThan(parseInt(first.generation.split(':')[0], 16));
      const store = new JobCoverageStore(dir);
      store.record(second);
      store.record(first);
      expect(store.read()[machineA].status).toBe('unavailable');
      expect(store.read()[machineA].payload.generation).toBe(second.generation);
      store.record({ ...first, generation: second.generation.split(':')[0] + ':' + first.generation.split(':')[1] });
      expect(store.read()[machineA].payload.generation).toBe(second.generation);
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'lease-job-coverage-test-cleanup' }); }
  });

  it('persists an unavailable peer before it has ever produced a snapshot', () => {
    const dir = temp();
    try {
      const store = new JobCoverageStore(dir);
      store.markUnavailable(machineA, 'no-reachable-url');
      expect(new JobCoverageStore(dir).read()[machineA]).toMatchObject({ status: 'unavailable',
        error: 'no-reachable-url', payload: { complete: false, jobs: [] } });
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'lease-job-coverage-test-cleanup' }); }
  });

  it('labels over-cap catalogs incomplete', () => {
    const jobs = Array.from({ length: 501 }, (_, i) => job(`job-${i}`));
    const payload = projectJobCoverage(machineA, jobs);
    expect(payload.jobs).toHaveLength(500);
    expect(payload.complete).toBe(false);
  });
});

describe('promotion catch-up admission', () => {
  it('records one automatic request across restart and exposes a recent promotion id', () => {
    const dir = temp();
    try {
      requestRoleRestart({ stateDir: dir, now: () => 1000, leaseEpoch: 7, machineId: machineB }, true);
      const promotion = readRecentPromotion(dir, 1001, { leaseEpoch: 7, machineId: machineB, holdsLease: true });
      expect(promotion?.verified).toBe(true);
      expect(readRecentPromotion(dir, 1000 + 60 * 60_000 + 1, { leaseEpoch: 7, machineId: machineB, holdsLease: true })?.verified).toBe(false);
      const store = new PromotionCatchUpStore(dir);
      expect(store.record(promotion!.id, 'gci', 'requested')).toBe(true);
      expect(new PromotionCatchUpStore(dir).record(promotion!.id, 'gci', 'requested')).toBe(false);
      expect(store.get(promotion!.id, 'gci')?.status).toBe('requested');
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'lease-job-coverage-test-cleanup' }); }
  });
});

describe('peer polling and promotion attention', () => {
  it('accepts a direct signed peer answer and refuses redirects for the bearer', async () => {
    const dir = temp();
    const keys = generateSigningKeyPair();
    const { JobCoverageMonitor } = await import('../../src/core/JobCoverageMonitor.js');
    const identityManager = {
      loadIdentity: () => ({ machineId: machineB, name: 'studio' }),
      loadRegistry: () => ({ machines: { [machineA]: { status: 'active' } } }),
      getSigningPublicKeyPem: () => keys.publicKey,
    } as any;
    let redirectMode: unknown;
    const previous = global.fetch;
    global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      redirectMode = init?.redirect;
      const nonce = new URL(String(_url)).searchParams.get('nonce')!;
      return new Response(JSON.stringify(signJobCoverage(projectJobCoverage(machineA, [job('gci')]), nonce, keys.privateKey)),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const monitor = new JobCoverageMonitor({ stateDir: dir, jobsFile: path.join(dir, 'jobs.json'),
        projectDir: dir, port: 4040, authToken: 'test-bearer', identityManager,
        isAwake: () => false, peerUrls: () => [{ machineId: machineA, url: 'http://127.0.0.1:9876', kind: 'lan' }],
        alert: async () => {}, reconcileDefaults: () => [] });
      await monitor.poll();
      expect(redirectMode).toBe('manual');
      expect(monitor.store.read()[machineA].payload.jobs.map(j => j.slug)).toEqual(['gci']);
    } finally { global.fetch = previous; SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'lease-job-coverage-test-cleanup' }); }
  });

  it('retries a failed alert after an hour, reminds daily, and closes on repair', async () => {
    const dir = temp();
    const jobsFile = path.join(dir, 'jobs.json');
    fs.writeFileSync(jobsFile, '[]');
    const { JobCoverageMonitor } = await import('../../src/core/JobCoverageMonitor.js');
    const identityManager = {
      loadIdentity: () => ({ machineId: machineB, name: 'studio' }),
      loadRegistry: () => ({ machines: { [machineA]: { status: 'active' } } }),
    } as any;
    let now = Date.parse('2026-10-27T00:00:00Z');
    let attempts = 0;
    const monitor = new JobCoverageMonitor({ stateDir: dir, jobsFile, projectDir: dir, port: 4040,
      authToken: 'test', identityManager, isAwake: () => true, peerUrls: () => [],
      now: () => now, reconcileDefaults: () => [],
      alert: async () => { attempts++; if (attempts === 1) throw new Error('offline'); } });
    try {
      monitor.store.record(projectJobCoverage(machineA, [job('gci')]), new Date(now));
      await monitor.checkPromotionCoverage();
      await monitor.checkPromotionCoverage();
      expect(attempts).toBe(1);
      now += 60 * 60_000 + 1;
      await monitor.checkPromotionCoverage();
      expect(attempts).toBe(2);
      await monitor.checkPromotionCoverage();
      expect(attempts).toBe(2);
      now += 24 * 60 * 60_000 + 1;
      monitor.store.record(projectJobCoverage(machineA, [job('gci')]), new Date(now));
      await monitor.checkPromotionCoverage();
      expect(attempts).toBe(3);
      fs.writeFileSync(jobsFile, JSON.stringify([job('gci')]));
      await monitor.checkPromotionCoverage();
      expect(fs.existsSync(path.join(dir, 'state', 'job-coverage-alert.json'))).toBe(false);
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'lease-job-coverage-test-cleanup' }); }
  });
});

describe('safe catalog repair and dependencies', () => {
  it('adds shipped defaults without changing a custom job and keeps git-sync disabled', async () => {
    const dir = temp();
    try {
      const file = path.join(dir, 'jobs.json');
      const custom = job('custom-client-job', { enabled: false });
      fs.writeFileSync(file, JSON.stringify([custom]));
      const { reconcileLegacyDefaultJobs } = await import('../../src/scheduler/JobCatalogReconcile.js');
      const installed = reconcileLegacyDefaultJobs(file, 4040);
      const current = JSON.parse(fs.readFileSync(file, 'utf8')) as JobDefinition[];
      expect(installed.length).toBeGreaterThan(0);
      expect(current.find(j => j.slug === 'custom-client-job')).toEqual(custom);
      expect(current.find(j => j.slug === 'git-sync')?.enabled).toBe(false);
      expect(reconcileLegacyDefaultJobs(file, 4040)).toEqual([]);
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'lease-job-coverage-test-cleanup' }); }
  });

  it('rejects traversal and secret paths, and treats symlinks as missing', async () => {
    const dir = temp();
    try {
      const { validJobDependencyPath, jobDependencyExists } = await import('../../src/core/JobDependency.js');
      fs.mkdirSync(path.join(dir, 'safe'));
      fs.writeFileSync(path.join(dir, 'safe', 'ok.txt'), 'ok');
      fs.symlinkSync(os.tmpdir(), path.join(dir, 'outside'));
      expect(validJobDependencyPath('../outside')).toBe(false);
      expect(validJobDependencyPath('.instar/config.json')).toBe(false);
      expect(jobDependencyExists(dir, 'safe/ok.txt')).toBe(true);
      expect(jobDependencyExists(dir, 'outside/secret')).toBe(false);
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'lease-job-coverage-test-cleanup' }); }
  });

  it('refuses a corrupt catch-up journal before another automatic request', () => {
    const dir = temp();
    try {
      fs.mkdirSync(path.join(dir, 'state'));
      fs.writeFileSync(path.join(dir, 'state', 'promotion-catch-up.json'), '{');
      const store = new PromotionCatchUpStore(dir);
      expect(store.isHealthy()).toBe(false);
      expect(() => store.record('p', 'gci', 'requested')).toThrow();
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'lease-job-coverage-test-cleanup' }); }
  });
});
