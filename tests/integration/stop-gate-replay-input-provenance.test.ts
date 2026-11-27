/**
 * Integration (CMT-2204): a REAL UnjustifiedStopGate evaluation with replay-input
 * capture on, through a REAL IntelligenceRouter into a live DecisionQualityRecorderImpl
 * + real JudgmentProvenanceLog, is served by GET /judgment-provenance WITHOUT the
 * captured stop reason or turns, while the machine-local row keeps a capture that
 * passes the replay sha check and the verdict head the model returned.
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
import {
  IntelligenceRouter,
  type ComponentFrameworksConfig,
} from '../../src/core/IntelligenceRouter.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';
import { UnjustifiedStopGate, assessStopGateReplayEligibility } from '../../src/core/UnjustifiedStopGate.js';
import {
  DecisionQualityRecorderImpl,
  installDecisionQualityRecorder,
} from '../../src/core/DecisionQualityRecorderImpl.js';
import { _resetDecisionQualityForTest } from '../../src/core/decisionQualityTypes.js';
import { DP_UNJUSTIFIED_STOP_GATE } from '../../src/data/provenanceCoverage.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'test-stop-replay-provenance';

let ledger: FeatureMetricsLedger | null = null;
let jpl: JudgmentProvenanceLog | null = null;
let tmpDir: string | null = null;

/**
 * A REAL router over a stub default provider that returns the tone verdict.
 * The router mints the correlation id and fires the settlement seam — exactly
 * the production path (nothing about provenance is stubbed).
 */
function makeRouter(reply: string): { router: IntelligenceRouter } {
  const defaultProvider: IntelligenceProvider = {
    async evaluate(_prompt: string, _opts?: IntelligenceOptions): Promise<string> {
      return reply;
    },
  };
  const cfg: ComponentFrameworksConfig | undefined = undefined;
  const router = new IntelligenceRouter({
    defaultProvider,
    defaultFramework: 'claude-code' as IntelligenceFramework,
    resolveConfig: () => cfg,
    buildProvider: () => null, // no other framework built → the default provider serves
  });
  return { router };
}

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-replay-int-'));
  ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
  jpl = new JudgmentProvenanceLog({
    dir: path.join(tmpDir, 'state', 'judgment-provenance'),
    log: () => {},
  });
  _resetDecisionQualityForTest();
  // Live recorder wired to the SAME JPL + ledger the route reads.
  installDecisionQualityRecorder(
    new DecisionQualityRecorderImpl({
      ledger,
      judgmentProvenance: jpl,
      config: { developmentAgent: true, provenance: { uniformSeam: { enabled: true, dryRun: false } } },
    }),
  );
});

afterEach(async () => {
  installDecisionQualityRecorder(null);
  _resetDecisionQualityForTest();
  ledger?.close();
  ledger = null;
  if (jpl) { await jpl.close(); jpl = null; }
  if (tmpDir) {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/stop-gate-replay-input-provenance.test.ts' });
    tmpDir = null;
  }
});

describe('GET /judgment-provenance never serves the captured stop reason (CMT-2204)', () => {
  const REPLY = JSON.stringify({ decision: 'allow', rule: 'U_LEGIT_COMPLETION', evidence_pointer: {}, rationale: 'plan finished' });

  it('serves the replay identity but not the text; the local row passes the sha check', async () => {
    const { router } = makeRouter(REPLY);
    const gate = new UnjustifiedStopGate({ intelligence: router, recordReplayInput: true, selfDeferralGuardEnabled: true, clientTimeoutMs: 5_000 });
    const out = await gate.evaluate({
      evidenceMetadata: { artifacts: [], signals: {}, sessionStartTs: 1 },
      untrustedContent: { stopReason: 'ZK5_STOP_BODY_MARKER every step is merged', recentTurns: [
        { source: 'user', text: 'ZK5_USER_MARKER finish it' }, { source: 'agent', text: 'all merged' },
      ] },
    });
    expect(out.ok).toBe(true);
    await jpl!.flush();

    const res = await request(appWith(ctxWith())).get('/judgment-provenance?limit=50').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    const row = (res.body.rows as Array<Record<string, unknown>>).find((r) => r.decisionPoint === DP_UNJUSTIFIED_STOP_GATE);
    expect(row, 'an unjustified-stop-gate row must be served').toBeTruthy();
    const served = JSON.stringify(res.body);
    expect(served).not.toContain('ZK5_STOP_BODY_MARKER');
    expect(served).not.toContain('ZK5_USER_MARKER');
    expect(served).not.toContain('_contentFull');
    expect(String(row!.contextRedacted)).toContain('stop-replay-input-v1');

    const dir = path.join(tmpDir!, 'state', 'judgment-provenance');
    const lines = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n')).map((l) => JSON.parse(l));
    const local = lines.find((r) => r.decisionPoint === DP_UNJUSTIFIED_STOP_GATE && r.kind === 'decision');
    expect(local).toBeTruthy();
    expect(assessStopGateReplayEligibility(local.contextFull, { rowTruncated: local.truncated })).toMatchObject({ eligible: true, exact: true });
    // The verdict the model gave rides on the same row, so a replay has its label.
    expect(String(local.contextFull.rawResponseHead)).toContain('"decision":"allow"');
  });
});
