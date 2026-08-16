/**
 * Tier-1 tests for the §5.3 quota-aware seat-transfer failover decision + executor
 * (spec: cross-machine-account-quota-sharing.md §5.3, D4/D8/D10/D11).
 * Both sides of every boundary: fires/doesn't, hysteresis, admission bounce→next
 * candidate, the D10 fail-open branches, single-machine no-op, dry-run.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  decideFailover,
  ServeFailoverEngine,
  DEFAULT_SERVE_FAILOVER_POLICY,
  resolveServeFailoverPolicy,
  type FailoverDecisionInput,
  type TransferAttemptResult,
} from '../../src/core/ServeFailoverEngine.js';
import type { MachineCapacity } from '../../src/core/types.js';

const reqTg = { platform: 'telegram' as const, chatId: '100' };

function mc(partial: Partial<MachineCapacity> & { machineId: string }): MachineCapacity {
  return {
    online: true,
    clockSkewStatus: 'ok',
    ...partial,
  } as MachineCapacity;
}

const serveable = (id: string): MachineCapacity =>
  mc({ machineId: id, canServe: { hasNonWalledAccount: true, servesChannels: { telegram: { chatIds: ['100'] } } } });
const walled = (id: string): MachineCapacity =>
  mc({ machineId: id, canServe: { hasNonWalledAccount: false, servesChannels: { telegram: { chatIds: ['100'] } } } });

function baseInput(over: Partial<FailoverDecisionInput>): FailoverDecisionInput {
  return {
    topicId: 'T1',
    requirement: reqTg,
    selfMachineId: 'self',
    currentOwner: 'self',
    machines: [],
    localOwnerCanServe: true,
    localOwnerServeabilityCertain: true,
    destCooldownUntil: new Map(),
    inFlightFromSource: 0,
    lastSeatMoveAtMs: null,
    nowMs: 1_000_000,
    policy: DEFAULT_SERVE_FAILOVER_POLICY,
    ...over,
  };
}

describe('decideFailover (pure)', () => {
  it('owner CAN serve (local) ⇒ no-action', () => {
    const d = decideFailover(baseInput({ localOwnerCanServe: true, machines: [serveable('self')] }));
    expect(d.action).toBe('no-action-owner-serves');
  });

  it('owner walled + a serveable peer ⇒ transfer to that peer', () => {
    const d = decideFailover(
      baseInput({
        localOwnerCanServe: false,
        machines: [walled('self'), serveable('peerA')],
      }),
    );
    expect(d.action).toBe('transfer');
    expect(d.chosenCandidate).toBe('peerA');
    expect(d.candidates).toEqual(['peerA']);
  });

  it('owner walled + NO serveable peer ⇒ honest-degradation', () => {
    const d = decideFailover(
      baseInput({ localOwnerCanServe: false, machines: [walled('self'), walled('peerA')] }),
    );
    expect(d.action).toBe('honest-degradation');
    expect(d.reason).toBe('no-peer-can-serve');
  });

  it('single-machine pool (only self) ⇒ no-action-single-machine (structural no-op)', () => {
    const d = decideFailover(baseInput({ localOwnerCanServe: false, machines: [walled('self')] }));
    expect(d.action).toBe('no-action-single-machine');
  });

  it('D10 (a): local owner UNCERTAIN serveability ⇒ owner serves (never route on a guess)', () => {
    const d = decideFailover(
      baseInput({
        localOwnerCanServe: false,
        localOwnerServeabilityCertain: false,
        machines: [walled('self'), serveable('peerA')],
      }),
    );
    expect(d.action).toBe('no-action-owner-serves');
    expect(d.reason).toBe('local-serveability-uncertain-owner-serves');
  });

  it('D4 hysteresis: within seat-dwell window ⇒ defer-dwell (no thrash)', () => {
    const d = decideFailover(
      baseInput({
        localOwnerCanServe: false,
        machines: [walled('self'), serveable('peerA')],
        lastSeatMoveAtMs: 1_000_000 - 1_000, // 1s ago, well within 60s dwell
      }),
    );
    expect(d.action).toBe('defer-dwell');
  });

  it('D4: after the dwell window passes ⇒ transfer resumes', () => {
    const d = decideFailover(
      baseInput({
        localOwnerCanServe: false,
        machines: [walled('self'), serveable('peerA')],
        lastSeatMoveAtMs: 1_000_000 - 61_000, // older than 60s dwell
      }),
    );
    expect(d.action).toBe('transfer');
  });

  it('source concurrency cap saturated ⇒ defer-source-cap', () => {
    const d = decideFailover(
      baseInput({
        localOwnerCanServe: false,
        machines: [walled('self'), serveable('peerA')],
        inFlightFromSource: DEFAULT_SERVE_FAILOVER_POLICY.maxConcurrentFailoversPerSource,
      }),
    );
    expect(d.action).toBe('defer-source-cap');
  });

  it('a peer in bounce-cooldown is excluded from candidates', () => {
    const cooldown = new Map<string, number>([['peerA', 1_000_000 + 5_000]]);
    const d = decideFailover(
      baseInput({
        localOwnerCanServe: false,
        machines: [walled('self'), serveable('peerA')],
        destCooldownUntil: cooldown,
      }),
    );
    // peerA is cooled down and the only peer → honest degradation.
    expect(d.action).toBe('honest-degradation');
  });

  it('an offline serveable peer is not a candidate', () => {
    const d = decideFailover(
      baseInput({
        localOwnerCanServe: false,
        machines: [walled('self'), mc({ machineId: 'peerA', online: false, canServe: { hasNonWalledAccount: true, servesChannels: { telegram: { chatIds: ['100'] } } } })],
      }),
    );
    expect(d.action).toBe('honest-degradation');
  });

  it('bounded candidates: maxAdmissionAttempts caps the candidate list', () => {
    const d = decideFailover(
      baseInput({
        localOwnerCanServe: false,
        machines: [walled('self'), serveable('a'), serveable('b'), serveable('c'), serveable('d')],
        policy: { ...DEFAULT_SERVE_FAILOVER_POLICY, maxAdmissionAttempts: 2 },
      }),
    );
    expect(d.action).toBe('transfer');
    expect(d.candidates.length).toBe(2);
  });
});

describe('resolveServeFailoverPolicy', () => {
  it('defaults when cfg absent', () => {
    expect(resolveServeFailoverPolicy(undefined)).toEqual(DEFAULT_SERVE_FAILOVER_POLICY);
  });
  it('numeric-safe: zero dwell honored (not coerced to default)', () => {
    expect(resolveServeFailoverPolicy({ minSeatDwellMs: 0 }).minSeatDwellMs).toBe(0);
  });
});

describe('ServeFailoverEngine.handleInbound (executor)', () => {
  function makeEngine(over: Partial<Parameters<typeof ServeFailoverEngine.prototype.constructor>[0]> = {} as never, opts: { dryRun?: boolean; enabled?: boolean; machines?: MachineCapacity[]; localCanServe?: boolean; transfer?: (t: string, to: string) => Promise<TransferAttemptResult> } = {}) {
    const audit = vi.fn();
    const emitHonest = vi.fn();
    const transfer = opts.transfer ?? (async () => ({ ok: true, bounced: false }));
    const engine = new ServeFailoverEngine({
      policy: DEFAULT_SERVE_FAILOVER_POLICY,
      selfMachineId: () => 'self',
      getMachines: () => opts.machines ?? [walled('self'), serveable('peerA')],
      ownerOf: () => 'self',
      ownershipEpoch: () => 7,
      isEnabled: () => opts.enabled ?? true,
      isDryRun: () => opts.dryRun ?? false,
      localServeability: () => ({ canServe: opts.localCanServe ?? false, certain: true }),
      executeTransfer: transfer,
      emitHonestDegradation: emitHonest,
      audit,
      now: () => 2_000_000,
      ...over,
    });
    return { engine, audit, emitHonest, transfer };
  }

  it('STRICT no-op when disabled (dark)', async () => {
    const { engine, audit } = makeEngine(undefined, { enabled: false });
    const d = await engine.handleInbound('T1', reqTg);
    expect(d.reason).toBe('feature-disabled');
    expect(audit).not.toHaveBeenCalled();
  });

  it('dry-run: records the PROPOSED transfer but fires none', async () => {
    const transfer = vi.fn(async () => ({ ok: true, bounced: false }));
    const { engine, audit } = makeEngine(undefined, { dryRun: true, transfer });
    const d = await engine.handleInbound('T1', reqTg);
    expect(d.action).toBe('transfer');
    expect(transfer).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'dry-run', to: 'peerA' }));
  });

  it('live: fires the transfer to the chosen candidate on success', async () => {
    const transfer = vi.fn(async () => ({ ok: true, bounced: false }));
    const { engine, audit } = makeEngine(undefined, { transfer });
    const d = await engine.handleInbound('T1', reqTg);
    expect(transfer).toHaveBeenCalledWith('T1', 'peerA', 7);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'transferred', to: 'peerA' }));
    expect(d.chosenCandidate).toBe('peerA');
  });

  it('D8 admission bounce → try next candidate', async () => {
    const transfer = vi.fn(async (_t: string, to: string) => (to === 'a' ? { ok: false, bounced: true } : { ok: true, bounced: false }));
    const { engine, audit } = makeEngine(undefined, {
      transfer,
      machines: [walled('self'), serveable('a'), serveable('b')],
    });
    await engine.handleInbound('T1', reqTg);
    expect(transfer).toHaveBeenCalledTimes(2); // bounced on a, succeeded on b
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'bounced-tried-next', to: 'a' }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'transferred', to: 'b' }));
  });

  it('all candidates bounce → honest degradation (never a dead reply)', async () => {
    const transfer = vi.fn(async () => ({ ok: false, bounced: true }));
    const { engine, emitHonest, audit } = makeEngine(undefined, {
      transfer,
      machines: [walled('self'), serveable('a'), serveable('b')],
    });
    await engine.handleInbound('T1', reqTg);
    expect(emitHonest).toHaveBeenCalledWith('T1', reqTg);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'honest-degradation', outcome: 'exhausted-degraded' }));
  });

  it('owner can serve ⇒ no transfer, no honest notice', async () => {
    const transfer = vi.fn(async () => ({ ok: true, bounced: false }));
    const { engine, emitHonest } = makeEngine(undefined, { transfer, localCanServe: true });
    const d = await engine.handleInbound('T1', reqTg);
    expect(d.action).toBe('no-action-owner-serves');
    expect(transfer).not.toHaveBeenCalled();
    expect(emitHonest).not.toHaveBeenCalled();
  });

  it('whole-pool-walled ⇒ honest degradation directly (no transfer attempted)', async () => {
    const transfer = vi.fn(async () => ({ ok: true, bounced: false }));
    const { engine, emitHonest } = makeEngine(undefined, {
      transfer,
      machines: [walled('self'), walled('peerA')],
    });
    const d = await engine.handleInbound('T1', reqTg);
    expect(d.action).toBe('honest-degradation');
    expect(transfer).not.toHaveBeenCalled();
    expect(emitHonest).toHaveBeenCalled();
  });
});
