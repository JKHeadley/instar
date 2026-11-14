import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import { JevFirstDecision, type JevPoint } from '../../src/core/JevFirstDecision.js';
import { buildPromptJevFirst, promptDetectState } from '../../src/core/JevFirstPrompt.js';
import { InputDetector } from '../../src/monitoring/PromptGate.js';
import { setFeatureMetricsRecorder } from '../../src/core/CircuitBreakingIntelligenceProvider.js';

const AUTH = 'jev-first-integration';
function app(ledger: FeatureMetricsLedger | null) {
  const server = express();
  server.use(express.json());
  server.use(authMiddleware(() => AUTH, 'test'));
  server.use(createRoutes({
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, authToken: AUTH,
      sessions: {}, scheduler: {} },
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null },
    featureMetricsLedger: ledger,
    startTime: new Date(),
  } as unknown as RouteContext));
  return server;
}

describe('Jev-first summary HTTP pipeline', () => {
  it('requires auth and reports observed settlements without claiming token savings', async () => {
    const ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    try {
      const point: JevPoint = { id: 'commitment-detect', promptId: 'commitment-batch-v1',
        question: 'Is there a commitment?', stage: 'live', band: { noMax: 0.2, yesMin: 0.8 },
        model: 'jev-1.13.0', timeoutMs: 1000, maxStateBytes: 8000, auditRate: 0,
        settleOnly: 'no', fallbackSelection: 'incumbent-no-benchmark' };
      const gateway = new JevFirstDecision({
        readKey: () => 'test-key',
        askJev: async () => ({ model: 'jev-1.13.0', probability: 0.03, ms: 120, tokensIn: 80 }),
        recordDecision: () => 'provenance-1',
        onJevCall: (id, answer) => ledger.record({ feature: `jev-first-jev:${id}`, kind: 'llm',
          outcome: answer ? 'unclassified' : 'error', model: answer?.model,
          framework: 'typesafe-api', tokensIn: answer?.tokensIn, latencyMs: answer?.ms }),
        onOutcome: (id, reason, source, disagree) => {
          ledger.record({ feature: `jev-first:${id}`, kind: 'event',
            outcome: source === 'jev' ? 'fired' : 'noop', verdictId: reason });
          if (disagree !== null) ledger.record({ feature: `jev-first-audit:${id}`, kind: 'event',
            outcome: disagree ? 'fired' : 'noop' });
        },
      });
      let incumbentCalls = 0;
      const fallback = async () => { incumbentCalls++; return { answer: true, model: 'gpt-6-luna' }; };
      expect((await gateway.decide({ point, state: 'No request in this exchange.', fallback })).source).toBe('jev');
      expect((await gateway.decide({ point: { ...point, stage: 'off' }, state: 'An explicit request.', fallback })).source).toBe('incumbent');
      expect(incumbentCalls).toBe(1);
      expect((await request(app(ledger)).get('/jev-first/summary')).status).toBe(401);
      const res = await request(app(ledger)).get('/jev-first/summary?sinceHours=24')
        .set('Authorization', `Bearer ${AUTH}`);
      expect(res.status).toBe(200);
      expect(res.body.points).toEqual([expect.objectContaining({
        id: 'commitment-detect', decisions: 2, jevSettled: 1, incumbentHandled: 1,
        settledShare: 0.5, jevCalls: 1, jevTokensIn: 80, compared: 0,
        disagreements: 0, bigModelCallsAvoided: 1, bigModelTokensSaved: null,
      })]);
    } finally { ledger.close(); }
  });

  it('PromptGate prompt-detect shadow rows reach the summary; the incumbent still decides', async () => {
    const ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    setFeatureMetricsRecorder(ledger);
    try {
      const rows: unknown[] = [];
      const { gateway, getPoint } = buildPromptJevFirst({ stateDir: '/tmp/none', developmentAgent: true,
        readConfig: () => ({ enabled: true, stage: 'shadow' }),
        provenance: () => ({ recordDecisionFlushed: (r: unknown) => { rows.push(r); return `p-${rows.length}`; } }) as never,
        readKey: () => 'test-key',
        askJev: async () => ({ model: 'jev-1.13.0', probability: 0.04, ms: 9, tokensIn: 55 }) });
      const detector = new InputDetector({ detectionWindowLines: 50, enabled: true,
        intelligence: { evaluate: async () => 'NO_PROMPT' } as never,
        jevFirst: gateway, getJevPoint: getPoint, jevState: promptDetectState });
      for (let i = 0; i < 3; i++) detector.onCapture('int-session', 'All done here.\n❯ \n');
      for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
      await detector.lastJevShadow;
      expect(rows).toHaveLength(1);
      const res = await request(app(ledger)).get('/jev-first/summary?sinceHours=24')
        .set('Authorization', `Bearer ${AUTH}`);
      expect(res.status).toBe(200);
      expect(res.body.points).toEqual([expect.objectContaining({
        id: 'prompt-detect', decisions: 1, jevSettled: 0, incumbentHandled: 1, jevCalls: 1, jevTokensIn: 55,
      })]);
    } finally { setFeatureMetricsRecorder(null); ledger.close(); }
  });

  it('returns 503 when the metrics substrate is unavailable', async () => {
    const res = await request(app(null)).get('/jev-first/summary').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(503);
  });
});
