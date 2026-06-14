/**
 * SessionDrainRunner (WS1.2, MULTI-MACHINE-SEAMLESSNESS-SPEC) — the owner-side
 * bounded drain. Both sides of every boundary: clean drain at the turn
 * boundary, forced close at the bound (interrupted marker + ONE notice),
 * emergency-stop abort (topic stays, FSM abort-transfer), the three refusals
 * (not-owner / stale-epoch / cas-lost), idempotent re-delivery, and the
 * claim-lost honest path. Deterministic clock, no real timers.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  SessionDrainRunner,
  type SessionDrainRunnerDeps,
} from '../../src/core/SessionDrainRunner.js';
import type { SessionOwnershipRecord, OwnershipAction } from '../../src/core/SessionOwnership.js';

function activeRec(over: Partial<SessionOwnershipRecord> = {}): SessionOwnershipRecord {
  return {
    sessionKey: '13481', ownerMachineId: 'm_self', ownershipEpoch: 4, status: 'active',
    nonce: 'n', timestamp: 1_000_000, updatedAt: new Date(1_000_000).toISOString(),
    ...over,
  };
}

function harness(opts: {
  rec?: SessionOwnershipRecord | null;
  quietAfterPolls?: number;       // sessionQuiet flips true after N polls (Infinity = never)
  emergencyAfterPolls?: number;   // emergencyStopActive flips true after N polls
  casOk?: (action: OwnershipAction) => boolean;
  deps?: Partial<SessionDrainRunnerDeps>;
} = {}) {
  let now = 1_000_000;
  let polls = 0;
  const casCalls: OwnershipAction[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const terminate = vi.fn(async () => ({ terminated: true }));
  const markInterrupted = vi.fn();
  const notifyInterrupted = vi.fn();
  const suspend = vi.fn(() => ({ suspended: true }));

  const deps: SessionDrainRunnerDeps = {
    selfMachineId: 'm_self',
    readOwnership: () => (opts.rec === undefined ? activeRec() : opts.rec),
    cas: (action) => {
      casCalls.push(action);
      return { ok: opts.casOk ? opts.casOk(action) : true };
    },
    suspendAutonomousRun: suspend,
    sessionQuiet: () => polls >= (opts.quietAfterPolls ?? 0),
    emergencyStopActive: () => polls >= (opts.emergencyAfterPolls ?? Infinity),
    terminateSession: terminate,
    markInterrupted,
    notifyInterrupted,
    audit: (e) => audits.push(e),
    now: () => now,
    sleep: async (ms) => { now += ms; polls++; },
    nonce: () => `nonce-${casCalls.length}`,
    ...opts.deps,
  };
  return {
    runner: new SessionDrainRunner(deps, { drainBoundMs: 5_000, pollMs: 1_000 }),
    casCalls, audits, terminate, markInterrupted, notifyInterrupted, suspend,
  };
}

describe('SessionDrainRunner — WS1.2 owner-side bounded drain', () => {
  it('clean drain: transferring CAS (drain provenance) → suspend → quiet → close → claim for the TARGET', async () => {
    const h = harness({ quietAfterPolls: 2 });
    const out = await h.runner.run({ sessionKey: '13481', target: 'm_mini', senderObservedEpoch: 4 });
    expect(out.status).toBe('drained');
    expect(out.autonomousRunSuspended).toBe(true);
    expect(h.casCalls[0]).toEqual({ type: 'transfer', to: 'm_mini', drain: true });
    expect(h.suspend).toHaveBeenCalledWith('13481', 'm_mini');
    expect(h.terminate).toHaveBeenCalledTimes(1);
    expect(h.terminate.mock.calls[0][2]).toEqual({ force: false });
    // The claim NAMES the target (router-confirmClaim precedent) — the barrier release.
    expect(h.casCalls[1]).toEqual({ type: 'claim', machineId: 'm_mini' });
    expect(h.notifyInterrupted).not.toHaveBeenCalled();
    expect(h.markInterrupted).not.toHaveBeenCalled();
  });

  it('forced at the bound: never-quiet session → force-close + interrupted marker + ONE notice + claim still lands', async () => {
    const h = harness({ quietAfterPolls: Infinity });
    const out = await h.runner.run({ sessionKey: '13481', target: 'm_mini', senderObservedEpoch: 4 });
    expect(out.status).toBe('drained-interrupted');
    expect(out.drainedInMs).toBeGreaterThanOrEqual(5_000);
    expect(h.terminate.mock.calls[0][2]).toEqual({ force: true });
    expect(h.markInterrupted).toHaveBeenCalledTimes(1);
    expect(h.notifyInterrupted).toHaveBeenCalledTimes(1);
    expect(h.casCalls.at(-1)).toEqual({ type: 'claim', machineId: 'm_mini' });
  });

  it('emergency stop mid-drain: abort-transfer CAS, session NOT closed, topic stays here', async () => {
    const h = harness({ quietAfterPolls: Infinity, emergencyAfterPolls: 2 });
    const out = await h.runner.run({ sessionKey: '13481', target: 'm_mini', senderObservedEpoch: 4 });
    expect(out.status).toBe('aborted-emergency-stop');
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.casCalls.at(-1)).toEqual({ type: 'abort-transfer', machineId: 'm_self' });
    // No claim — the transfer did NOT complete.
    expect(h.casCalls.some(a => a.type === 'claim')).toBe(false);
  });

  it('emergency stop checked BEFORE the first quiet check (poll 0)', async () => {
    const h = harness({ quietAfterPolls: 0, emergencyAfterPolls: 0 });
    const out = await h.runner.run({ sessionKey: '13481', target: 'm_mini', senderObservedEpoch: 4 });
    expect(out.status).toBe('aborted-emergency-stop');
    expect(h.terminate).not.toHaveBeenCalled();
  });

  it('refuses when this machine is not the owner', async () => {
    const h = harness({ rec: activeRec({ ownerMachineId: 'm_other' }) });
    const out = await h.runner.run({ sessionKey: '13481', target: 'm_mini', senderObservedEpoch: 4 });
    expect(out.status).toBe('refused-not-owner');
    expect(h.casCalls).toHaveLength(0);
    expect(h.terminate).not.toHaveBeenCalled();
  });

  it('refuses a stale/replayed drain (sender epoch ≠ current epoch)', async () => {
    const h = harness({ rec: activeRec({ ownershipEpoch: 7 }) });
    const out = await h.runner.run({ sessionKey: '13481', target: 'm_mini', senderObservedEpoch: 4 });
    expect(out.status).toBe('refused-stale-epoch');
    expect(h.casCalls).toHaveLength(0);
  });

  it('refuses on a lost transferring CAS (a peer raced us)', async () => {
    const h = harness({ casOk: (a) => a.type !== 'transfer' });
    const out = await h.runner.run({ sessionKey: '13481', target: 'm_mini', senderObservedEpoch: 4 });
    expect(out.status).toBe('refused-cas-lost');
    expect(h.terminate).not.toHaveBeenCalled();
  });

  it('a re-delivered drain for the SAME in-flight transfer resumes idempotently (no second transferring CAS)', async () => {
    const h = harness({
      rec: activeRec({ status: 'transferring', transferTo: 'm_mini', drainInFlight: true }),
      quietAfterPolls: 0,
    });
    const out = await h.runner.run({ sessionKey: '13481', target: 'm_mini', senderObservedEpoch: 4 });
    expect(out.status).toBe('drained');
    // Only the completion claim — no transfer CAS on resume.
    expect(h.casCalls.map(a => a.type)).toEqual(['claim']);
  });

  it('a transferring record for a DIFFERENT target refuses (not this drain\'s transfer)', async () => {
    const h = harness({ rec: activeRec({ status: 'transferring', transferTo: 'm_other' }) });
    const out = await h.runner.run({ sessionKey: '13481', target: 'm_mini', senderObservedEpoch: 4 });
    expect(out.status).toBe('refused-not-owner');
  });

  it('a lost completion claim still reports drained (the reconciler backstop finishes it)', async () => {
    const h = harness({ quietAfterPolls: 0, casOk: (a) => a.type !== 'claim' });
    const out = await h.runner.run({ sessionKey: '13481', target: 'm_mini', senderObservedEpoch: 4 });
    expect(out.status).toBe('drained');
    const completed = h.audits.find(a => a.event === 'drain-completed');
    expect(completed?.claimLanded).toBe(false);
  });

  it('suspend failure is honest (autonomousRunSuspended:false) and never blocks the drain', async () => {
    const h = harness({
      quietAfterPolls: 0,
      deps: { suspendAutonomousRun: () => { throw new Error('disk'); } },
    });
    const out = await h.runner.run({ sessionKey: '13481', target: 'm_mini', senderObservedEpoch: 4 });
    expect(out.status).toBe('drained');
    expect(out.autonomousRunSuspended).toBe(false);
  });

  it('a vetoed close is carried in the outcome detail (never silently claimed closed)', async () => {
    const h = harness({
      quietAfterPolls: 0,
      deps: { terminateSession: vi.fn(async () => ({ terminated: false, skipped: 'protected' })) },
    });
    const out = await h.runner.run({ sessionKey: '13481', target: 'm_mini', senderObservedEpoch: 4 });
    expect(out.detail).toContain('close-skipped:protected');
  });
});
