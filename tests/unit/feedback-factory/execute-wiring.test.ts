// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Wiring integrity for the feedback executor's production construction (buildFeedbackExecutor):
 * the dependencies are real (not null, not no-ops) — the execute store shares the drain database
 * and the triage owner fence, the default ports are the production classes (SafeAttemptGit,
 * GhGateway, SandboxRuntimeRunner, DepsCache), the session port delegates to the SessionManager's
 * confined spawn, the identity facts read the real registries, and the triage service sees it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { FeedbackDrainStore, DrainConflictError } from '../../../src/feedback-factory/drain/FeedbackDrainStore.js';
import { InitiativeTracker } from '../../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { buildFeedbackTriage } from '../../../src/feedback-factory/triage/buildFeedbackTriage.js';
import { buildFeedbackExecutor, isInstarSourceCheckout, readIdentityFacts } from '../../../src/feedback-factory/execute/buildFeedbackExecutor.js';
import { SafeAttemptGit, GhGateway } from '../../../src/feedback-factory/execute/executorPorts.js';
import { SandboxRuntimeRunner } from '../../../src/feedback-factory/execute/ConfinedRunner.js';
import { DepsCache } from '../../../src/feedback-factory/execute/depsCache.js';
import type { InstarConfig } from '../../../src/core/types.js';
import type { FeedbackProcessingService } from '../../../src/feedback-factory/processing/FeedbackProcessingService.js';
import type { SessionManager } from '../../../src/core/SessionManager.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'execute-wiring.test.ts' }); });

function build(opts: { sessionManager?: SessionManager | null; execute?: Record<string, unknown> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'execute-wiring-'));
  dirs.push(dir);
  const drain = new FeedbackDrainStore({ dbPath: ':memory:', db: new Database(':memory:'), tokenHmacKey: 'k'.repeat(32) });
  const processing = { activeClusters: () => [], feedbackByCluster: () => new Map() } as unknown as FeedbackProcessingService;
  const config = { stateDir: path.join(dir, '.instar'), projectDir: dir, port: 4999, authToken: 't', projectName: 'p', feedbackFactory: { triage: {}, execute: { actionTopicId: 99, ...(opts.execute ?? {}) } } } as unknown as InstarConfig;
  const tracker = new InitiativeTracker(dir);
  const triage = buildFeedbackTriage({
    config, drainStore: drain, processing, initiativeTracker: tracker, intelligence: { evaluate: async () => '' },
    dataDir: path.join(dir, 'store'), tokenKey: Buffer.alloc(32, 1), ownerHost: 'm1', ownerMachineId: () => 'm1', ownerEpoch: () => 3,
    isCanonicalOwner: () => true, codexLiveUsageReader: null, subscriptionPool: null, telegram: null, raiseAttention: async () => {}, tunnelUrl: () => null,
  });
  const ctx = buildFeedbackExecutor({
    config, drainStore: drain, triage, processing, initiativeTracker: tracker, sessionManager: opts.sessionManager ?? null, selfMachineId: 'm1',
    ownerMachineId: () => 'm1', ownerEpoch: () => 3, isCanonicalOwner: () => true, enabled: () => true, quotaShedding: () => false, updatePending: () => false,
    raiseAttention: async () => {}, tunnelUrl: () => null,
  });
  triage.service.attachExecutor({ status: () => ctx.service.status(), executionStateFor: (id) => ctx.service.executionStateFor(id), actionItems: () => ctx.service.actionItems(), holdsItem: (id) => ctx.service.holdsItem(id) });
  return { ctx, drain, triage, dir };
}

describe('buildFeedbackExecutor wiring', () => {
  it('shares the drain database and the triage owner fence; ports are the production implementations', () => {
    const { ctx, drain } = build();
    const opts = (ctx.service as unknown as { opts: Record<string, unknown> }).opts;
    expect(opts.git).toBeInstanceOf(SafeAttemptGit);
    expect(opts.github).toBeInstanceOf(GhGateway);
    expect(opts.runner).toBeInstanceOf(SandboxRuntimeRunner);
    expect(opts.deps).toBeInstanceOf(DepsCache);
    expect(drain.sharedDatabase().prepare("SELECT name FROM sqlite_master WHERE name='execution'").get()).toEqual({ name: 'execution' });
    const row = ctx.store.claim(3, { initiativeId: 'i1', clusterId: 'c1', needsSpec: false, userFacing: false, leaseMs: 1000, maxStartsPerDay: 6 });
    expect(row?.attempt).toBe(1);
    expect(() => ctx.store.claim(2, { initiativeId: 'i2', clusterId: 'c2', needsSpec: false, userFacing: false, leaseMs: 1000, maxStartsPerDay: 6 })).toThrow(DrainConflictError);
  });

  it('no source checkout → no-source-repo; the triage summary shows the executor', async () => {
    const { ctx, triage } = build();
    expect((await ctx.service.refreshAvailability()).reason).toBe('no-source-repo');
    expect(triage.service.summary().executor).toEqual({ available: false, reason: 'no-source-repo' });
    expect(isInstarSourceCheckout(os.tmpdir())).toBe(false);
  });

  it('dry-run is the default: config without dryRun:false never starts work', () => {
    const { ctx } = build();
    expect(ctx.service.summary()).toMatchObject({ dryRun: true, limits: { maxConcurrent: 2, maxStartsPerDay: 6, maxOpenPrs: 4 } });
  });

  it('the session port delegates to the SessionManager confined spawn with omitAuthEnv and the claude-code adapter', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const sm = {
      spawnSession: async (o: Record<string, unknown>) => { calls.push(o); return { id: 'uuid-1', tmuxSession: 'proj-feedback-x' }; },
      isSessionAlive: (n: string) => n === 'proj-feedback-x',
      listRunningSessions: () => [{ id: 'uuid-1', tmuxSession: 'proj-feedback-x' }],
      killSession: () => true,
    } as unknown as SessionManager;
    const { ctx } = build({ sessionManager: sm });
    const sessions = (ctx.service as unknown as { opts: { sessions: { spawnConfined: (i: unknown) => Promise<unknown>; spawnTrusted: (i: unknown) => Promise<unknown>; isAlive: (n: string) => boolean; stop: (n: string) => Promise<boolean> } } }).opts.sessions;
    await expect(sessions.spawnConfined({ name: 'feedback-x', prompt: 'p', cwd: '/w', settingsPath: '/s.json', tmpDir: '/w-tmp', maxDurationMinutes: 60 })).resolves.toEqual({ sessionName: 'proj-feedback-x', sessionId: 'uuid-1' });
    expect(calls[0]).toMatchObject({ cwd: '/w', omitAuthEnv: true, framework: 'claude-code', confinement: { framework: 'claude-code', settingsPath: '/s.json', tmpDir: '/w-tmp' } });
    await sessions.spawnTrusted({ name: 'feedback-specconverge-x', prompt: 'p', maxDurationMinutes: 10 });
    expect(calls[1]).toMatchObject({ disableProjectMcp: true });
    expect(calls[1].omitAuthEnv).toBeUndefined();
    expect(sessions.isAlive('proj-feedback-x')).toBe(true);
    expect(await sessions.stop('proj-feedback-x')).toBe(true);
  });

  it('identity facts read the real registries (names only)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'execute-ids-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'playwright-profiles.json'), JSON.stringify({ profiles: [{ id: 'p', accounts: [{ service: 'github', identity: 'JK', owner: 'operator', vaultRefs: ['gh_jk'] }] }] }));
    fs.writeFileSync(path.join(dir, 'owned-identities.json'), JSON.stringify([{ service: 'github', identity: 'bot-test' }]));
    expect(readIdentityFacts(dir)).toEqual({ profileAccounts: [{ service: 'github', identity: 'JK', vaultRefs: ['gh_jk'] }], ownedIdentities: [{ service: 'github', identity: 'bot-test' }], vaultNames: null, unreadableSources: [] });
    expect(readIdentityFacts(path.join(dir, 'missing'))).toEqual({ profileAccounts: [], ownedIdentities: [], vaultNames: null, unreadableSources: [] });
    // A registry that exists but cannot be parsed fails closed (reported, never "no accounts").
    fs.writeFileSync(path.join(dir, 'state', 'playwright-profiles.json'), '{ corrupt');
    expect(readIdentityFacts(dir).unreadableSources).toEqual(['playwright-profiles']);
  });
});
