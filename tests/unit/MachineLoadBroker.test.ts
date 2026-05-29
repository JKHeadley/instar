/**
 * Tier-1 tests for MachineLoadBroker (Multi-Machine Session Pool §L6). Covers the
 * shared load accounting across resident agents, the OS-truth cross-check that
 * catches an agent under-reporting its footprint (cannot lie itself idle), and the
 * isolation invariant (distinct ports/identities, no nested home dirs).
 */
import { describe, it, expect } from 'vitest';
import { computeMachineLoad, checkAgentIsolation, type MachineLoadInput, type ResidentAgent } from '../../src/core/MachineLoadBroker.js';

function input(over: Partial<MachineLoadInput> = {}): MachineLoadInput {
  return {
    loadAvg: 1.0,
    cpuCount: 8,
    osSamples: [{ agentId: 'a', measuredFootprintMB: 500 }, { agentId: 'b', measuredFootprintMB: 500 }],
    agentReports: [
      { agentId: 'a', port: 4040, reportedSessionCount: 2, reportedFootprintMB: 500 },
      { agentId: 'b', port: 4042, reportedSessionCount: 3, reportedFootprintMB: 500 },
    ],
    ...over,
  };
}

describe('computeMachineLoad (§L6)', () => {
  it('sums sessions across ALL resident agents (true machine load, not just one agent)', () => {
    const r = computeMachineLoad(input());
    expect(r.activeSessionCount).toBe(5);
    expect(r.loadAvg).toBe(1.0);
    expect(r.sessionCountTrustworthy).toBe(true);
    expect(r.suspectAgents).toEqual([]);
  });

  it('catches an agent that under-reports footprint (claims idle, actually saturating) → suspect-overloaded', () => {
    const r = computeMachineLoad(input({
      // Agent 'b' claims 50MB / 0 sessions but its processes actually use 4000MB.
      osSamples: [{ agentId: 'a', measuredFootprintMB: 500 }, { agentId: 'b', measuredFootprintMB: 4000 }],
      agentReports: [
        { agentId: 'a', port: 4040, reportedSessionCount: 2, reportedFootprintMB: 500 },
        { agentId: 'b', port: 4042, reportedSessionCount: 0, reportedFootprintMB: 50 },
      ],
    }));
    expect(r.suspectAgents).toEqual(['b']);
    expect(r.sessionCountTrustworthy).toBe(false); // the router must lean on OS loadAvg
    const vb = r.agentVerdicts.find((v) => v.agentId === 'b')!;
    expect(vb.status).toBe('suspect-overloaded');
    expect(vb.placementWeight).toBeLessThan(1);
  });

  it('does NOT flag an agent that over-reports (looks busier than it is — conservative)', () => {
    const r = computeMachineLoad(input({
      osSamples: [{ agentId: 'a', measuredFootprintMB: 100 }],
      agentReports: [{ agentId: 'a', port: 4040, reportedSessionCount: 1, reportedFootprintMB: 800 }],
    }));
    expect(r.suspectAgents).toEqual([]);
  });

  it('respects a custom divergence tolerance', () => {
    const args = {
      loadAvg: 1, cpuCount: 8,
      osSamples: [{ agentId: 'a', measuredFootprintMB: 600 }],
      agentReports: [{ agentId: 'a', port: 4040, reportedSessionCount: 1, reportedFootprintMB: 500 }],
    };
    // 600 vs 500 = 20% divergence: ok at tol 0.25, suspect at tol 0.10.
    expect(computeMachineLoad({ ...args, loadReportDivergenceTolerance: 0.25 }).suspectAgents).toEqual([]);
    expect(computeMachineLoad({ ...args, loadReportDivergenceTolerance: 0.10 }).suspectAgents).toEqual(['a']);
  });
});

describe('checkAgentIsolation (§L6)', () => {
  function agent(over: Partial<ResidentAgent>): ResidentAgent {
    return { agentId: 'x', homeDir: '/Users/u/.instar/agents/x', port: 4040, identityFingerprint: 'fp_x', ...over };
  }
  it('passes for properly-isolated agents (distinct ports, identities, sibling homes)', () => {
    const v = checkAgentIsolation([
      agent({ agentId: 'echo', homeDir: '/Users/u/.instar/agents/echo', port: 4042, identityFingerprint: 'fp_echo' }),
      agent({ agentId: 'dawn', homeDir: '/Users/u/.instar/agents/dawn', port: 4040, identityFingerprint: 'fp_dawn' }),
    ]);
    expect(v).toEqual([]);
  });

  it('detects a duplicate port', () => {
    const v = checkAgentIsolation([agent({ agentId: 'a', port: 4040 }), agent({ agentId: 'b', homeDir: '/h/b', port: 4040, identityFingerprint: 'fp_b' })]);
    expect(v.some((x) => x.kind === 'duplicate-port')).toBe(true);
  });

  it('detects a shared identity fingerprint', () => {
    const v = checkAgentIsolation([agent({ agentId: 'a', port: 1, identityFingerprint: 'same' }), agent({ agentId: 'b', homeDir: '/h/b', port: 2, identityFingerprint: 'same' })]);
    expect(v.some((x) => x.kind === 'duplicate-fingerprint')).toBe(true);
  });

  it('detects a nested home dir (one agent could read another\'s state)', () => {
    const v = checkAgentIsolation([
      agent({ agentId: 'outer', homeDir: '/Users/u/.instar/agents/outer', port: 1, identityFingerprint: 'fp1' }),
      agent({ agentId: 'inner', homeDir: '/Users/u/.instar/agents/outer/nested', port: 2, identityFingerprint: 'fp2' }),
    ]);
    expect(v.some((x) => x.kind === 'nested-home')).toBe(true);
  });
});
