/**
 * Integration (CMT-1679): a REAL ClaimClauseArbiter call with replay-input capture on,
 * through a REAL IntelligenceRouter into a live DecisionQualityRecorderImpl + real
 * JudgmentProvenanceLog, is served by GET /judgment-provenance WITHOUT the captured
 * message, while the machine-local row keeps a capture that passes sha parity.
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
import { ClaimClauseArbiter, assessClaimReplayEligibility } from '../../src/monitoring/ClaimClauseArbiter.js';
import { prepareClaimObservation } from '../../src/monitoring/ClaimObservation.js';
import {
  DecisionQualityRecorderImpl,
  installDecisionQualityRecorder,
} from '../../src/core/DecisionQualityRecorderImpl.js';
import { _resetDecisionQualityForTest } from '../../src/core/decisionQualityTypes.js';
import { DP_COMPLETION_CLAIM_VERIFY } from '../../src/data/provenanceCoverage.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'test-claim-replay-provenance';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-replay-int-'));
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
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/claim-replay-input-provenance.test.ts' });
    tmpDir = null;
  }
});

describe('GET /judgment-provenance never serves the captured claim message (CMT-1679)', () => {
  const MESSAGE = 'ZK4_CLAIM_BODY_MARKER merged the fix and pushed the branch.';
  const REPLY = JSON.stringify({ legacy: { clauses: [
    { clauseId: 0, label: 'completed-or-in-progress-assertion', actionKind: 'merged', completionScope: 'this-turn', corroborated: false, rationale: 'r' },
  ] } });

  it('serves the replay identity but not the message; the local row passes parity', async () => {
    const { router } = makeRouter(REPLY);
    const p = prepareClaimObservation(MESSAGE, { hadToolCalls: true, truncated: false, unavailable: false, canaryOk: true,
      toolCalls: [{ tool: 'Bash', actionKind: 'merged', ok: true, targetSummary: 'gh pr merge 7' }] });
    if (p.policy !== 'standard-scrubbed') throw new Error('fixture must pass the scrub');
    const arbitration = await new ClaimClauseArbiter({ intelligence: router, recordReplayInput: true }).arbitrate(p.message, p.evidence);
    expect(arbitration.authoritative).toBe(true);
    await jpl!.flush();

    const res = await request(appWith(ctxWith())).get('/judgment-provenance?limit=50').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    const row = (res.body.rows as Array<Record<string, unknown>>).find((r) => r.decisionPoint === DP_COMPLETION_CLAIM_VERIFY);
    expect(row, 'a completion-claim-verify row must be served').toBeTruthy();
    const served = JSON.stringify(res.body);
    expect(served).not.toContain('ZK4_CLAIM_BODY_MARKER');
    expect(served).not.toContain('pushed the branch');
    expect(served).not.toContain('_contentFull');
    expect(String(row!.contextRedacted)).toContain('claim-replay-input-v1');

    const dir = path.join(tmpDir!, 'state', 'judgment-provenance');
    const lines = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n')).map((l) => JSON.parse(l));
    const local = lines.find((r) => r.decisionPoint === DP_COMPLETION_CLAIM_VERIFY && r.kind === 'decision');
    expect(local).toBeTruthy();
    expect(assessClaimReplayEligibility(local.contextFull, { rowTruncated: local.truncated }).eligible).toBe(true);
  });
});
