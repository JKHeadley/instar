import { describe, expect, it } from 'vitest';
import { createLedger, evaluateClosure, evaluateObligations, type Obligation } from '../../src/core/WindowLifecycleObligationLedger.js';

const NOW = '2026-08-28T09:00:00.000Z';
const DEADLINE = '2026-08-28T10:00:00.000Z';

function reportDuty(): Obligation {
  return {
    id: 'cadence.report.3h@2026-08-28T09:00:00Z', agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28',
    sourceSpans: [{ source: 'charter', hash: 'charter-hash', byteStart: 0, byteEnd: 10, lineStart: 1, lineEnd: 1 }], statement: 'Send the operator a high-level synthesis report', phase: 'cadence', coreDuty: true, waiverPolicy: 'non-waivable', responsibleRole: 'observer-2',
    deadline: { dueAt: DEADLINE, graceMs: 0 }, predicate: { recurring: true }, evidencePolicy: { requiredAuthority: 'live-requeried-message' }, failureAction: 'block-new-scope-and-escalate', status: 'pending', evidence: [], lastEvaluatedAt: null,
    executorBinding: { class: 'pending-executable', kind: 'promise-beacon', executorId: 'commitment-1', owner: 'observer-2', registryCoordinates: 'commitments/1', enabled: true, dryRun: false, running: true, heartbeatAt: NOW, heartbeatMaxAgeMs: 60_000, nextAttemptAt: DEADLINE, deliversOutput: true, sinkReachable: true, suppressionActive: true, needsClientDriver: true, driverPresent: false, driverMatches: false },
  };
}

describe('2026-08-28 executor-liveness incident lifecycle', () => {
  it('blocks the committed-but-unexecuted overnight report and passes only a real execution path', () => {
    const apparent = reportDuty();
    const failed = evaluateObligations([apparent], NOW);
    expect(failed.admitted).toBe(false); expect(failed.obligations[0].status).toBe('open-unexecuted');
    expect(failed.issues).toEqual(expect.arrayContaining([expect.stringContaining('delivery-path-unavailable'), expect.stringContaining('client-driver-unavailable')]));
    const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', compiled: { hashes: {}, byteLengths: {}, operativeLines: [], obligations: failed.obligations } }); ledger.state = 'active_start';
    expect(evaluateClosure(ledger, [apparent.id]).state).toBe('close_blocked');

    for (const mutation of [
      { suppressionActive: false },
      { driverPresent: true, driverMatches: true },
      { dryRun: false },
    ]) {
      const oneSignal = reportDuty(); oneSignal.executorBinding = { ...oneSignal.executorBinding, dryRun: true, ...mutation };
      expect(evaluateObligations([oneSignal], NOW).admitted).toBe(false);
    }

    const real = reportDuty(); real.executorBinding = { ...real.executorBinding, suppressionActive: false, driverPresent: true, driverMatches: true };
    const evaluated = evaluateObligations([real], NOW);
    expect(evaluated.issues).toEqual([]);
    expect(evaluated.obligations[0].status).toBe('pending');
  });
});
