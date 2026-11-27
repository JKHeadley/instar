/**
 * Tier 3 (CMT-1679): on the production AgentServer boot path, the completion-claim
 * verifier's replay-input capture resolves ON for a development agent and writes a
 * provenance row whose capture passes prompt-sha parity; on a fleet agent it resolves
 * OFF and the row carries no capture.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LlmQueue } from '../../src/monitoring/LlmQueue.js';
import { JudgmentProvenanceLog, CONTENT_FULL_KEY } from '../../src/core/JudgmentProvenanceLog.js';
import { IntelligenceRouter } from '../../src/core/IntelligenceRouter.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import { installDecisionQualityRecorder } from '../../src/core/DecisionQualityRecorderImpl.js';
import { _resetDecisionQualityForTest } from '../../src/core/decisionQualityTypes.js';
import { DP_COMPLETION_CLAIM_VERIFY } from '../../src/data/provenanceCoverage.js';
import { assessClaimReplayEligibility } from '../../src/monitoring/ClaimClauseArbiter.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig, IntelligenceProvider } from '../../src/core/types.js';

const AUTH = 'claim-replay-e2e-token';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });
const REPLY = JSON.stringify({ clauses: [{ clauseId: 0, label: 'completed-or-in-progress-assertion',
  completionScope: 'this-turn', actionKind: 'pushed', target: 'ws1', corroborated: false, rationale: 'no matching push' }] });
const dirs: string[] = [];

async function bootAndObserve(developmentAgent: boolean): Promise<Array<Record<string, any>>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-replay-e2e-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.instar', 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.instar', 'state', 'jobs'), { recursive: true });
  const config = {
    projectName: 'claim-replay-e2e', agentName: 'E2E', projectDir: dir, stateDir: path.join(dir, '.instar'),
    port: 0, authToken: AUTH, dashboardPin: '123456', developmentAgent,
    provenance: { uniformSeam: { enabled: true, dryRun: false } },
    monitoring: { completionClaimVerification: { enabled: true, dryRun: true } },
  } as InstarConfig;
  const jplDir = path.join(dir, '.instar', 'state', 'judgment-provenance');
  const jpl = new JudgmentProvenanceLog({ dir: jplDir, log: () => {} });
  _resetDecisionQualityForTest();
  const defaultProvider: IntelligenceProvider = { evaluate: vi.fn(async () => REPLY) };
  // A REAL router: it mints the correlation id and fires the settlement seam into the recorder.
  const intelligence = new IntelligenceRouter({ defaultProvider, defaultFramework: 'claude-code' as IntelligenceFramework,
    resolveConfig: () => undefined, buildProvider: () => null });
  const sessionManager = Object.assign(createMockSessionManager() as any, { on: vi.fn() });
  // The server installs its OWN decision-quality recorder over this log (the production
  // wiring), so the row below is written by the real boot path, not by the test.
  const server = new AgentServer({ config, intelligence, llmQueue: new LlmQueue({ maxDailyCents: 100 }), sessionManager,
    judgmentProvenance: jpl, state: new StateManager(path.join(dir, '.instar')) } as any);
  try {
    const observed = await request(server.getApp()).post('/completion-claim/observe').set(auth())
      .set('X-Instar-Request', '1').send({ message: 'ZE2_REPLAY_MARKER I pushed ws1', evidence: {
        hadToolCalls: true, toolCalls: [{ tool: 'Bash', actionKind: 'other', ok: true }],
        truncated: false, unavailable: false, canaryOk: true,
      } });
    expect(observed.status).toBe(202);
    let rows: Array<Record<string, any>> = [];
    await vi.waitFor(async () => {
      await jpl.flush();
      rows = fs.existsSync(jplDir) ? fs.readdirSync(jplDir).filter((f) => f.endsWith('.jsonl'))
        .flatMap((f) => fs.readFileSync(path.join(jplDir, f), 'utf8').trim().split('\n').filter(Boolean))
        .map((l) => JSON.parse(l)).filter((r) => r.decisionPoint === DP_COMPLETION_CLAIM_VERIFY && r.kind === 'decision') : [];
      expect(rows.length).toBeGreaterThan(0);
    }, { timeout: 15_000 });
    const served = await request(server.getApp()).get('/judgment-provenance?limit=50').set(auth());
    if (served.status === 200) expect(JSON.stringify(served.body)).not.toContain('ZE2_REPLAY_MARKER');
    return rows;
  } finally {
    installDecisionQualityRecorder(null);
    _resetDecisionQualityForTest();
    await jpl.close();
  }
}

describe('completion-claim replay input on the production boot path', () => {
  afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'claim-replay-e2e' }); });

  it('dev agent: the flag resolves on and the written row passes sha parity', async () => {
    const rows = await bootAndObserve(true);
    const row = rows[0];
    expect(row.contextFull.captureVersion).toBe('claim-replay-input-v1');
    expect(row.contextFull[CONTENT_FULL_KEY].message).toContain('ZE2_REPLAY_MARKER');
    expect(assessClaimReplayEligibility(row.contextFull, { rowTruncated: row.truncated })).toMatchObject({ eligible: true });
    expect(String(row.contextRedacted)).not.toContain('ZE2_REPLAY_MARKER');
  });

  it('fleet agent: the flag resolves off and the row has no capture', async () => {
    const rows = await bootAndObserve(false);
    const row = rows[0];
    expect(row.contextFull[CONTENT_FULL_KEY]).toBeUndefined();
    expect(row.contextFull.captureVersion).toBeUndefined();
    expect(row.contextFull.promptSha256).toBeUndefined();
    expect(assessClaimReplayEligibility(row.contextFull)).toEqual({ eligible: false, reason: 'no-capture' });
  });
});
