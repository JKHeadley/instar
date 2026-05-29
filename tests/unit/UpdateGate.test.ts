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
});
