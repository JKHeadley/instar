import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import { DP_MESSAGING_TONE_GATE } from '../../src/data/provenanceCoverage.js';
import { runGradePassWithIdleProof } from '../../src/core/JobGradePassIdleVerifier.js';

describe('grade-pass idle effect verifier', () => {
  const ledgers: FeatureMetricsLedger[] = [];
  const fixture = () => {
    const ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    ledgers.push(ledger);
    const deps = { ledger, hogStore: null, annotate: vi.fn(() => ({ applied: false } as any)),
      maxDecisionsPerPass: 200, evidenceWindowMs: 6 * 3_600_000, now: () => Date.now() };
    return { ledger, deps };
  };
  afterEach(() => { for (const ledger of ledgers.splice(0)) ledger.close(); });

  it('proves an empty workset from strict pre/post ledger reads, never from the receipt', () => {
    const { deps } = fixture();
    const checked = runGradePassWithIdleProof({ deps, runId: 'scheduled-run-1', allowProof: true });
    expect(checked.result.graded).toBe(0);
    expect(checked.idleProofHash).toMatch(/^[a-f0-9]{64}$/);
    expect(runGradePassWithIdleProof({ deps, runId: null, allowProof: true }).idleProofHash).toBeNull();
    expect(runGradePassWithIdleProof({ deps, runId: 'dry-run', allowProof: false }).idleProofHash).toBeNull();
  });

  it('leaves a nonempty or unreadable workset unknown even when the pass reports zero', () => {
    const { ledger, deps } = fixture();
    ledger.recordDecision({ correlationId: 'd-pending', decisionPoint: DP_MESSAGING_TONE_GATE,
      feature: 'MessagingToneGate', ts: Date.now(), model: 'gpt-6-luna', framework: 'codex-cli',
      promptId: 'tone-v1' });
    const nonempty = runGradePassWithIdleProof({ deps, runId: 'scheduled-run-2', allowProof: true });
    expect(nonempty.result.graded).toBe(0);
    expect(nonempty.idleProofHash).toBeNull();
    const strict = vi.spyOn(ledger, 'strictGradingIdleSnapshot').mockImplementationOnce(() => { throw new Error('read failed'); });
    expect(runGradePassWithIdleProof({ deps, runId: 'scheduled-run-3', allowProof: true }).idleProofHash).toBeNull();
    strict.mockRestore();
  });

  it('does not certify a late decision hidden behind an advanced cursor', () => {
    const { ledger, deps } = fixture();
    const now = Date.now();
    ledger.setGradingCursor(DP_MESSAGING_TONE_GATE,
      { cursorTs: now + 1000, cursorCorrelationId: 'future' });
    ledger.recordDecision({ correlationId: 'late-behind-cursor', decisionPoint: DP_MESSAGING_TONE_GATE,
      feature: 'MessagingToneGate', ts: now, model: 'gpt-6-luna', framework: 'codex-cli',
      promptId: 'tone-v1' });
    const checked = runGradePassWithIdleProof({ deps, runId: 'late-run', allowProof: true });
    expect(checked.result.graded).toBe(0);
    expect(checked.idleProofHash).toBeNull();
  });
});
