/**
 * B1 (multimachine-lease-poll-robustness, Decisions 4/5/7) — poll-ownership
 * decision truth table. Proves: STOP-immediate on lease loss, START-guarded
 * (never a 2nd poller), debounce vs failover, stale-intent → hold (no surprise
 * silence / no blind start), and the operator override floor.
 */

import { describe, it, expect } from 'vitest';
import { decidePollAction, type PollDecisionInputs } from '../../src/lifeline/pollDecision.js';

const base: PollDecisionInputs = {
  currentlyPolling: false,
  intentShouldPoll: true,
  override: null,
  anotherMachinePolling: false,
  recentLocal409: false,
  startDebounceElapsed: false,
  peerPresumedGone: false,
};
const d = (o: Partial<PollDecisionInputs>) => decidePollAction({ ...base, ...o });

describe('B1 decidePollAction — poll-ownership follows the lease', () => {
  it('STOP is immediate when the lease is lost while polling', () => {
    expect(d({ currentlyPolling: true, intentShouldPoll: false })).toBe('stop');
  });
  it('standby + not polling → hold (nothing to do)', () => {
    expect(d({ currentlyPolling: false, intentShouldPoll: false })).toBe('hold');
  });

  it('awake + already polling → hold (we are the poller)', () => {
    expect(d({ currentlyPolling: true, intentShouldPoll: true })).toBe('hold');
  });

  it('awake + not polling + another machine IS polling → hold (never a 2nd poller)', () => {
    expect(d({ anotherMachinePolling: true })).toBe('hold');
  });
  it('awake + not polling + a recent 409 → hold (someone else is polling the token)', () => {
    expect(d({ recentLocal409: true })).toBe('hold');
  });

  it('awake + not polling + genuine failover (peer gone) → start IMMEDIATELY (skip debounce)', () => {
    expect(d({ peerPresumedGone: true, startDebounceElapsed: false })).toBe('start');
  });
  it('awake + not polling + NOT failover + debounce NOT elapsed → hold (ride out a flap)', () => {
    expect(d({ peerPresumedGone: false, startDebounceElapsed: false })).toBe('hold');
  });
  it('awake + not polling + debounce elapsed (stably awake) → start', () => {
    expect(d({ startDebounceElapsed: true })).toBe('start');
  });

  it('STALE/corrupt/missing intent (null) → HOLD current — never surprise-stop, never start blind', () => {
    expect(d({ currentlyPolling: true, intentShouldPoll: null })).toBe('hold'); // keep polling
    expect(d({ currentlyPolling: false, intentShouldPoll: null })).toBe('hold'); // don't start blind
  });

  it('operator force-mute wins over an awake lease (Phase-0 pin survives)', () => {
    expect(d({ override: 'force-mute', intentShouldPoll: true, currentlyPolling: true })).toBe('stop');
    expect(d({ override: 'force-mute', intentShouldPoll: true, currentlyPolling: false })).toBe('hold');
  });
  it('operator force-poll wins over a standby lease (operator floor)', () => {
    expect(d({ override: 'force-poll', intentShouldPoll: false, currentlyPolling: false })).toBe('start');
    expect(d({ override: 'force-poll', intentShouldPoll: false, currentlyPolling: true })).toBe('hold');
  });

  it('safety: a failover does NOT override the no-2nd-poller gate (another poller present → still hold)', () => {
    // Even on a "failover" signal, if a peer is observably still polling OR a 409
    // says one is, we must NOT start a competing poller.
    expect(d({ peerPresumedGone: true, anotherMachinePolling: true })).toBe('hold');
    expect(d({ peerPresumedGone: true, recentLocal409: true })).toBe('hold');
  });
});
