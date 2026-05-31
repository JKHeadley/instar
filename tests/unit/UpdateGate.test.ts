import { describe, expect, it } from 'vitest';
import { UpdateGate } from '../../src/core/UpdateGate.js';

describe('UpdateGate', () => {
  it('does not block restart on idle background job sessions when process tree is idle', () => {
    const gate = new UpdateGate();
    const result = gate.canRestart({
      listRunningSessions: () => [
        { name: 'job-commitment-detection', tmuxSession: 'instar-job-commitment-detection', jobSlug: 'commitment-detection' },
      ],
      hasActiveProcesses: () => false,
    });

    expect(result.allowed).toBe(true);
    expect(result.nonBlockingJobSessions).toEqual(['job-commitment-detection']);
    expect(gate.getStatus().blockingSessions).toEqual([]);
  });

  it('still blocks restart while a background job is actively executing', () => {
    const gate = new UpdateGate();
    const result = gate.canRestart({
      listRunningSessions: () => [
        { name: 'job-commitment-detection', tmuxSession: 'instar-job-commitment-detection', jobSlug: 'commitment-detection' },
      ],
      hasActiveProcesses: () => true,
    }, {
      getStatus: () => ({
        sessionHealth: [
          { sessionName: 'job-commitment-detection', topicId: 0, status: 'healthy', idleMinutes: 0 },
        ],
      }),
    });

    expect(result.allowed).toBe(false);
    expect(result.blockingSessions).toEqual(['job-commitment-detection']);
    expect(gate.getStatus().blockingSessions).toEqual(['job-commitment-detection']);
  });

  it('keeps interactive sessions conservative even when they have no active child process', () => {
    const gate = new UpdateGate();
    const result = gate.canRestart({
      listRunningSessions: () => [
        { name: 'topic-458', tmuxSession: 'instar-topic-458' },
      ],
      hasActiveProcesses: () => false,
    }, {
      getStatus: () => ({
        sessionHealth: [
          { sessionName: 'topic-458', topicId: 458, status: 'healthy', idleMinutes: 0 },
        ],
      }),
    });

    expect(result.allowed).toBe(false);
    expect(result.blockingSessions).toEqual(['topic-458']);
  });

  // getBlockingSessions — the pure, side-effect-free idle probe used by the
  // AutoUpdater restart-window gate (#41 restart-when-idle).
  describe('getBlockingSessions (pure idle probe)', () => {
    const activeManager = {
      listRunningSessions: () => [{ name: 'topic-458', tmuxSession: 'instar-topic-458' }],
      hasActiveProcesses: () => false,
    };
    const activeMonitor = {
      getStatus: () => ({
        sessionHealth: [{ sessionName: 'topic-458', topicId: 458, status: 'healthy' as const, idleMinutes: 0 }],
      }),
    };

    it('returns [] when there are no running sessions (idle box)', () => {
      const gate = new UpdateGate();
      expect(gate.getBlockingSessions({ listRunningSessions: () => [] })).toEqual([]);
    });

    it('returns [] when the only sessions are idle background jobs (non-blocking)', () => {
      const gate = new UpdateGate();
      const blockers = gate.getBlockingSessions({
        listRunningSessions: () => [
          { name: 'job-commitment-detection', tmuxSession: 'instar-job-commitment-detection', jobSlug: 'commitment-detection' },
        ],
        hasActiveProcesses: () => false,
      });
      expect(blockers).toEqual([]);
    });

    it('returns the names of active (healthy, interactive) sessions', () => {
      const gate = new UpdateGate();
      expect(gate.getBlockingSessions(activeManager, activeMonitor)).toEqual(['topic-458']);
    });

    it('classification matches canRestart exactly (no drift between probe and gate)', () => {
      // Same inputs → getBlockingSessions().length>0 iff canRestart() blocks.
      const gateA = new UpdateGate();
      const probe = gateA.getBlockingSessions(activeManager, activeMonitor);
      const gateB = new UpdateGate();
      const decision = gateB.canRestart(activeManager, activeMonitor);
      expect(probe.length > 0).toBe(!decision.allowed);
      expect(probe).toEqual(decision.blockingSessions);
    });

    it('is PURE — does NOT start the deferral clock or set blocking state', () => {
      // This is the whole reason getBlockingSessions exists separately from
      // canRestart: the restart-window gate must probe idle-ness WITHOUT
      // perturbing deferral bookkeeping. canRestart on active sessions starts
      // the deferral clock; getBlockingSessions must not.
      const gate = new UpdateGate();
      gate.getBlockingSessions(activeManager, activeMonitor); // active → would block
      const status = gate.getStatus();
      expect(status.deferring).toBe(false);
      expect(status.deferralStartedAt).toBeNull();
      expect(status.blockingSessions).toEqual([]);
      expect(status.firstWarningSent).toBe(false);
      expect(status.finalWarningSent).toBe(false);
    });
  });
});
