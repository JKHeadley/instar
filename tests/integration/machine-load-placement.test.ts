/**
 * Integration test (§L6 + §L4): the MachineLoadBroker feeds the shared machine load
 * into a MachineCapacity that the PlacementExecutor consumes — proving the L6 → L4
 * contract. A machine where a resident agent LIES about its load (reports idle while
 * actually saturating the box) is, via the OS-truth cross-check, both flagged
 * suspect AND — because the machine's authoritative OS loadAvg is high — NOT chosen
 * by another agent's router. A lying agent cannot attract sessions.
 */
import { describe, it, expect } from 'vitest';
import { computeMachineLoad } from '../../src/core/MachineLoadBroker.js';
import { PlacementExecutor } from '../../src/core/PlacementExecutor.js';
import type { MachineCapacity } from '../../src/core/types.js';

describe('MachineLoadBroker → PlacementExecutor (§L6/§L4)', () => {
  it('a machine whose agent lies idle (high OS load) is flagged suspect AND not selected for placement', () => {
    // Machine "busybox": agent reports 0 sessions / 50MB, but OS sees 4GB + loadAvg 14.
    const busy = computeMachineLoad({
      loadAvg: 14, cpuCount: 8,
      osSamples: [{ agentId: 'liar', measuredFootprintMB: 4000 }],
      agentReports: [{ agentId: 'liar', port: 4040, reportedSessionCount: 0, reportedFootprintMB: 50 }],
    });
    // Machine "freebox": genuinely idle.
    const free = computeMachineLoad({
      loadAvg: 0.3, cpuCount: 8,
      osSamples: [{ agentId: 'honest', measuredFootprintMB: 300 }],
      agentReports: [{ agentId: 'honest', port: 4040, reportedSessionCount: 0, reportedFootprintMB: 300 }],
    });

    // The lie is caught by the broker (independent of placement).
    expect(busy.suspectAgents).toEqual(['liar']);
    expect(busy.sessionCountTrustworthy).toBe(false);

    // Build MachineCapacity rows from the broker's AUTHORITATIVE loadAvg (OS truth),
    // exactly as the registry would when reporting capacity to a router.
    const capacities: MachineCapacity[] = [
      { machineId: 'busybox', online: true, clockSkewStatus: 'ok', loadAvg: busy.loadAvg, activeSessionCount: busy.activeSessionCount, maxSessions: 10, memPressure: 'high', capabilities: ['sessions'] },
      { machineId: 'freebox', online: true, clockSkewStatus: 'ok', loadAvg: free.loadAvg, activeSessionCount: free.activeSessionCount, maxSessions: 10, memPressure: 'low', capabilities: ['sessions'] },
    ];

    const decision = new PlacementExecutor().decide({ sessionKey: 'new', topicMetadata: {}, machineRegistry: capacities, reason: 'new' });
    // The router places on the genuinely-free machine — the lying-but-busy box's
    // high OS loadAvg overrode its faked idle self-report.
    expect(decision.outcome).toBe('placed');
    expect(decision.chosenMachine).toBe('freebox');
  });
});
