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

  // #47 regression — in production SessionMonitor keys health by the tmux
  // session name (slug, e.g. "echo-codey-collaboration"), while listRunningSessions
  // returns the human-facing display name ("Codey Collaboration"). The gate must
  // join them via session.tmuxSession. Before the fix it looked up by session.name,
  // always missed, and fell into the conservative "treat as active" default — so
  // EVERY interactive session blocked regardless of idle status, and the
  // restart-when-idle bypass (#41) never fired. These fixtures use the REAL
  // production key shape (health keyed by slug ≠ display name).
  describe('health key shape — tmuxSession (slug) vs display name (#47)', () => {
    const idleSlugKeyedMonitor = {
      getStatus: () => ({
        sessionHealth: [
          { sessionName: 'echo-codey-collaboration', topicId: 13435, status: 'idle' as const, idleMinutes: 120 },
        ],
      }),
    };
    const displayNameManager = {
      listRunningSessions: () => [{ name: 'Codey Collaboration', tmuxSession: 'echo-codey-collaboration' }],
      hasActiveProcesses: () => false,
    };

    it('does NOT block an IDLE session when health is keyed by tmuxSession slug (was the dead-code bug)', () => {
      const gate = new UpdateGate();
      // Pre-fix: lookup by display name missed → conservative-active → ['Codey Collaboration'].
      expect(gate.getBlockingSessions(displayNameManager, idleSlugKeyedMonitor)).toEqual([]);
    });

    it('canRestart ALLOWS the restart when the only session is idle (slug-keyed health)', () => {
      const gate = new UpdateGate();
      const result = gate.canRestart(displayNameManager, idleSlugKeyedMonitor);
      expect(result.allowed).toBe(true);
      expect(gate.getStatus().blockingSessions).toEqual([]);
    });

    it('still BLOCKS a HEALTHY session keyed by tmuxSession slug (active work stays protected)', () => {
      const gate = new UpdateGate();
      const healthyMonitor = {
        getStatus: () => ({
          sessionHealth: [
            { sessionName: 'echo-codey-collaboration', topicId: 13435, status: 'healthy' as const, idleMinutes: 0 },
          ],
        }),
      };
      expect(gate.getBlockingSessions(displayNameManager, healthyMonitor)).toEqual(['Codey Collaboration']);
    });

    it('does NOT block a DEAD session keyed by tmuxSession slug', () => {
      const gate = new UpdateGate();
      const deadMonitor = {
        getStatus: () => ({
          sessionHealth: [
            { sessionName: 'echo-codey-collaboration', topicId: 13435, status: 'dead' as const, idleMinutes: 999 },
          ],
        }),
      };
      expect(gate.getBlockingSessions(displayNameManager, deadMonitor)).toEqual([]);
    });

    it('falls back to display-name health key when tmuxSession has no slug-keyed entry (back-compat)', () => {
      // Older/test fixtures key health by session.name; the fallback must still find it.
      const gate = new UpdateGate();
      const nameKeyedMonitor = {
        getStatus: () => ({
          sessionHealth: [{ sessionName: 'topic-458', topicId: 458, status: 'idle' as const, idleMinutes: 30 }],
        }),
      };
      const mgr = {
        listRunningSessions: () => [{ name: 'topic-458', tmuxSession: 'instar-topic-458' }],
        hasActiveProcesses: () => false,
      };
      expect(gate.getBlockingSessions(mgr, nameKeyedMonitor)).toEqual([]); // idle via name-key fallback
    });
  });

  // Primary-developer mode (updates.restartImmediately) — the agent never defers
  // a restart for active sessions. A server restart does not kill the agent's
  // tmux sessions (CONTINUATION), so being-on-latest wins over the restart blip.
  // Spec: docs/specs/restart-immediately-spec.md.
  describe('alwaysRestartImmediately (primary-developer mode)', () => {
    // The exact fixture that BLOCKS by default — a healthy interactive session.
    const healthyManager = {
      listRunningSessions: () => [{ name: 'Codey Collaboration', tmuxSession: 'echo-codey-collaboration' }],
      hasActiveProcesses: () => true,
    };
    const healthyMonitor = {
      getStatus: () => ({
        sessionHealth: [
          { sessionName: 'echo-codey-collaboration', topicId: 13435, status: 'healthy' as const, idleMinutes: 0 },
        ],
      }),
    };

    it('ALLOWS the restart even with a healthy active session that would otherwise block', () => {
      const blocked = new UpdateGate().canRestart(healthyManager, healthyMonitor);
      expect(blocked.allowed).toBe(false); // baseline: default gate blocks

      const gate = new UpdateGate({ alwaysRestartImmediately: true });
      const result = gate.canRestart(healthyManager, healthyMonitor);
      expect(result.allowed).toBe(true);
      expect(result.blockingSessions).toBeUndefined();
    });

    it('does NOT start the deferral clock or set blocking state (pure allow)', () => {
      const gate = new UpdateGate({ alwaysRestartImmediately: true });
      gate.canRestart(healthyManager, healthyMonitor);
      const status = gate.getStatus();
      expect(status.deferring).toBe(false);
      expect(status.deferralStartedAt).toBeNull();
      expect(status.blockingSessions).toEqual([]);
      expect(status.alwaysRestartImmediately).toBe(true);
    });

    it('short-circuits without even consulting the session monitor', () => {
      let monitorConsulted = false;
      const gate = new UpdateGate({ alwaysRestartImmediately: true });
      const result = gate.canRestart(healthyManager, {
        getStatus: () => { monitorConsulted = true; return { sessionHealth: [] }; },
      });
      expect(result.allowed).toBe(true);
      expect(monitorConsulted).toBe(false);
    });

    it('default (false) still blocks a healthy active session — fleet behavior unchanged', () => {
      const gate = new UpdateGate(); // default
      expect(gate.getStatus().alwaysRestartImmediately).toBe(false);
      expect(gate.canRestart(healthyManager, healthyMonitor).allowed).toBe(false);
    });

    it('setAlwaysRestartImmediately(true) flips a deferring gate to allowed and clears the deferral', () => {
      const gate = new UpdateGate();
      // First, start a deferral against a healthy session.
      expect(gate.canRestart(healthyManager, healthyMonitor).allowed).toBe(false);
      expect(gate.getStatus().deferring).toBe(true);

      // Operator turns on primary-developer mode at runtime (config edit, no restart).
      gate.setAlwaysRestartImmediately(true);
      const status = gate.getStatus();
      expect(status.alwaysRestartImmediately).toBe(true);
      expect(status.deferring).toBe(false); // deferral cleared
      expect(gate.canRestart(healthyManager, healthyMonitor).allowed).toBe(true);
    });

    it('setAlwaysRestartImmediately(false) restores session-aware deferral', () => {
      const gate = new UpdateGate({ alwaysRestartImmediately: true });
      expect(gate.canRestart(healthyManager, healthyMonitor).allowed).toBe(true);
      gate.setAlwaysRestartImmediately(false);
      expect(gate.getStatus().alwaysRestartImmediately).toBe(false);
      expect(gate.canRestart(healthyManager, healthyMonitor).allowed).toBe(false);
    });
  });
});
