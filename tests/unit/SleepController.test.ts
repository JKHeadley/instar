/**
 * Unit tests — SleepController decision logic (agent hard-sleep, Stage B foundation).
 * Covers BOTH sides of every guard boundary, and the dry-run-never-acts contract.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  evaluateSleep,
  SleepController,
  DEFAULT_SLEEP_THRESHOLDS,
  type SleepInput,
  type SleepThresholds,
  type SleepVerdict,
} from '../../src/monitoring/SleepController.js';

const T: SleepThresholds = { idleGraceMs: 120_000, deepIdleMs: 900_000, wakeLeadMs: 120_000 };
const NOW = 1_000_000_000_000;

/** Deep-idle, all guards clear ⇒ would-sleep by default; tests flip one field. */
function input(over: Partial<SleepInput> = {}): SleepInput {
  return {
    now: NOW,
    runningSessions: 0,
    lastInboundAt: NOW - 30 * 60_000, // 30 min ago (deep)
    lastActivityAt: NOW - 30 * 60_000,
    holdsLease: false,
    leaseActive: false,
    inflightWork: false,
    nextScheduledJobAt: null,
    ...over,
  };
}

describe('evaluateSleep', () => {
  it('would-sleep when deep-idle and every guard is clear', () => {
    expect(evaluateSleep(input(), T).decision).toBe('would-sleep');
  });

  it('awake when a session is running (even if otherwise deep-idle)', () => {
    expect(evaluateSleep(input({ runningSessions: 1 }), T).decision).toBe('awake');
  });

  it('awake when activity is within the idle grace window', () => {
    expect(evaluateSleep(input({ lastActivityAt: NOW - 30_000 }), T).decision).toBe('awake');
  });

  it('idle-shallow when idle past grace but before deep-idle', () => {
    // 5 min idle: > 2 min grace, < 15 min deep
    const v = evaluateSleep(input({ lastInboundAt: NOW - 5 * 60_000, lastActivityAt: NOW - 5 * 60_000 }), T);
    expect(v.decision).toBe('idle-shallow');
  });

  it('boundary: exactly deepIdleMs idle ⇒ deep (would-sleep), one ms less ⇒ shallow', () => {
    const at = (ms: number) => input({ lastInboundAt: NOW - ms, lastActivityAt: NOW - ms });
    expect(evaluateSleep(at(T.deepIdleMs), T).decision).toBe('would-sleep');
    expect(evaluateSleep(at(T.deepIdleMs - 1), T).decision).toBe('idle-shallow');
  });

  it('boundary: exactly idleGraceMs ⇒ idle (shallow), one ms less ⇒ awake', () => {
    const at = (ms: number) => input({ lastInboundAt: NOW - ms, lastActivityAt: NOW - ms });
    expect(evaluateSleep(at(T.idleGraceMs), T).decision).toBe('idle-shallow');
    expect(evaluateSleep(at(T.idleGraceMs - 1), T).decision).toBe('awake');
  });

  it('keep-awake when this machine holds the multi-machine lease', () => {
    const v = evaluateSleep(input({ leaseActive: true, holdsLease: true }), T);
    expect(v.decision).toBe('keep-awake');
    expect(v.reason).toMatch(/lease/i);
  });

  it('would-sleep when lease coordination active but this machine does NOT hold it', () => {
    expect(evaluateSleep(input({ leaseActive: true, holdsLease: false }), T).decision).toBe('would-sleep');
  });

  it('holdsLease is ignored when lease coordination is not active (single machine)', () => {
    expect(evaluateSleep(input({ leaseActive: false, holdsLease: true }), T).decision).toBe('would-sleep');
  });

  it('keep-awake when there is in-flight work', () => {
    const v = evaluateSleep(input({ inflightWork: true }), T);
    expect(v.decision).toBe('keep-awake');
    expect(v.reason).toMatch(/in-flight/i);
  });

  it('keep-awake when a scheduled job fires within the wake-lead window', () => {
    const v = evaluateSleep(input({ nextScheduledJobAt: NOW + 60_000 }), T); // 1 min < 2 min lead
    expect(v.decision).toBe('keep-awake');
    expect(v.reason).toMatch(/scheduled job/i);
  });

  it('would-sleep when the next scheduled job is comfortably beyond the wake-lead', () => {
    expect(evaluateSleep(input({ nextScheduledJobAt: NOW + 60 * 60_000 }), T).decision).toBe('would-sleep');
  });

  it('boundary: job exactly at wakeLead ⇒ keep-awake, one ms beyond ⇒ would-sleep', () => {
    expect(evaluateSleep(input({ nextScheduledJobAt: NOW + T.wakeLeadMs }), T).decision).toBe('keep-awake');
    expect(evaluateSleep(input({ nextScheduledJobAt: NOW + T.wakeLeadMs + 1 }), T).decision).toBe('would-sleep');
  });

  it('never any inbound/activity signal ⇒ treated as deep-idle (would-sleep)', () => {
    expect(evaluateSleep(input({ lastInboundAt: null, lastActivityAt: null }), T).decision).toBe('would-sleep');
  });

  it('uses the MOST RECENT of inbound vs activity for idle duration', () => {
    // inbound long ago but activity recent ⇒ awake
    const v = evaluateSleep(input({ lastInboundAt: NOW - 60 * 60_000, lastActivityAt: NOW - 10_000 }), T);
    expect(v.decision).toBe('awake');
  });
});

describe('SleepController', () => {
  it('dry-run NEVER calls requestSleep even on would-sleep', () => {
    const requestSleep = vi.fn();
    const c = new SleepController(
      { sample: () => input(), requestSleep },
      { enabled: true, dryRun: true },
    );
    const v = c.tick();
    expect(v.decision).toBe('would-sleep');
    expect(requestSleep).not.toHaveBeenCalled();
    expect(c.state.sleepRequested).toBe(false);
  });

  it('live mode requests sleep ONCE per would-sleep episode', () => {
    const requestSleep = vi.fn();
    let sample = input();
    const c = new SleepController(
      { sample: () => sample, requestSleep },
      { enabled: true, dryRun: false },
    );
    c.tick(); // would-sleep → request
    c.tick(); // still would-sleep → no second request (latched)
    expect(requestSleep).toHaveBeenCalledTimes(1);
    // leave would-sleep, then return ⇒ a fresh request
    sample = input({ runningSessions: 1 });
    c.tick(); // awake → latch reset
    sample = input();
    c.tick(); // would-sleep again → second request
    expect(requestSleep).toHaveBeenCalledTimes(2);
  });

  it('live mode but disabled ⇒ does not request sleep', () => {
    const requestSleep = vi.fn();
    const c = new SleepController(
      { sample: () => input(), requestSleep },
      { enabled: false, dryRun: false },
    );
    c.tick();
    expect(requestSleep).not.toHaveBeenCalled();
  });

  it('audits only on decision TRANSITIONS, not every tick', () => {
    const audit = vi.fn();
    let sample = input();
    const c = new SleepController({ sample: () => sample, audit }, { enabled: true, dryRun: true });
    c.tick(); // would-sleep (transition from null)
    c.tick(); // would-sleep (no change)
    c.tick(); // would-sleep (no change)
    expect(audit).toHaveBeenCalledTimes(1);
    sample = input({ runningSessions: 1 });
    c.tick(); // awake (transition)
    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit.mock.calls[1][0].decision).toBe('awake');
    expect(audit.mock.calls[1][0].dryRun).toBe(true);
  });

  it('default thresholds are applied when none provided', () => {
    const c = new SleepController({ sample: () => input() }, { enabled: true, dryRun: true });
    // 30-min idle in input() exceeds default 15-min deepIdle ⇒ would-sleep
    expect(c.tick().decision).toBe('would-sleep');
    expect(DEFAULT_SLEEP_THRESHOLDS.deepIdleMs).toBe(900_000);
  });
});

import { AgentActivityState } from '../../src/monitoring/AgentActivityState.js';

describe('AgentActivityState', () => {
  it('starts with null signals', () => {
    expect(new AgentActivityState().snapshot()).toEqual({ lastInboundAt: null, lastActivityAt: null });
  });
  it('markInbound sets both inbound and activity', () => {
    const a = new AgentActivityState();
    a.markInbound(NOW);
    expect(a.snapshot()).toEqual({ lastInboundAt: NOW, lastActivityAt: NOW });
  });
  it('markActivity advances activity but NOT inbound', () => {
    const a = new AgentActivityState();
    a.markInbound(NOW - 1000);
    a.markActivity(NOW);
    expect(a.snapshot()).toEqual({ lastInboundAt: NOW - 1000, lastActivityAt: NOW });
  });
});

import { sleepRequestWriter } from '../../src/monitoring/SleepController.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('sleepRequestWriter', () => {
  it('writes a TTL-stamped sleep-requested.json the supervisor can consume', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleep-req-'));
    try {
      const write = sleepRequestWriter(dir, 60_000);
      write({ decision: 'would-sleep', reason: 'deep-idle 30m', idleForMs: 1_800_000 });
      const p = path.join(dir, 'state', 'sleep-requested.json');
      expect(fs.existsSync(p)).toBe(true);
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      expect(data.requestedBy).toBe('SleepController');
      expect(data.reason).toMatch(/deep-idle/);
      expect(new Date(data.expiresAt).getTime()).toBeGreaterThan(Date.now());
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test-cleanup' });
    }
  });
});
