/**
 * A machine that cannot start a session must stop being handed conversations.
 *
 * Live incident, 2026-10-20: two of the Mac Mini's pool logins had never
 * recorded folder trust, so every Claude session launched under them hit "Do
 * you trust the files in this folder?" — default option "No, exit" — and died
 * in 16 seconds. The operator's conversation was PLACED on that machine.
 * Placement kept it there through three deaths in 35 minutes, because the
 * machine's quota was clean and its llm-circuit was available: nothing in the
 * eligibility signal described "cannot start a session".
 *
 * These tests pin the counter's decision boundary on both sides, the clearing
 * signal, and the placement gate's behaviour with and without an alternative
 * machine.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SessionStartFailureTracker,
  DEFAULT_START_FAILURE_THRESHOLD,
  DEFAULT_START_FAILURE_WINDOW_MS,
} from '../../src/core/startFailureTracker.js';
import { computeSelfQuotaState } from '../../src/core/selfQuotaState.js';
import { PlacementExecutor } from '../../src/core/PlacementExecutor.js';
import type { MachineCapacity } from '../../src/core/types.js';

describe('SessionStartFailureTracker', () => {
  it('does not block below the threshold', () => {
    const t = new SessionStartFailureTracker();
    for (let i = 0; i < DEFAULT_START_FAILURE_THRESHOLD - 1; i++) t.recordStartFailure(1000 + i);
    const s = t.state(2000);
    expect(s.consecutive).toBe(DEFAULT_START_FAILURE_THRESHOLD - 1);
    expect(s.blocked).toBe(false);
  });

  it('blocks AT the threshold and reports when it last failed', () => {
    const t = new SessionStartFailureTracker();
    for (let i = 0; i < DEFAULT_START_FAILURE_THRESHOLD; i++) t.recordStartFailure(1000 + i);
    const s = t.state(2000);
    expect(s.blocked).toBe(true);
    expect(s.lastFailureAt).toBe(new Date(1000 + DEFAULT_START_FAILURE_THRESHOLD - 1).toISOString());
  });

  it('one successful start clears it completely — a recovered machine is re-admitted', () => {
    const t = new SessionStartFailureTracker();
    for (let i = 0; i < DEFAULT_START_FAILURE_THRESHOLD + 2; i++) t.recordStartFailure(1000 + i);
    expect(t.state(2000).blocked).toBe(true);
    t.recordStartSuccess();
    expect(t.state(2000)).toEqual({ consecutive: 0, blocked: false });
  });

  it('failures age out of the window — this morning\'s crashes are not tonight\'s verdict', () => {
    const t = new SessionStartFailureTracker();
    const long_ago = 1_000_000;
    for (let i = 0; i < DEFAULT_START_FAILURE_THRESHOLD; i++) t.recordStartFailure(long_ago + i);
    expect(t.state(long_ago + 10).blocked).toBe(true);
    expect(t.state(long_ago + DEFAULT_START_FAILURE_WINDOW_MS + 1).blocked).toBe(false);
  });

  it('reading the state never mutates it', () => {
    const t = new SessionStartFailureTracker();
    t.recordStartFailure(1000);
    const a = t.state(2000);
    const b = t.state(2000);
    expect(a).toEqual(b);
  });

  it('a threshold of 1 blocks on the first failure (configurable boundary)', () => {
    const t = new SessionStartFailureTracker({ thresholdFailures: 1 });
    t.recordStartFailure(1000);
    expect(t.state(1001).blocked).toBe(true);
  });
});

describe('computeSelfQuotaState — the start-failure cause', () => {
  it('blocks a machine with a clean quota and an available circuit', () => {
    // Exactly the Mini's reported state while it was killing every session.
    const r = computeSelfQuotaState(
      { blockedUntil: null, fiveHourPercent: 10 }, true, 1000,
      { consecutive: 3, blocked: true },
    );
    expect(r).toEqual({ blocked: true, reason: 'session-start-failing' });
  });

  it('does NOT block below the threshold', () => {
    const r = computeSelfQuotaState(
      { blockedUntil: null, fiveHourPercent: 10 }, true, 1000,
      { consecutive: 2, blocked: false },
    );
    expect(r).toEqual({ blocked: false });
  });

  it('an absent tracker leaves behaviour exactly as before (unknown is not blocked)', () => {
    expect(computeSelfQuotaState(null, true, 1000)).toBeUndefined();
    expect(computeSelfQuotaState(null, true, 1000, null)).toBeUndefined();
  });
});

describe('PlacementExecutor — a start-failing machine is skipped', () => {
  function machine(id: string, startFailing: boolean): MachineCapacity {
    return {
      machineId: id, online: true, activeSessionCount: 0, maxSessions: 5,
      loadAvg: 0, memPressure: 'low',
      ...(startFailing
        ? { quotaState: { blocked: true, reason: 'session-start-failing' } }
        : {}),
    } as MachineCapacity;
  }

  const executor = new PlacementExecutor();

  it('places on the healthy machine instead of the one that cannot start', () => {
    const d = executor.decide({
      topicId: 127648,
      machineRegistry: [machine('m_mini', true), machine('m_studio', false)],
    } as never);
    expect(d.chosenMachine).toBe('m_studio');
    expect(d.outcome).toBe('placed');
  });

  it('still places somewhere when EVERY machine is start-failing — somewhere beats nowhere', () => {
    const d = executor.decide({
      topicId: 127648,
      machineRegistry: [machine('m_mini', true), machine('m_studio', true)],
    } as never);
    expect(d.chosenMachine).not.toBeNull();
    expect(d.escalationReason ?? d.reason).toBeTruthy();
  });

  it('a deliberate pin is still honoured, and names the real cause', () => {
    const d = executor.decide({
      topicId: 127648,
      topicMetadata: { pinned: true, preferredMachine: 'm_mini' },
      machineRegistry: [machine('m_mini', true), machine('m_studio', false)],
    } as never);
    expect(d.chosenMachine).toBe('m_mini');
    expect(d.escalationReason).toBe('pinned-machine-cannot-start-sessions');
  });
});

describe('wiring integrity — the counter is actually fed and actually read', () => {
  const SERVER_SRC = readFileSync(join(process.cwd(), 'src/commands/server.ts'), 'utf-8');
  const MANAGER_SRC = readFileSync(join(process.cwd(), 'src/core/SessionManager.ts'), 'utf-8');

  it('server.ts constructs the tracker', () => {
    expect(SERVER_SRC).toContain('new SessionStartFailureTracker()');
  });

  it('a startup death increments it', () => {
    expect(SERVER_SRC).toContain("e.reason === 'process-exited-during-startup'");
    expect(SERVER_SRC).toContain('recordStartFailure()');
  });

  it('a successful start clears it — otherwise the block never lifts', () => {
    expect(MANAGER_SRC).toContain("this.emit('sessionStartSucceeded'");
    expect(SERVER_SRC).toContain("sessionManager.on('sessionStartSucceeded'");
    expect(SERVER_SRC).toContain('recordStartSuccess()');
  });

  it('its state reaches the capacity heartbeat placement reads', () => {
    const idx = SERVER_SRC.indexOf('computeSelfQuotaState(');
    expect(idx).toBeGreaterThan(-1);
    expect(SERVER_SRC.slice(idx, idx + 300)).toContain('startFailureTracker.state()');
  });

  it('the operator is told once, not per failure', () => {
    expect(SERVER_SRC).toContain("id: 'machine-cannot-start-sessions'");
    expect(SERVER_SRC).toContain('if (!before && after.blocked)');
  });
});
