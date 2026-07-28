import { describe, it, expect } from 'vitest';
import { applyNobodyPollingRecovery, type NobodyPollingActuatorPorts } from '../../src/core/nobodyPollingActuator.js';
import { NobodyPollingLedger, type NobodyPollingDecision } from '../../src/core/nobodyPollingRecovery.js';

const t = '2026-06-28T00:00:00.000Z';

function spyPorts(over: Partial<{ casWins: boolean; fresh: boolean; epoch: number }> = {}): {
  ports: NobodyPollingActuatorPorts;
  calls: { acquire: number; start: number[]; relinquish: number };
} {
  const calls = { acquire: 0, start: [] as number[], relinquish: 0 };
  const ports: NobodyPollingActuatorPorts = {
    acquireFencedCas: async () => { calls.acquire += 1; return over.casWins ?? true; },
    localPollSucceededFresh: () => over.fresh ?? true,
    currentEpoch: () => over.epoch ?? 42,
    startPolling: (e) => { calls.start.push(e); },
    relinquishAndSelfExclude: () => { calls.relinquish += 1; },
  };
  return { ports, calls };
}

const claim: NobodyPollingDecision = { action: 'claim', claimant: 'm_self', selfClaims: true, reason: 'lowest-id-fit' };
const standDown: NobodyPollingDecision = { action: 'stand-down', claimant: 'm_a', selfClaims: false, reason: 'x' };

describe('applyNobodyPollingRecovery — enforce actuator', () => {
  it('non-self-claim decision → no-action, ZERO port calls (never touches the lease)', async () => {
    const { ports, calls } = spyPorts();
    const out = await applyNobodyPollingRecovery({ decision: standDown, dryRun: false, ports, ledger: new NobodyPollingLedger(), nowIso: t });
    expect(out.result).toBe('no-action');
    expect(calls.acquire).toBe(0);
    expect(calls.start).toEqual([]);
    expect(calls.relinquish).toBe(0);
  });

  it('dryRun + claim → dry-run-would-claim with NO side effects (the safety invariant)', async () => {
    const { ports, calls } = spyPorts();
    const out = await applyNobodyPollingRecovery({ decision: claim, dryRun: true, ports, ledger: new NobodyPollingLedger(), nowIso: t });
    expect(out.result).toBe('dry-run-would-claim');
    expect(calls.acquire).toBe(0);   // NO fenced-CAS acquire in dryRun
    expect(calls.start).toEqual([]); // NO poll-lever write in dryRun
    expect(calls.relinquish).toBe(0);
  });

  it('enforce + claim + CAS lost → cas-lost, does NOT start polling', async () => {
    const { ports, calls } = spyPorts({ casWins: false });
    const out = await applyNobodyPollingRecovery({ decision: claim, dryRun: false, ports, ledger: new NobodyPollingLedger(), nowIso: t });
    expect(out.result).toBe('cas-lost');
    expect(calls.acquire).toBe(1);
    expect(calls.start).toEqual([]);
  });

  it('enforce + claim + CAS won + self-reverify FRESH → claimed-serving, starts polling at the won epoch', async () => {
    const { ports, calls } = spyPorts({ casWins: true, fresh: true, epoch: 99 });
    const out = await applyNobodyPollingRecovery({ decision: claim, dryRun: false, ports, ledger: new NobodyPollingLedger(), nowIso: t });
    expect(out.result).toBe('claimed-serving');
    expect(calls.acquire).toBe(1);
    expect(calls.start).toEqual([99]);
    expect(calls.relinquish).toBe(0);
  });

  it('enforce + claim + CAS won + self-reverify STALE → self-excluded, relinquishes + records, does NOT poll', async () => {
    const { ports, calls } = spyPorts({ casWins: true, fresh: false });
    const led = new NobodyPollingLedger();
    const out = await applyNobodyPollingRecovery({ decision: claim, dryRun: false, ports, ledger: led, nowIso: t });
    expect(out.result).toBe('self-excluded');
    expect(calls.acquire).toBe(1);
    expect(calls.relinquish).toBe(1);
    expect(calls.start).toEqual([]);
    expect(led.summary().selfExclusions).toBe(1);
  });
});
