import { describe, it, expect } from 'vitest';
import {
  SingleMachineFailoverGapDetector,
  buildAttention,
  SINGLE_MACHINE_FAILOVER_GAP_DEDUP_KEY,
  type SingleMachineFailoverGapDetectorDeps,
  type MeshMembership,
  type FailoverGapAttention,
} from '../../src/monitoring/SingleMachineFailoverGapDetector.js';

function makeDetector(opts: {
  enabled?: boolean;
  dryRun?: boolean;
  membership: MeshMembership;
  activeRuns: number;
}) {
  const raised: FailoverGapAttention[] = [];
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const deps: SingleMachineFailoverGapDetectorDeps = {
    enabled: () => opts.enabled ?? true,
    dryRun: () => opts.dryRun ?? false,
    getMeshMembership: () => opts.membership,
    getActiveAutonomousRunCount: () => opts.activeRuns,
    raiseAttention: (item) => raised.push(item),
    audit: (event, detail) => audits.push({ event, detail }),
  };
  return { detector: new SingleMachineFailoverGapDetector(deps), raised, audits };
}

describe('SingleMachineFailoverGapDetector', () => {
  it('is a strict no-op when disabled — never reads mesh/runs, never raises', () => {
    let read = false;
    const detector = new SingleMachineFailoverGapDetector({
      enabled: () => false,
      dryRun: () => false,
      getMeshMembership: () => { read = true; return { multiMachineEnabled: false, onlinePeerCount: 0 }; },
      getActiveAutonomousRunCount: () => { read = true; return 5; },
      raiseAttention: () => { throw new Error('must not raise when disabled'); },
    });
    const res = detector.tick();
    expect(res).toEqual({ ran: false, gapDetected: false, mode: null, atRiskRunCount: 0, raised: false });
    expect(read).toBe(false);
  });

  it('raises a high-priority deduped item when single-machine (never configured) WITH active runs', () => {
    const { detector, raised, audits } = makeDetector({
      membership: { multiMachineEnabled: false, onlinePeerCount: 0 },
      activeRuns: 2,
    });
    const res = detector.tick();
    expect(res).toEqual({ ran: true, gapDetected: true, mode: 'not-configured', atRiskRunCount: 2, raised: true });
    expect(raised).toHaveLength(1);
    expect(raised[0].priority).toBe('high');
    expect(raised[0].dedupKey).toBe(SINGLE_MACHINE_FAILOVER_GAP_DEDUP_KEY);
    expect(raised[0].source).toBe('single-machine-failover-gap');
    expect(raised[0].body).toMatch(/no second machine registered/i);
    expect(audits.some((a) => a.event === 'raised')).toBe(true);
  });

  it('classifies the gap as peer-offline when multiMachine IS enabled but every peer is down', () => {
    const { detector, raised } = makeDetector({
      membership: { multiMachineEnabled: true, onlinePeerCount: 0 },
      activeRuns: 1,
    });
    const res = detector.tick();
    expect(res.mode).toBe('peer-offline');
    expect(res.gapDetected).toBe(true);
    expect(raised[0].body).toMatch(/every other machine.*offline/i);
  });

  it('does NOT flag a gap when a peer is online (failover target exists)', () => {
    const { detector, raised, audits } = makeDetector({
      membership: { multiMachineEnabled: true, onlinePeerCount: 1 },
      activeRuns: 3,
    });
    const res = detector.tick();
    expect(res).toEqual({ ran: true, gapDetected: false, mode: null, atRiskRunCount: 3, raised: false });
    expect(raised).toHaveLength(0);
    expect(audits.some((a) => a.event === 'no-gap')).toBe(true);
  });

  it('does NOT flag a gap when single-machine but there is NO autonomous work to protect', () => {
    const { detector, raised } = makeDetector({
      membership: { multiMachineEnabled: false, onlinePeerCount: 0 },
      activeRuns: 0,
    });
    const res = detector.tick();
    expect(res.gapDetected).toBe(false);
    expect(raised).toHaveLength(0);
  });

  it('dryRun computes the gap + audits a would-raise but does NOT raise', () => {
    const { detector, raised, audits } = makeDetector({
      dryRun: true,
      membership: { multiMachineEnabled: false, onlinePeerCount: 0 },
      activeRuns: 4,
    });
    const res = detector.tick();
    expect(res).toEqual({ ran: true, gapDetected: true, mode: 'not-configured', atRiskRunCount: 4, raised: false });
    expect(raised).toHaveLength(0);
    expect(audits.some((a) => a.event === 'would-raise')).toBe(true);
  });

  it('an audit sink that throws never breaks the tick (best-effort audit)', () => {
    const detector = new SingleMachineFailoverGapDetector({
      enabled: () => true,
      dryRun: () => false,
      getMeshMembership: () => ({ multiMachineEnabled: false, onlinePeerCount: 0 }),
      getActiveAutonomousRunCount: () => 1,
      raiseAttention: () => {},
      audit: () => { throw new Error('audit boom'); },
    });
    expect(() => detector.tick()).not.toThrow();
  });

  it('buildAttention pluralizes correctly (1 run vs many)', () => {
    expect(buildAttention('not-configured', 1).body).toMatch(/1 autonomous run /);
    expect(buildAttention('not-configured', 3).body).toMatch(/3 autonomous runs /);
  });
});
