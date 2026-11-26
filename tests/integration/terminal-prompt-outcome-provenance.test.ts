/**
 * Integration (CMT-1677): a REAL PromptGate detector call through a REAL
 * IntelligenceRouter into a live DecisionQualityRecorderImpl + real
 * JudgmentProvenanceLog. After a simulated pane change the incumbent row, the
 * Jev shadow row and the pane outcome row all join on ONE router-minted
 * correlation id through GET /judgment-provenance, the outcome is graded
 * under terminal-prompt-detect on GET /decision-quality, and no pane text is
 * served on either route.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import { JudgmentProvenanceLog } from '../../src/core/JudgmentProvenanceLog.js';
import { IntelligenceRouter } from '../../src/core/IntelligenceRouter.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import type { IntelligenceProvider } from '../../src/core/types.js';
import {
  DecisionQualityRecorderImpl,
  annotateDecisionOutcome,
  installDecisionQualityRecorder,
} from '../../src/core/DecisionQualityRecorderImpl.js';
import { _resetDecisionQualityForTest, setDecisionQualityMachineId } from '../../src/core/decisionQualityTypes.js';
import { DP_TERMINAL_PROMPT_DETECT } from '../../src/data/provenanceCoverage.js';
import { InputDetector } from '../../src/monitoring/PromptGate.js';
import { PromptDetectOutcomeObserver } from '../../src/monitoring/PromptDetectOutcomeObserver.js';
import { buildPromptJevFirst, promptDetectState } from '../../src/core/JevFirstPrompt.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'test-terminal-prompt-outcome';
const PANE_MARKER = 'QX7_PANE_TEXT_MARKER';

let ledger: FeatureMetricsLedger | null = null;
let jpl: JudgmentProvenanceLog | null = null;
let tmpDir: string | null = null;

function ctxWith(): RouteContext {
  return {
    config: {
      projectName: 'test', projectDir: '/tmp', stateDir: tmpDir ?? '/tmp/.instar', port: 0, authToken: AUTH,
      developmentAgent: true,
      provenance: { uniformSeam: { enabled: true, dryRun: false } },
      sessions: {} as unknown, scheduler: {} as unknown,
    } as unknown,
    sessionManager: { listRunningSessions: () => [] } as unknown,
    state: { getJobState: () => null, getSession: () => null } as unknown,
    judgmentProvenance: jpl,
    featureMetricsLedger: ledger,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(ctx: RouteContext): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(() => AUTH, 'test'));
  app.use('/', createRoutes(ctx));
  return app;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-prompt-outcome-'));
  ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
  jpl = new JudgmentProvenanceLog({ dir: path.join(tmpDir, 'state', 'judgment-provenance'), log: () => {} });
  _resetDecisionQualityForTest();
  installDecisionQualityRecorder(new DecisionQualityRecorderImpl({
    ledger, judgmentProvenance: jpl,
    config: { developmentAgent: true, provenance: { uniformSeam: { enabled: true, dryRun: false } } },
  }));
});

afterEach(async () => {
  installDecisionQualityRecorder(null);
  _resetDecisionQualityForTest();
  ledger?.close();
  ledger = null;
  if (jpl) { await jpl.close(); jpl = null; }
  if (tmpDir) {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/terminal-prompt-outcome-provenance.test.ts' });
    tmpDir = null;
  }
});

async function settle(detector: InputDetector): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  await detector.lastJevShadow;
}

describe('terminal prompt-detect outcome joins its decision rows (CMT-1677)', () => {
  it('incumbent, Jev and outcome rows share one correlation id; no pane text is served', async () => {
    // A real multi-machine install: the router mints d-m_03b30f-<uuid>, with '_'.
    setDecisionQualityMachineId('m_03b30f5b32c6ef3eb0afd3ca7054e252');
    const defaultProvider: IntelligenceProvider = { async evaluate() { return 'NO_PROMPT'; } };
    const router = new IntelligenceRouter({
      defaultProvider, defaultFramework: 'claude-code' as IntelligenceFramework,
      resolveConfig: () => undefined, buildProvider: () => null,
    });
    const { gateway, getPoint } = buildPromptJevFirst({
      stateDir: tmpDir!, developmentAgent: true,
      readConfig: () => ({ enabled: true, stage: 'shadow' }),
      provenance: () => jpl,
      readKey: () => 'k', askJev: async () => ({ model: 'jev-1.13.0', probability: 0.04, ms: 4 }),
    });
    const detector = new InputDetector({
      detectionWindowLines: 50, enabled: true, intelligence: router,
      jevFirst: gateway, getJevPoint: getPoint, jevState: promptDetectState,
      outcomeObserver: new PromptDetectOutcomeObserver({ annotate: annotateDecisionOutcome }),
    });
    const pane = `${PANE_MARKER} finished the edit.\n❯ \n`;
    detector.onCapture('echo-int', pane);
    detector.onCapture('echo-int', pane);
    detector.onCapture('echo-int', pane);
    await settle(detector);
    detector.onCapture('echo-int', `${PANE_MARKER} moved on to the tests\n❯ \n`);
    await jpl!.flush();

    const app = appWith(ctxWith());
    const res = await request(app).get('/judgment-provenance?limit=100').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    const rows = res.body.rows as Array<Record<string, any>>;
    const incumbent = rows.find((r) => r.kind === 'decision' && r.decisionPoint === DP_TERMINAL_PROMPT_DETECT);
    expect(incumbent?.correlationId, 'the incumbent row carries the router-minted id').toMatch(/^d-/);
    const id = incumbent!.correlationId as string;
    const jev = rows.find((r) => r.kind === 'decision' && r.decisionPoint === 'prompt-detect');
    expect(jev, 'a Jev shadow row is served').toBeTruthy();
    // The join key is top-level: the served-context credential scrub masks id-shaped values.
    expect(id, 'a real multi-machine id carries the machine segment').toMatch(/^d-m_03b30f-/);
    expect(jev!.producerCorrelationId).toBe(id);
    expect(String(jev!.contextRedacted)).toContain('"sessionName":"echo-int"');
    const outcome = rows.find((r) => r.kind === 'outcome' && r.correlationId === id);
    expect(outcome).toMatchObject({ grade: 'right', ruleId: 'terminal-prompt-progressed-v1', gradedBy: 'PromptGate' });
    expect(outcome!.outcome).toMatchObject({ outcomeKind: 'progressed-without-input', evidenceClass: 'tool', incumbent: 'no-prompt' });
    const served = JSON.stringify(res.body);
    expect(served).not.toContain(PANE_MARKER);
    expect(served).not.toContain('_contentFull');

    const dq = await request(app).get('/decision-quality').set('Authorization', `Bearer ${AUTH}`);
    expect(dq.status).toBe(200);
    expect(JSON.stringify(dq.body)).not.toContain(PANE_MARKER);
    const point = (dq.body.points ?? dq.body.local?.points ?? []).find((p: any) => p.decisionPoint === DP_TERMINAL_PROMPT_DETECT);
    expect(point, 'terminal-prompt-detect is listed').toBeTruthy();
    expect(point.decisions).toBe(1);
    expect(point.gradeDistribution).toMatchObject({ right: 1, wrong: 0 });
    expect(point.byRule['terminal-prompt-progressed-v1']).toMatchObject({ right: 1 });
  });
});
