/**
 * WS3 one-voice gate (MULTI-MACHINE-SEAMLESSNESS-SPEC): SpeakerElection.
 *
 * The exactly-one-speaks invariant, both directions (spec test plan):
 *   ≤1 — a non-owner machine never speaks for an owned topic.
 *   ≥1 — "unknown owner" never produces pool-wide silence; the lease-holder
 *        (or the deterministic lowest-online-id tiebreak) always speaks —
 *        including under a flapping lease (bounded defer, then tiebreak).
 *
 * The invariant tests simulate EVERY machine in the pool running its own
 * election instance over the same replicated inputs and assert the speak-set
 * size is exactly 1 (or exactly the legacy/no-op expectations).
 */
import { describe, it, expect } from 'vitest';
import { SpeakerElection, type SpeakerElectionDeps } from '../../src/monitoring/SpeakerElection.js';

function pool(machines: string[], opts: {
  enabled?: boolean;
  owner?: string | null;
  leaseHolder?: string | null;
  leaseStable?: boolean;
  dwellMs?: number;
  now?: () => number;
} = {}) {
  return machines.map((self) => new SpeakerElection({
    enabled: () => opts.enabled ?? true,
    currentMachineId: self,
    poolMachineIds: () => machines,
    resolveTopicOwner: () => opts.owner ?? null,
    leaseHolderId: () => opts.leaseHolder ?? null,
    leaseStable: () => opts.leaseStable ?? true,
    dwellMs: opts.dwellMs ?? 60_000,
    now: opts.now,
  } satisfies SpeakerElectionDeps));
}

function speakSet(elections: SpeakerElection[], topicId = 7, stamped?: string | null) {
  return elections.map(e => e.decide(topicId, stamped)).filter(v => v.speak).length;
}

describe('SpeakerElection — exactly-one-speaks invariant', () => {
  it('owner known: exactly the owner speaks (≤1 and ≥1)', () => {
    const es = pool(['m_a', 'm_b', 'm_c'], { owner: 'm_b', leaseHolder: 'm_a' });
    const verdicts = es.map(e => e.decide(7));
    expect(verdicts.filter(v => v.speak).length).toBe(1);
    expect(verdicts[1].speak).toBe(true);
    expect(verdicts[1].reason).toBe('owner-self');
    expect(verdicts[0].reason).toBe('owner-other');
  });

  it('owner unknown, stable lease: exactly the lease-holder speaks', () => {
    const es = pool(['m_a', 'm_b'], { owner: null, leaseHolder: 'm_b' });
    const verdicts = es.map(e => e.decide(7));
    expect(verdicts.filter(v => v.speak).length).toBe(1);
    expect(verdicts[1].reason).toBe('lease-holder-fallback');
  });

  it('owner unknown, NO lease-holder: deterministic lowest-id tiebreak keeps ≥1 (never pool-wide silence)', () => {
    const es = pool(['m_b', 'm_a', 'm_c'], { owner: null, leaseHolder: null });
    expect(speakSet(es)).toBe(1);
    const a = es[1].decide(8);
    expect(a.speak).toBe(true);
    expect(a.reason).toBe('tiebreak-lowest-id');
  });

  it('owner unknown, lease-holder is OFFLINE (not in pool): tiebreak speaks instead of silence', () => {
    const es = pool(['m_a', 'm_b'], { owner: null, leaseHolder: 'm_dark' });
    expect(speakSet(es, 9)).toBe(1);
  });

  it('durable stamp fallback: the stamped owner speaks when live placement is empty', () => {
    const es = pool(['m_a', 'm_b'], { owner: null, leaseHolder: 'm_a' });
    const verdicts = es.map(e => e.decide(7, 'm_b'));
    expect(verdicts.filter(v => v.speak).length).toBe(1);
    expect(verdicts[1].reason).toBe('owner-stamp-self');
  });

  it('live placement BEATS a stale stamp (re-resolution at speak time)', () => {
    const es = pool(['m_a', 'm_b'], { owner: 'm_a', leaseHolder: 'm_b' });
    const verdicts = es.map(e => e.decide(7, 'm_b'));
    expect(verdicts[0].speak).toBe(true);
    expect(verdicts[0].reason).toBe('owner-self');
    expect(verdicts[1].speak).toBe(false);
  });
});

describe('SpeakerElection — lease-stability dwell', () => {
  it('flapping lease: defers (bounded) instead of deciding on a transient read', () => {
    let t = 1_000_000;
    const es = pool(['m_a', 'm_b'], { owner: null, leaseHolder: 'm_a', leaseStable: false, dwellMs: 10_000, now: () => t });
    const first = es[0].decide(7);
    expect(first.defer).toBe(true);
    expect(first.speak).toBe(false);
    expect(first.reason).toBe('lease-unstable-defer');
  });

  it('instability outliving the dwell bound falls to the tiebreak — fail toward speech, never unbounded silence', () => {
    let t = 1_000_000;
    const machines = ['m_a', 'm_b'];
    const es = pool(machines, { owner: null, leaseHolder: null, leaseStable: false, dwellMs: 10_000, now: () => t });
    es.forEach(e => e.decide(7)); // start the instability clocks
    t += 10_001;
    const verdicts = es.map(e => e.decide(7));
    expect(verdicts.filter(v => v.speak).length).toBe(1);
    expect(verdicts[0].reason).toBe('tiebreak-lowest-id');
  });

  it('a decisive verdict is HELD for the dwell window — a mid-flap owner flip cannot alternate the voice', () => {
    let t = 1_000_000;
    let owner: string | null = 'm_a';
    const e = new SpeakerElection({
      enabled: () => true,
      currentMachineId: 'm_a',
      poolMachineIds: () => ['m_a', 'm_b'],
      resolveTopicOwner: () => owner,
      leaseHolderId: () => 'm_b',
      leaseStable: () => true,
      dwellMs: 10_000,
      now: () => t,
    });
    expect(e.decide(7).speak).toBe(true);
    owner = 'm_b'; // flap within the dwell window
    t += 5_000;
    const held = e.decide(7);
    expect(held.speak).toBe(true); // identity held
    expect(held.reason).toBe('dwell-hold');
    t += 6_000; // dwell expired → re-elect on current state
    expect(e.decide(7).speak).toBe(false);
  });
});

describe('SpeakerElection — legacy / no-op guards (spec invariant 6)', () => {
  it('flag off: every machine speaks (exact legacy behavior, election machinery not entered)', () => {
    const es = pool(['m_a', 'm_b'], { enabled: false, owner: 'm_b' });
    const verdicts = es.map(e => e.decide(7));
    expect(verdicts.every(v => v.speak && v.reason === 'legacy-disabled')).toBe(true);
  });

  it('no machine id: speaks (legacy)', () => {
    const e = new SpeakerElection({
      enabled: () => true,
      poolMachineIds: () => ['m_a', 'm_b'],
      resolveTopicOwner: () => 'm_b',
      leaseHolderId: () => 'm_a',
      leaseStable: () => true,
    });
    expect(e.decide(7)).toMatchObject({ speak: true, reason: 'legacy-no-machine-id' });
  });

  it('single-machine pool: speaks, strict no-op', () => {
    const es = pool(['m_a'], { owner: null, leaseHolder: null });
    expect(es[0].decide(7)).toMatchObject({ speak: true, reason: 'single-machine' });
  });

  it('observability hook reports every verdict and can never gate (throwing hook is swallowed)', () => {
    const seen: string[] = [];
    const e = new SpeakerElection({
      enabled: () => true,
      currentMachineId: 'm_a',
      poolMachineIds: () => ['m_a', 'm_b'],
      resolveTopicOwner: () => 'm_a',
      leaseHolderId: () => 'm_a',
      leaseStable: () => true,
      onVerdict: (_t, v) => { seen.push(v.reason); throw new Error('boom'); },
    });
    expect(e.decide(7).speak).toBe(true);
    expect(seen).toEqual(['owner-self']);
  });
});
