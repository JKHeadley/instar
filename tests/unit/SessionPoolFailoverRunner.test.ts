import { describe, it, expect } from 'vitest';
import { SessionPoolFailoverRunner, type FailoverCheckResult } from '../../src/core/SessionPoolFailoverRunner.js';
import type { SessionPoolE2EResultStore, StageE2EOutcome } from '../../src/core/SessionPoolE2EResultStore.js';

const SHA = 'commit-xyz';

/** A recording fake store: captures every recordResult call the runner makes. */
function fakeStore() {
  const calls: Array<{ stage: number; result: StageE2EOutcome; commitSha: string; evidenceRef: string }> = [];
  const store = {
    recordResult: (stage: number, result: StageE2EOutcome, commitSha: string, evidenceRef: string) => {
      calls.push({ stage, result, commitSha, evidenceRef });
      return { stage, result, commitSha, ranAt: 'now', evidenceRef, signature: 'sig' };
    },
  } as unknown as SessionPoolE2EResultStore;
  return { store, calls };
}

function makeRunner(opts: {
  enabled: boolean;
  check: () => Promise<FailoverCheckResult>;
  provenStage?: number;
}) {
  const { store, calls } = fakeStore();
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const runner = new SessionPoolFailoverRunner({
    resultStore: store,
    runFailoverCheck: opts.check,
    currentCommitSha: () => SHA,
    provenStage: () => opts.provenStage ?? 1, // shadow index — gates the live-transfer advance
    enabled: () => opts.enabled,
    audit: (event, detail) => audits.push({ event, detail }),
  });
  return { runner, calls, audits };
}

describe('SessionPoolFailoverRunner', () => {
  it('is a strict no-op when disabled — never runs the check, never records', async () => {
    let checkRan = false;
    const { runner, calls } = makeRunner({
      enabled: false,
      check: async () => { checkRan = true; return { outcome: 'green', evidenceRef: 'ref' }; },
    });
    const res = await runner.tick();
    expect(res).toEqual({ ran: false, outcome: null, recorded: false });
    expect(checkRan).toBe(false); // dark ⇒ the check is not even invoked
    expect(calls).toHaveLength(0);
  });

  it('records a green (bound to the current commit + proven stage) on a genuine pass', async () => {
    const { runner, calls } = makeRunner({
      enabled: true,
      provenStage: 1,
      check: async () => ({ outcome: 'green', evidenceRef: 'run-42' }),
    });
    const res = await runner.tick();
    expect(res).toEqual({ ran: true, outcome: 'green', recorded: true });
    expect(calls).toEqual([{ stage: 1, result: 'green', commitSha: SHA, evidenceRef: 'run-42' }]);
  });

  it('records a red on a genuine failover regression (so the driver can auto-revert)', async () => {
    const { runner, calls } = makeRunner({
      enabled: true,
      check: async () => ({ outcome: 'red', evidenceRef: 'run-43' }),
    });
    const res = await runner.tick();
    expect(res).toEqual({ ran: true, outcome: 'red', recorded: true });
    expect(calls).toEqual([{ stage: 1, result: 'red', commitSha: SHA, evidenceRef: 'run-43' }]);
  });

  it('records NOTHING when the check throws — an infra error is not a verdict (honesty line)', async () => {
    const { runner, calls, audits } = makeRunner({
      enabled: true,
      check: async () => { throw new Error('two-node setup failed to bind a port'); },
    });
    const res = await runner.tick();
    expect(res).toEqual({ ran: true, outcome: 'error', recorded: false });
    expect(calls).toHaveLength(0); // no fabricated green AND no fabricated red
    expect(audits.some((a) => a.event === 'failover-check-errored')).toBe(true);
  });

  it('binds the recorded verdict to the LIVE commit sha at tick time (not a stale one)', async () => {
    // Prove the sha is read per-tick via currentCommitSha (not captured once).
    const { store, calls } = fakeStore();
    let sha = 'sha-old';
    const runner = new SessionPoolFailoverRunner({
      resultStore: store,
      runFailoverCheck: async () => ({ outcome: 'green', evidenceRef: 'r' }),
      currentCommitSha: () => sha,
      provenStage: () => 1,
      enabled: () => true,
    });
    await runner.tick();
    sha = 'sha-new';
    await runner.tick();
    expect(calls.map((c) => c.commitSha)).toEqual(['sha-old', 'sha-new']);
  });

  it('records nothing when the configured stage changes while the check is in flight', async () => {
    const { store, calls } = fakeStore();
    const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
    let stage = 1;
    let finish!: (result: FailoverCheckResult) => void;
    const runner = new SessionPoolFailoverRunner({
      resultStore: store,
      runFailoverCheck: () => new Promise((resolve) => { finish = resolve; }),
      currentCommitSha: () => SHA,
      provenStage: () => stage,
      enabled: () => true,
      audit: (event, detail) => audits.push({ event, detail }),
    });

    const tick = runner.tick();
    stage = 2;
    finish({ outcome: 'green', evidenceRef: 'stage-moved-mid-check' });

    expect(await tick).toEqual({ ran: true, outcome: 'error', recorded: false });
    expect(calls).toHaveLength(0);
    expect(audits).toContainEqual({
      event: 'failover-check-stage-changed',
      detail: expect.objectContaining({ stageAtStart: 1, stageAfterCheck: 2 }),
    });
  });
});
