/**
 * Integration tests for GET /metrics/features (per-feature LLM metrics).
 * Spec: docs/specs/llm-feature-metrics-spec.md (Phase 1a).
 *
 * Exercises the real FeatureMetricsLedger behind the real Express route:
 * 200 + rollup when the ledger is present, 503 when it is null, and the
 * ?feature= filter.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import { CompletionClaimVerifier } from '../../src/monitoring/CompletionClaimVerifier.js';
import type { ExtractedClaim } from '../../src/monitoring/ClaimObservation.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let ledger: FeatureMetricsLedger | null = null;

function ctxWith(metricsLedger: FeatureMetricsLedger | null, verifier?: CompletionClaimVerifier): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null,
    tokenLedger: null,
    featureMetricsLedger: metricsLedger,
    completionClaimVerifier: verifier ?? null,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(metricsLedger: FeatureMetricsLedger | null, verifier?: CompletionClaimVerifier): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctxWith(metricsLedger, verifier)));
  return app;
}

afterEach(() => {
  ledger?.close();
  ledger = null;
});

describe('GET /metrics/features (integration)', () => {
  it('returns 200 + per-feature rollup when the ledger is present', async () => {
    ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    ledger.record({ feature: 'MessagingToneGate', outcome: 'noop', tokensIn: 100, tokensOut: 20, latencyMs: 400 });
    ledger.record({ feature: 'MessagingToneGate', outcome: 'fired', tokensIn: 110, tokensOut: 25, latencyMs: 600 });
    ledger.record({ feature: 'CoherenceReviewer', outcome: 'noop', tokensIn: 900, tokensOut: 70, latencyMs: 1500 });

    const res = await request(appWith(ledger)).get('/metrics/features');

    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.totals.calls).toBe(3);
    expect(res.body.totals.fired).toBe(1);
    const tone = res.body.features.find((f: any) => f.feature === 'MessagingToneGate');
    expect(tone.calls).toBe(2);
    expect(tone.tokensIn).toBe(210);
    expect(tone.fireRate).toBeCloseTo(0.5, 5);
  });

  it('surfaces provider/model + fired through the route (Observable Intelligence)', async () => {
    ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    ledger.record({ feature: 'MessageSentinel', outcome: 'fired', model: 'gpt-5.4-mini', framework: 'codex-cli' });
    ledger.record({ feature: 'MessageSentinel', outcome: 'noop', model: 'gpt-5.4-mini', framework: 'codex-cli' });

    const res = await request(appWith(ledger)).get('/metrics/features');

    expect(res.status).toBe(200);
    const ms = res.body.features.find((f: any) => f.feature === 'MessageSentinel');
    expect(ms.frameworks).toEqual(['codex-cli']);
    expect(ms.models).toEqual(['gpt-5.4-mini']);
    expect(ms.fired).toBe(1);
    expect(ms.shed).toBe(0);
    expect(ms.fireRate).toBeCloseTo(0.5, 5);
  });

  it('503s when the feature-metrics ledger is unavailable', async () => {
    const res = await request(appWith(null)).get('/metrics/features');
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('feature-metrics');
  });

  it('honors the ?feature= filter', async () => {
    ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    ledger.record({ feature: 'A', outcome: 'fired' });
    ledger.record({ feature: 'B', outcome: 'noop' });

    const res = await request(appWith(ledger)).get('/metrics/features').query({ feature: 'A' });

    expect(res.status).toBe(200);
    expect(res.body.features.length).toBe(1);
    expect(res.body.features[0].feature).toBe('A');
    // totals still reflect the whole ledger; only the features[] list is filtered.
    expect(res.body.totals.calls).toBe(2);
  });

  it('surfaces server-admitted-only general refuted and unverifiable-high verdict metrics', async () => {
    ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-metrics-route-'));
    try {
      const message = 'The action completed and capacity is four.';
      const base: ExtractedClaim = {
        clauseId: 0, kind: 'completion', subjectKind: 'tool-action', predicate: 'tool-action.completed',
        operand: { type: 'boolean', value: true }, comparator: 'eq',
        subjectSelector: { type: 'same-turn-action', actionIndex: 0 }, consequence: { relation: 'none', actionClass: 'none' },
        sourceStartByte: 0, sourceEndByte: Buffer.byteLength(message), referencedEntityHints: [], endorsed: true,
        negated: false, hedged: false, quoted: false, suggestedCriticality: 'low', confidence: 0.99, tenseScope: 'past',
      };
      const claims: ExtractedClaim[] = [base, { ...base, clauseId: 1, kind: 'capacity-limit',
        subjectKind: 'capacity-model', predicate: 'capacity.limit', operand: { type: 'integer', value: 4, unit: 'lanes' },
        subjectSelector: { type: 'unresolved' }, tenseScope: 'current' }];
      const verifier = new CompletionClaimVerifier({ intelligence: {} as any, stateDir, enabled: true,
        dryRun: true, generalObservation: true, arbiter: { arbitrate: async () => ({
          authoritative: true, clauses: [], general: { schemaVersion: 1, claims, saturated: false },
        }) } as any });
      expect(verifier.enqueue(message, { hadToolCalls: true,
        toolCalls: [{ tool: 'Bash', actionKind: 'other', ok: false }], truncated: false, unavailable: false, canaryOk: true }))
        .toEqual({ accepted: true });
      await vi.waitFor(() => expect(verifier.stats().generalVerdicts.refuted).toBe(1));

      const res = await request(appWith(ledger, verifier)).get('/metrics/features');
      expect(res.status).toBe(200);
      expect(res.body.claimVerificationServerAdmittedOnly.generalVerdicts).toMatchObject({ refuted: 1, unverifiable: 1 });
      expect(res.body.claimVerificationServerAdmittedOnly.unverifiableByCriticality.high).toBe(1);
    } finally { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'claim-metrics-route-test' }); }
  });
});

describe('GET /metrics/features — token-audit-completeness enrichment', () => {
  it('returns byModel per feature, totals.byModel, usageCoverage, and both unlabeled shares', async () => {
    ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    ledger.record({ feature: 'GateA', outcome: 'noop', tokensIn: 100, tokensOut: 10, tokensCached: 40, model: 'haiku', framework: 'claude-code' });
    ledger.record({ feature: 'GateA', outcome: 'fired', tokensIn: 50, tokensOut: 5, model: 'gpt-5.4-mini', framework: 'codex-cli' });
    ledger.record({ feature: 'unlabeled', outcome: 'noop', tokensIn: 50, tokensOut: 5, model: 'haiku', framework: 'claude-code' });

    const res = await request(appWith(ledger)).get('/metrics/features');

    expect(res.status).toBe(200);
    const a = res.body.features.find((f: any) => f.feature === 'GateA');
    expect(a.byModel).toHaveLength(2);
    expect(a.tokensCached).toBe(40);
    const haikuRow = a.byModel.find((m: any) => m.model === 'haiku');
    expect(haikuRow.framework).toBe('claude-code');
    expect(haikuRow.tokensIn).toBe(100);
    expect(haikuRow.tokensCached).toBe(40);

    expect(res.body.totals.byModel.length).toBeGreaterThanOrEqual(2);
    const haikuTotal = res.body.totals.byModel.find((m: any) => m.model === 'haiku');
    expect(haikuTotal.tokensIn).toBe(150); // GateA + unlabeled

    const cov = res.body.totals.usageCoverage;
    expect(cov.find((c: any) => c.framework === 'claude-code').coverage).toBeCloseTo(1.0, 5);
    expect(cov.find((c: any) => c.framework === 'codex-cli').coverage).toBeCloseTo(1.0, 5);

    expect(res.body.totals.unlabeledTokenShare).toBeCloseTo(55 / 220, 5);
    expect(res.body.totals.unlabeledCallShare).toBeCloseTo(1 / 3, 5);
  });

  it('?feature= composes with the per-model breakdown (totals.byModel narrows too)', async () => {
    ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    ledger.record({ feature: 'A', outcome: 'noop', tokensIn: 10, tokensOut: 1, model: 'haiku', framework: 'claude-code' });
    ledger.record({ feature: 'B', outcome: 'noop', tokensIn: 99, tokensOut: 9, model: 'gpt-5.4-mini', framework: 'codex-cli' });

    const res = await request(appWith(ledger)).get('/metrics/features').query({ feature: 'A' });

    expect(res.status).toBe(200);
    expect(res.body.features).toHaveLength(1);
    expect(res.body.features[0].byModel).toHaveLength(1);
    expect(res.body.features[0].byModel[0].model).toBe('haiku');
    // totals.byModel narrows to the selected feature's partition.
    expect(res.body.totals.byModel).toHaveLength(1);
    expect(res.body.totals.byModel[0].model).toBe('haiku');
  });

  it('usageCoverage reports a zero-coverage codex framework honestly (the drift surface)', async () => {
    ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    ledger.record({ feature: 'Sweep', outcome: 'noop', model: 'gpt-5.4-mini', framework: 'codex-cli' });
    ledger.record({ feature: 'Sweep', outcome: 'noop', model: 'gpt-5.4-mini', framework: 'codex-cli' });

    const res = await request(appWith(ledger)).get('/metrics/features');
    const codex = res.body.totals.usageCoverage.find((c: any) => c.framework === 'codex-cli');
    expect(codex.successRows).toBe(2);
    expect(codex.coverage).toBe(0);
    expect(codex.exempt).toBe(false); // codex is NOT exempt — 0 here is the alarm, not noise
  });
});
