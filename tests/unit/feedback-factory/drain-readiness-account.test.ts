// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Readiness calls run on the account readinessAccountAdmission chooses. A refusal costs no
 * spend, defers the rows and never demotes the authority; a served call carries the account
 * override to the provider; the drain status names the serving account and whether its
 * credential identity still verified after the call.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import type { IntelligenceOptions } from '../../../src/core/types.js';
import { FeedbackProcessingService } from '../../../src/feedback-factory/processing/FeedbackProcessingService.js';
import { FeedbackDrainStore } from '../../../src/feedback-factory/drain/FeedbackDrainStore.js';
import { FeedbackReadinessArbiter } from '../../../src/feedback-factory/drain/FeedbackReadinessArbiter.js';
import { FeedbackDrainService } from '../../../src/feedback-factory/drain/FeedbackDrainService.js';
import type { FeedbackInitiativeConsumer } from '../../../src/feedback-factory/drain/FeedbackInitiativeConsumer.js';
import type { ReadinessAccountAdmission, ReadinessAdmission } from '../../../src/feedback-factory/drain/readinessAccountAdmission.js';
import type { VerifiedTriageAccount } from '../../../src/feedback-factory/triage/FeedbackTriageAccountSelector.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'feedback-drain-live-shapes.json');
const shapes = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { arbiterResolvedModel: { model: string; framework: string } };

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'drain-readiness-account.test.ts' }); });

const GMAIL: VerifiedTriageAccount = {
  accountId: 'codex-justin-gmail', configHome: '/tmp/codex-gmail', credentialVersion: 'v1', loginAccountId: 'login-1',
  limitFamily: 'codex', usedPercent: 13, acquiredAt: 0,
};

function setup(admit: (call: number) => ReadinessAdmission, opts: { verified?: boolean; revalidate?: boolean; pinned?: string | null } = {}) {
  let now = Date.parse('2026-11-26T09:00:00Z');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-readiness-account-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'clusters.jsonl'), Array.from({ length: 4 }, (_, i) => `${JSON.stringify({
    clusterId: `cluster-acct-${i}`, title: `Feedback ${i}`, type: 'bug', reportCount: 2, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z',
  })}\n`).join(''));
  fs.writeFileSync(path.join(dir, 'feedback.jsonl'), '');
  const store = new FeedbackDrainStore({ dbPath: ':memory:', tokenHmacKey: 'x'.repeat(32), clock: () => now });
  store.mutateAuthority({
    action: 'create', operatorDecisionRef: 'approval:operator-1', authorityId: 'feedback-readiness-default',
    agentId: 'echo', ownerMachineId: 'machine-a', ownerEpoch: 1, provider: 'codex-cli', modelFamily: 'gpt-6-astra',
    promptVersion: 'feedback-readiness-v1', schemaVersion: 'feedback-readiness-decision-v1', decisionPointId: 'feedback-cluster-readiness',
    maxBatch: 50, maxTokens: 1200, maxDailySpendUsd: 5,
  });
  const evaluateOptions: Array<IntelligenceOptions | undefined> = [];
  const arbiter = new FeedbackReadinessArbiter({
    evaluate: async (prompt, options) => {
      evaluateOptions.push(options);
      const packet = JSON.parse(prompt.slice(prompt.indexOf('Candidates: ') + 12)) as Array<{ clusterId: string }>;
      now += 1_000;
      options?.onModel?.(shapes.arbiterResolvedModel);
      return JSON.stringify({ decisions: packet.map(({ clusterId }) => ({
        clusterId, outcome: 'collecting', confidence: 0.4, reasonCodes: ['needs-more-reports'], evidenceIds: [`cluster:${clusterId}`],
      })) });
    },
  });
  let admits = 0;
  const admission: ReadinessAccountAdmission = {
    config: () => ({ mode: 'on', pinnedAccountId: opts.pinned === undefined ? null : opts.pinned }),
    admit: async () => admit(++admits),
    revalidate: () => opts.revalidate ?? true,
    verifyExecutionIdentity: () => opts.verified ?? true,
  };
  const service = new FeedbackDrainService({
    store, processing: new FeedbackProcessingService({ dataDir: dir }),
    consumer: { consume: async () => { throw new Error('consumer not used'); } } as unknown as FeedbackInitiativeConsumer,
    arbiter, authorityId: 'feedback-readiness-default', ownerHost: 'machine-a', ownerEpoch: () => 1,
    isCanonicalOwner: () => true, isConsumerLive: () => false, clock: () => now, readinessAccount: admission,
  });
  const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
  const usage = () => db.prepare(`SELECT committed_usd usd, decisions FROM authority_daily_usage`).get() as { usd: number; decisions: number } | undefined;
  const reasons = () => db.prepare(`SELECT reason_code FROM readiness ORDER BY cluster_id`).all() as Array<{ reason_code: string | null }>;
  return { service, store, evaluateOptions, usage, reasons, admitCalls: () => admits };
}

describe('readiness runs on the admitted account', () => {
  it('a served account reaches the provider as an account override with a launch guard', async () => {
    const h = setup(() => ({ kind: 'account', account: GMAIL, pinned: true }), { pinned: 'codex-justin-gmail' });
    const result = await h.service.tick();
    expect(result.result).toBe('succeeded');
    expect(h.evaluateOptions).toHaveLength(1);
    expect(h.evaluateOptions[0]?.accountOverride).toEqual({ accountId: 'codex-justin-gmail', configHome: '/tmp/codex-gmail' });
    expect(typeof h.evaluateOptions[0]?.launchGuard).toBe('function');
    expect(h.service.stats().readinessAccount).toMatchObject({
      mode: 'on', pinnedAccountId: 'codex-justin-gmail',
      last: { state: 'served', accountId: 'codex-justin-gmail', pinned: true, verified: true, usedPercent: 13 },
    });
  });

  it('reports verified=false when the credential changed during the call', async () => {
    const h = setup(() => ({ kind: 'account', account: GMAIL, pinned: false }), { verified: false });
    await h.service.tick();
    expect(h.service.readinessAccountStatus().last).toMatchObject({ state: 'served', verified: false });
  });

  it('a refusal reserves no spend, defers every row, records why, and does not demote', async () => {
    const h = setup(() => ({ kind: 'refused', reason: 'pinned-account-saturated', pinned: true }), { pinned: 'codex-justin-gmail' });
    const result = await h.service.tick();
    expect(result).toMatchObject({ result: 'degraded', reason: 'readiness-account-refused', reviewed: 0 });
    expect(h.evaluateOptions).toHaveLength(0);
    expect(h.usage()?.decisions ?? 0).toBe(0);
    expect(h.reasons().every((row) => row.reason_code === 'readiness-account-refused')).toBe(true);
    expect(h.store.lastReadinessDiagnosis()).toMatchObject({ diagnosis: { check: 'readiness-account-refused', message: 'pinned-account-saturated' } });
    const authority = h.store.getAuthority('feedback-readiness-default')!;
    expect(h.store.authorityPosture(authority.authorityId, authority.generation).mode).toBe('active');
    expect(h.store.readinessProgress(authority.authorityId, authority.generation).consecutiveFailedTicks).toBe(1);
    expect(h.service.stats().readinessAccount.last).toMatchObject({ state: 'refused', reason: 'pinned-account-saturated', pinned: true });
  });

  it('a shared admission calls the provider without an override, as before', async () => {
    const h = setup(() => ({ kind: 'shared', reason: 'selection-off', observedAccountId: null }));
    await h.service.tick();
    expect(h.evaluateOptions).toHaveLength(1);
    expect(h.evaluateOptions[0]?.accountOverride).toBeUndefined();
    expect(h.service.readinessAccountStatus().last).toMatchObject({ state: 'shared', reason: 'selection-off' });
  });

  it('without an admission the status still reports off with no pin and no last call', () => {
    const h = setup(() => ({ kind: 'shared', reason: 'selection-off', observedAccountId: null }));
    const bare = new FeedbackDrainService({
      store: h.store, processing: new FeedbackProcessingService({ dataDir: dirs[0] }),
      consumer: {} as FeedbackInitiativeConsumer, arbiter: null, authorityId: 'feedback-readiness-default',
      ownerHost: 'machine-a', ownerEpoch: () => 1, isCanonicalOwner: () => true, isConsumerLive: () => false,
    });
    expect(bare.readinessAccountStatus()).toEqual({ mode: 'off', pinnedAccountId: null, last: null });
  });
});
