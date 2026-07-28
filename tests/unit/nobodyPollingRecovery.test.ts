import { describe, it, expect } from 'vitest';
import {
  electPollClaimant,
  decideNobodyPollingClaim,
  decidePostCasSelfReverify,
  NobodyPollingLedger,
  type PollClaimMachine,
  type NobodyPollingClaimInput,
} from '../../src/core/nobodyPollingRecovery.js';

const MS = (ids: Array<[string, boolean]>): PollClaimMachine[] =>
  ids.map(([machineId, fit]) => ({ machineId, fit }));

function baseInput(over: Partial<NobodyPollingClaimInput>): NobodyPollingClaimInput {
  return {
    selfMachineId: 'm_self',
    pollerVerdict: 'silence',
    silenceConfirmed: true,
    preferredAwakeMachineId: null,
    machines: MS([['m_self', true]]),
    globalOutageEvidence: false,
    ...over,
  };
}

describe('electPollClaimant — deterministic single-claimant election', () => {
  it('preferred-awake machine wins when it is fit', () => {
    expect(electPollClaimant('m_b', MS([['m_a', true], ['m_b', true]]))).toBe('m_b');
  });
  it('preferred-awake UNFIT → lowest-machineId fit machine', () => {
    expect(electPollClaimant('m_b', MS([['m_c', true], ['m_a', true], ['m_b', false]]))).toBe('m_a');
  });
  it('no preferred → lowest-machineId fit machine', () => {
    expect(electPollClaimant(null, MS([['m_z', true], ['m_a', true]]))).toBe('m_a');
  });
  it('no fit machine → null (nobody can claim)', () => {
    expect(electPollClaimant('m_b', MS([['m_a', false], ['m_b', false]]))).toBeNull();
  });
  it('every machine running it elects the SAME claimant (no split-brain)', () => {
    const machines = MS([['m_c', true], ['m_a', true], ['m_b', true]]);
    const fromA = electPollClaimant(null, machines);
    const fromB = electPollClaimant(null, machines);
    expect(fromA).toBe(fromB);
    expect(fromA).toBe('m_a');
  });
});

describe('decideNobodyPollingClaim — verdict reduction + claim gating', () => {
  it('ok → no-op (one poller, nothing to do)', () => {
    const d = decideNobodyPollingClaim(baseInput({ pollerVerdict: 'ok' }));
    expect(d.action).toBe('no-op');
    expect(d.selfClaims).toBe(false);
  });
  it('dual → veto (claiming into 2 pollers IS the 409 war)', () => {
    const d = decideNobodyPollingClaim(baseInput({ pollerVerdict: 'dual' }));
    expect(d.action).toBe('veto-dual');
    expect(d.selfClaims).toBe(false);
  });
  it('indeterminate → fail-closed (never claim on a visibility gap)', () => {
    const d = decideNobodyPollingClaim(baseInput({ pollerVerdict: 'indeterminate' }));
    expect(d.action).toBe('fail-closed');
    expect(d.selfClaims).toBe(false);
  });
  it('silence not yet confirmed → await-confirm (a handoff gap must not trip)', () => {
    const d = decideNobodyPollingClaim(baseInput({ pollerVerdict: 'silence', silenceConfirmed: false }));
    expect(d.action).toBe('await-confirm');
    expect(d.selfClaims).toBe(false);
  });
  it('confirmed silence + peer-confirmed GLOBAL outage → hold-global (do not claim)', () => {
    const d = decideNobodyPollingClaim(baseInput({ globalOutageEvidence: true }));
    expect(d.action).toBe('hold-global');
    expect(d.selfClaims).toBe(false);
  });
  it('confirmed silence + self IS the elected claimant → claim', () => {
    const d = decideNobodyPollingClaim(baseInput({
      selfMachineId: 'm_self',
      machines: MS([['m_self', true], ['m_z', true]]),
    }));
    expect(d.action).toBe('claim');
    expect(d.selfClaims).toBe(true);
    expect(d.claimant).toBe('m_self');
  });
  it('confirmed silence + ANOTHER machine is claimant → stand-down', () => {
    const d = decideNobodyPollingClaim(baseInput({
      selfMachineId: 'm_self',
      machines: MS([['m_a', true], ['m_self', true]]),
    }));
    expect(d.action).toBe('stand-down');
    expect(d.selfClaims).toBe(false);
    expect(d.claimant).toBe('m_a'); // lowest-id fit, not self
  });
  it('confirmed silence + preferred-awake is self and fit → claim (preferred path)', () => {
    const d = decideNobodyPollingClaim(baseInput({
      selfMachineId: 'm_self',
      preferredAwakeMachineId: 'm_self',
      machines: MS([['m_a', true], ['m_self', true]]),
    }));
    expect(d.action).toBe('claim');
    expect(d.reason).toBe('preferred-awake-fit');
  });
  it('confirmed silence + NO fit machine → escalate-no-fit (signal-only)', () => {
    const d = decideNobodyPollingClaim(baseInput({
      selfMachineId: 'm_self',
      machines: MS([['m_self', false], ['m_a', false]]),
    }));
    expect(d.action).toBe('escalate-no-fit');
    expect(d.selfClaims).toBe(false);
    expect(d.claimant).toBeNull();
  });
});

describe('decidePostCasSelfReverify — CAS-win is necessary but not sufficient', () => {
  it('locally poll-fresh after CAS → serve', () => {
    const d = decidePostCasSelfReverify({ localPollSucceededFresh: true });
    expect(d.commit).toBe(true);
    expect(d.action).toBe('serve');
  });
  it('locally STALE after CAS → relinquish + self-exclude (no false serve)', () => {
    const d = decidePostCasSelfReverify({ localPollSucceededFresh: false });
    expect(d.commit).toBe(false);
    expect(d.action).toBe('relinquish-self-exclude');
  });
});

describe('NobodyPollingLedger — evaluable soak evidence', () => {
  const t = '2026-06-28T00:00:00.000Z';
  it('counts each decision class; no-op / await-confirm are non-events', () => {
    const led = new NobodyPollingLedger();
    led.recordClaim({ action: 'claim', claimant: 'm_self', selfClaims: true, reason: 'x' }, t);
    led.recordClaim({ action: 'stand-down', claimant: 'm_a', selfClaims: false, reason: 'x' }, t);
    led.recordClaim({ action: 'veto-dual', claimant: null, selfClaims: false, reason: 'x' }, t);
    led.recordClaim({ action: 'fail-closed', claimant: null, selfClaims: false, reason: 'x' }, t);
    led.recordClaim({ action: 'hold-global', claimant: null, selfClaims: false, reason: 'x' }, t);
    led.recordClaim({ action: 'escalate-no-fit', claimant: null, selfClaims: false, reason: 'x' }, t);
    led.recordClaim({ action: 'no-op', claimant: null, selfClaims: false, reason: 'x' }, t);
    led.recordClaim({ action: 'await-confirm', claimant: null, selfClaims: false, reason: 'x' }, t);
    const s = led.summary();
    expect(s.claimsWonBySelf).toBe(1);
    expect(s.standDowns).toBe(1);
    expect(s.vetoesDual).toBe(1);
    expect(s.failClosed).toBe(1);
    expect(s.holdGlobal).toBe(1);
    expect(s.escalationsNoFit).toBe(1);
  });
  it('episodes + self-exclusions tracked', () => {
    const led = new NobodyPollingLedger();
    led.recordEpisode(t);
    led.recordSelfExclusion(t);
    const s = led.summary();
    expect(s.episodes).toBe(1);
    expect(s.selfExclusions).toBe(1);
    expect(s.firstAt).toBe(t);
  });
});
