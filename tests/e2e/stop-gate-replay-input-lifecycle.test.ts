/**
 * Tier 3 (CMT-2204): the stop check's replay-input switch resolves through the
 * SAME helper the server's construction site calls (resolveStopGateReplayInput),
 * ON for a development agent and OFF for a fleet agent. A real gate built that
 * way, behind a real IntelligenceRouter + installed DecisionQualityRecorderImpl +
 * real JudgmentProvenanceLog, writes a row whose capture passes the replay sha
 * check on dev and carries no capture on the fleet. The verdict is identical.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JudgmentProvenanceLog, CONTENT_FULL_KEY } from '../../src/core/JudgmentProvenanceLog.js';
import { IntelligenceRouter } from '../../src/core/IntelligenceRouter.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import { DecisionQualityRecorderImpl, installDecisionQualityRecorder } from '../../src/core/DecisionQualityRecorderImpl.js';
import { _resetDecisionQualityForTest } from '../../src/core/decisionQualityTypes.js';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import { DP_UNJUSTIFIED_STOP_GATE } from '../../src/data/provenanceCoverage.js';
import { UnjustifiedStopGate, assessStopGateReplayEligibility, resolveStopGateReplayInput } from '../../src/core/UnjustifiedStopGate.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const REPLY = JSON.stringify({ decision: 'allow', rule: 'U_LEGIT_COMPLETION', evidence_pointer: {}, rationale: 'done' });
const dirs: string[] = [];

async function bootAndStop(developmentAgent: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-replay-e2e-'));
  dirs.push(dir);
  const config = { developmentAgent, provenance: { uniformSeam: { enabled: true, dryRun: false } }, monitoring: {} };
  const jplDir = path.join(dir, 'state', 'judgment-provenance');
  const jpl = new JudgmentProvenanceLog({ dir: jplDir, log: () => {} });
  const ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
  _resetDecisionQualityForTest();
  installDecisionQualityRecorder(new DecisionQualityRecorderImpl({ ledger, judgmentProvenance: jpl, config }));
  const defaultProvider: IntelligenceProvider = { evaluate: async () => REPLY };
  const router = new IntelligenceRouter({ defaultProvider, defaultFramework: 'claude-code' as IntelligenceFramework,
    resolveConfig: () => undefined, buildProvider: () => null });
  try {
    const gate = new UnjustifiedStopGate({ intelligence: router, selfDeferralGuardEnabled: developmentAgent,
      recordReplayInput: resolveStopGateReplayInput(config), clientTimeoutMs: 5_000 });
    const outcome = await gate.evaluate({
      evidenceMetadata: { artifacts: [], signals: {}, sessionStartTs: 1 },
      untrustedContent: { stopReason: 'ZE3_STOP_MARKER all merged', recentTurns: [{ source: 'agent', text: 'merged' }] },
    });
    await jpl.flush();
    const rows = fs.readdirSync(jplDir).filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => fs.readFileSync(path.join(jplDir, f), 'utf8').trim().split('\n').filter(Boolean))
      .map((l) => JSON.parse(l)).filter((r) => r.decisionPoint === DP_UNJUSTIFIED_STOP_GATE && r.kind === 'decision');
    return { outcome, rows };
  } finally {
    installDecisionQualityRecorder(null);
    _resetDecisionQualityForTest();
    ledger.close();
    await jpl.close();
  }
}

describe('stop-check replay input on the production resolution path', () => {
  afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'stop-replay-e2e' }); });

  it('the server construction site uses the shared resolver', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'commands', 'server.ts'), 'utf8');
    expect(src).toMatch(/recordReplayInput:\s*resolveStopGateReplayInput\(config\)/);
  });

  it('an explicit boolean wins over the dev/fleet default', () => {
    expect(resolveStopGateReplayInput({ developmentAgent: true, monitoring: { stopGateReplayInput: { enabled: false } } })).toBe(false);
    expect(resolveStopGateReplayInput({ developmentAgent: false, monitoring: { stopGateReplayInput: { enabled: true } } })).toBe(true);
  });

  it('dev agent: resolves on, the row passes the replay sha check and never serves the text', async () => {
    const { outcome, rows } = await bootAndStop(true);
    expect(outcome.ok && outcome.result.decision).toBe('allow');
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0];
    expect(row.contextFull.captureVersion).toBe('stop-replay-input-v1');
    expect(row.contextFull[CONTENT_FULL_KEY].untrustedContent.stopReason).toContain('ZE3_STOP_MARKER');
    expect(assessStopGateReplayEligibility(row.contextFull, { rowTruncated: row.truncated })).toMatchObject({ eligible: true, exact: true });
    expect(String(row.contextRedacted)).not.toContain('ZE3_STOP_MARKER');
  });

  it('fleet agent: resolves off and the row has no capture, same verdict', async () => {
    const { outcome, rows } = await bootAndStop(false);
    expect(outcome.ok && outcome.result.decision).toBe('allow');
    const row = rows[0];
    expect(row.contextFull[CONTENT_FULL_KEY]).toBeUndefined();
    expect(row.contextFull.captureVersion).toBeUndefined();
    expect(assessStopGateReplayEligibility(row.contextFull)).toEqual({ eligible: false, reason: 'no-capture' });
  });
});
