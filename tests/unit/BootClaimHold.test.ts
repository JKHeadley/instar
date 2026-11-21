/**
 * takeover-ready-pool R1 — the pure boot-hold rules, both sides of every boundary:
 * three probes vs two, a 45 s span vs 44.999 s, the unsigned-answer window (interim and
 * budget-derived, floor and ceiling), preferred vs no preferred, the tunnel edge, and the switch.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyPeer,
  effectiveAnswer,
  endpointCarriesUnsignedAnswer,
  evaluateBootHold,
  INTERIM_UNSIGNED_ANSWER_WINDOW_MS,
  isTunnelEdgeStatus,
  resolveBootClaimSafety,
  unsignedAnswerWindowMs,
  DEFAULT_BOOT_HOLD_SETTINGS as S,
  type PeerProbeRecord,
  type ProbeAnswer,
} from '../../src/core/BootClaimHold.js';

function rec(...probes: Array<[number, ProbeAnswer]>): PeerProbeRecord {
  let unsignedSinceMs: number | null = null;
  let firstSignedAtMs: number | null = null;
  for (const [at, a] of probes) {
    if (a === 'signed') { unsignedSinceMs = null; if (firstSignedAtMs === null) firstSignedAtMs = at; }
    else if (a === 'unsigned' && unsignedSinceMs === null) unsignedSinceMs = at;
  }
  return { probes: probes.map(([atMs, answer]) => ({ atMs, answer })), unsignedSinceMs, firstSignedAtMs };
}
const W = INTERIM_UNSIGNED_ANSWER_WINDOW_MS;

describe('unsigned-answer window', () => {
  it('is 45 s + 3 min until a restart time is published', () => {
    expect(W).toBe(225_000);
    expect(unsignedAnswerWindowMs(null)).toBe(225_000);
    expect(unsignedAnswerWindowMs(undefined)).toBe(225_000);
    expect(unsignedAnswerWindowMs(Number.NaN)).toBe(225_000);
    expect(unsignedAnswerWindowMs(-1)).toBe(225_000);
  });
  it('is the restart time plus 60 s, floored at 45 s and capped at 10 minutes', () => {
    expect(unsignedAnswerWindowMs(0)).toBe(60_000);
    expect(unsignedAnswerWindowMs(120_000)).toBe(180_000);
    expect(unsignedAnswerWindowMs(540_000)).toBe(600_000);
    expect(unsignedAnswerWindowMs(540_001)).toBe(600_000);
    expect(unsignedAnswerWindowMs(10 * 60_000)).toBe(600_000);
  });
  it('an unsigned answer at the window edge still counts; one past it is silence', () => {
    expect(effectiveAnswer({ atMs: 1000 + W, answer: 'unsigned' }, 1000, W)).toBe('unsigned');
    expect(effectiveAnswer({ atMs: 1001 + W, answer: 'unsigned' }, 1000, W)).toBe('silent');
    expect(effectiveAnswer({ atMs: 1001 + W, answer: 'signed' }, 1000, W)).toBe('signed');
  });
});

describe('classifyPeer — the three-probe / 45-second test', () => {
  it('unprobed until the first probe', () => {
    expect(classifyPeer(undefined, W, S)).toBe('unprobed');
    expect(classifyPeer({ probes: [], unsignedSinceMs: null }, W, S)).toBe('unprobed');
  });
  it('three silent probes spanning exactly 45 s is enough', () => {
    expect(classifyPeer(rec([0, 'silent'], [20_000, 'silent'], [45_000, 'silent']), W, S)).toBe('silent-enough');
  });
  it('three silent probes spanning 44.999 s is not', () => {
    expect(classifyPeer(rec([0, 'silent'], [20_000, 'silent'], [44_999, 'silent']), W, S)).toBe('silent-pending');
  });
  it('two silent probes spanning a minute is not', () => {
    expect(classifyPeer(rec([0, 'silent'], [60_000, 'silent']), W, S)).toBe('silent-pending');
  });
  it('an answer resets the silent run', () => {
    expect(classifyPeer(rec([0, 'silent'], [10_000, 'silent'], [20_000, 'signed'], [40_000, 'silent'], [60_000, 'silent'], [64_000, 'silent']), W, S)).toBe('silent-pending');
  });
  it('the last answer decides while it is an answer', () => {
    expect(classifyPeer(rec([0, 'silent'], [5_000, 'signed']), W, S)).toBe('answered-signed');
    expect(classifyPeer(rec([0, 'silent'], [5_000, 'unsigned']), W, S)).toBe('answering-unsigned');
  });
  it('a wedged peer answering errors for ever stops counting after the window, then reads silent', () => {
    const probes: Array<[number, ProbeAnswer]> = [];
    for (let t = 0; t <= W + 45_000 + 5_000; t += 5_000) probes.push([t, 'unsigned']);
    expect(classifyPeer(rec(...probes.filter(([t]) => t <= W)), W, S)).toBe('answering-unsigned');
    expect(classifyPeer(rec(...probes.filter(([t]) => t <= W + 30_000)), W, S)).toBe('silent-pending');
    expect(classifyPeer(rec(...probes), W, S)).toBe('silent-enough');
  });
  it('silence mixed into unsigned answers does not restart the window', () => {
    const probes: Array<[number, ProbeAnswer]> = [];
    for (let t = 0; t <= W + 60_000; t += 5_000) probes.push([t, (t / 5_000) % 2 === 0 ? 'unsigned' : 'silent']);
    expect(classifyPeer(rec(...probes), W, S)).toBe('silent-enough');
  });
});

describe('evaluateBootHold', () => {
  const base = { nowMs: 60_000, selfMachineId: 'laptop', windowMsFor: () => W, newerViewSeen: false };
  const silentFor = (ms: number) => rec([0, 'silent'], [ms / 2, 'silent'], [ms, 'silent']);

  it('rule 4: a live holder or newer epoch in a peer view ends it at once', () => {
    const v = evaluateBootHold({ ...base, preferredMachineId: 'studio', knownPeers: ['studio'], probes: new Map(), newerViewSeen: true });
    expect(v.hold).toBe(false);
  });
  it('no known peer: nothing to ask, the hold ends (a single machine is unchanged)', () => {
    expect(evaluateBootHold({ ...base, preferredMachineId: null, knownPeers: [], probes: new Map() }).hold).toBe(false);
  });
  it('rule 2: a non-preferred machine that has reached no peer defers', () => {
    const v = evaluateBootHold({ ...base, preferredMachineId: 'studio', knownPeers: ['studio', 'mini'], probes: new Map() });
    expect(v).toMatchObject({ hold: true, rule: 'rule-2' });
  });
  it('rule 3: never claims while the preferred machine answers, signed or unsigned', () => {
    for (const a of ['signed', 'unsigned'] as const) {
      const v = evaluateBootHold({ ...base, preferredMachineId: 'studio', knownPeers: ['studio'], probes: new Map([['studio', rec([0, a])]]) });
      expect(v).toMatchObject({ hold: true, rule: 'rule-3' });
    }
  });
  it('a stale standby answering does not end the hold; the preferred machine is still awaited', () => {
    const v = evaluateBootHold({
      ...base, preferredMachineId: 'studio', knownPeers: ['studio', 'mini'],
      probes: new Map([['mini', rec([0, 'signed'])], ['studio', rec([0, 'silent'], [10_000, 'silent'], [20_000, 'silent'])]]),
    });
    expect(v).toMatchObject({ hold: true, rule: 'rule-4' });
  });
  it('rule 4: the preferred machine silent on three probes over 45 s ends it', () => {
    const v = evaluateBootHold({ ...base, preferredMachineId: 'studio', knownPeers: ['studio', 'mini'], probes: new Map([['studio', silentFor(45_000)], ['mini', rec([0, 'signed'])]]) });
    expect(v.hold).toBe(false);
  });
  it('… and at 44.999 s it still defers', () => {
    const v = evaluateBootHold({ ...base, preferredMachineId: 'studio', knownPeers: ['studio'], probes: new Map([['studio', silentFor(44_999)]]) });
    expect(v.hold).toBe(true);
  });
  it('with no preferred named, every known peer must answer without a live holder or stay silent long enough', () => {
    const probes = new Map([['studio', silentFor(30_000)], ['mini', rec([0, 'signed'])]]);
    expect(evaluateBootHold({ ...base, preferredMachineId: null, knownPeers: ['studio', 'mini'], probes }).hold).toBe(true);
    probes.set('studio', silentFor(45_000));
    expect(evaluateBootHold({ ...base, preferredMachineId: null, knownPeers: ['studio', 'mini'], probes }).hold).toBe(false);
  });
  it('with no preferred named, an unsigned answer inside its window keeps the hold', () => {
    const v = evaluateBootHold({ ...base, preferredMachineId: null, knownPeers: ['studio'], probes: new Map([['studio', rec([0, 'unsigned'])]]) });
    expect(v.hold).toBe(true);
  });
  it('the preferred machine itself applies the test to every known peer', () => {
    const self = { ...base, selfMachineId: 'studio', preferredMachineId: 'studio', knownPeers: ['laptop', 'mini'] };
    expect(evaluateBootHold({ ...self, probes: new Map([['laptop', rec([0, 'signed'])]]) })).toMatchObject({ hold: true, rule: 'rule-4' });
    expect(evaluateBootHold({ ...self, probes: new Map([['laptop', rec([0, 'signed'])], ['mini', rec([0, 'signed'])]]) }).hold).toBe(false);
  });
  it('a preferred machine this one cannot dial falls back to the every-peer test', () => {
    const v = evaluateBootHold({ ...base, preferredMachineId: 'gone', knownPeers: ['mini'], probes: new Map([['mini', rec([0, 'signed'])]]) });
    expect(v.hold).toBe(false);
  });
});

describe('what counts as an answer on the wire', () => {
  it('the tunnel edge (52x, 530) is never the peer', () => {
    for (const s of [520, 521, 522, 523, 524, 525, 526, 527, 528, 529, 530]) expect(isTunnelEdgeStatus(s)).toBe(true);
    for (const s of [200, 500, 502, 503, 504, 519, 531]) expect(isTunnelEdgeStatus(s)).toBe(false);
  });
  it('only Tailscale and named tunnels carry an unsigned answer', () => {
    expect(endpointCarriesUnsignedAnswer('tailscale', 'http://100.1.2.3:4042')).toBe(true);
    expect(endpointCarriesUnsignedAnswer('cloudflare', 'https://echo-studio.example.dev')).toBe(true);
    expect(endpointCarriesUnsignedAnswer('cloudflare', 'https://abc.trycloudflare.com')).toBe(false);
    expect(endpointCarriesUnsignedAnswer('lan', 'http://192.168.1.4:4042')).toBe(false);
    expect(endpointCarriesUnsignedAnswer(undefined, 'http://x')).toBe(false);
    expect(endpointCarriesUnsignedAnswer('cloudflare', 'not a url')).toBe(false);
  });
});

describe('resolveBootClaimSafety — the ladder switch', () => {
  it('live on a development agent, dark on the fleet', () => {
    expect(resolveBootClaimSafety({ developmentAgent: true }).enabled).toBe(true);
    expect(resolveBootClaimSafety({}).enabled).toBe(false);
    expect(resolveBootClaimSafety(undefined).enabled).toBe(false);
  });
  it('takeoverReadyPool.enabled:false is the rollback, even on a development agent', () => {
    expect(resolveBootClaimSafety({ developmentAgent: true, multiMachine: { takeoverReadyPool: { enabled: false, bootClaimSafety: { enabled: true } } } }).enabled).toBe(false);
  });
  it('an explicit part switch wins over the gate; the project switch is the fleet flip', () => {
    expect(resolveBootClaimSafety({ developmentAgent: true, multiMachine: { takeoverReadyPool: { bootClaimSafety: { enabled: false } } } }).enabled).toBe(false);
    expect(resolveBootClaimSafety({ multiMachine: { takeoverReadyPool: { bootClaimSafety: { enabled: true } } } }).enabled).toBe(true);
    expect(resolveBootClaimSafety({ multiMachine: { takeoverReadyPool: { enabled: true } } }).enabled).toBe(true);
  });
  it('carries the named preferred machine and valid probe values only', () => {
    const r = resolveBootClaimSafety({ developmentAgent: true, multiMachine: { leaseSelfHeal: { preferredAwakeMachineId: 'm_studio' }, takeoverReadyPool: { bootClaimSafety: { silentProbes: 4, silentSpanMs: 60_000 } } } });
    expect(r).toEqual({ enabled: true, preferredMachineId: 'm_studio', silentProbes: 4, silentSpanMs: 60_000 });
    const bad = resolveBootClaimSafety({ developmentAgent: true, multiMachine: { leaseSelfHeal: { preferredAwakeMachineId: '' }, takeoverReadyPool: { bootClaimSafety: { silentProbes: 0, silentSpanMs: -1 } } } });
    expect(bad).toEqual({ enabled: true, preferredMachineId: null });
  });
});

describe('evaluateBootHold — an answering peer that never claims cannot hold the pool for ever', () => {
  const signedAt0 = () => new Map([['studio', rec([0, 'signed'])]]);
  const limit = W + S.silentSpanMs; // the preferred machine's restart window plus the silence span
  it('the preferred machine answering signed holds others back up to its window plus the span', () => {
    const v = evaluateBootHold({ nowMs: limit, selfMachineId: 'laptop', preferredMachineId: 'studio', knownPeers: ['studio'], probes: signedAt0(), newerViewSeen: false, windowMsFor: () => W });
    expect(v).toMatchObject({ hold: true, rule: 'rule-3' });
  });
  it('… and one millisecond later it no longer does (it answers but has not claimed)', () => {
    const v = evaluateBootHold({ nowMs: limit + 1, selfMachineId: 'laptop', preferredMachineId: 'studio', knownPeers: ['studio'], probes: signedAt0(), newerViewSeen: false, windowMsFor: () => W });
    expect(v).toMatchObject({ hold: false, rule: 'rule-4' });
  });
  it('the bound follows the preferred machine\'s published restart time', () => {
    const w = unsignedAnswerWindowMs(30_000); // 90 s
    const input = { selfMachineId: 'laptop', preferredMachineId: 'studio', knownPeers: ['studio'], probes: signedAt0(), newerViewSeen: false, windowMsFor: () => w };
    expect(evaluateBootHold({ ...input, nowMs: w + S.silentSpanMs }).hold).toBe(true);
    expect(evaluateBootHold({ ...input, nowMs: w + S.silentSpanMs + 1 }).hold).toBe(false);
  });
});

describe('evaluateBootHold — no preferred named: the lower machine id claims first', () => {
  const both = () => new Map([['m_a', rec([0, 'signed'])], ['m_b', rec([0, 'signed'])]]);
  it('two machines restarting together: the higher id waits for the lower one', () => {
    const b = evaluateBootHold({ nowMs: 10_000, selfMachineId: 'm_b', preferredMachineId: null, knownPeers: ['m_a'], probes: both(), newerViewSeen: false, windowMsFor: () => W });
    expect(b.hold).toBe(true);
  });
  it('… while the lower id does not wait for the higher one', () => {
    const a = evaluateBootHold({ nowMs: 10_000, selfMachineId: 'm_a', preferredMachineId: null, knownPeers: ['m_b'], probes: both(), newerViewSeen: false, windowMsFor: () => W });
    expect(a.hold).toBe(false);
  });
  it('a lower-id peer that answers but never claims is waited for only up to its window plus the span', () => {
    const input = { selfMachineId: 'm_b', preferredMachineId: null, knownPeers: ['m_a'], probes: both(), newerViewSeen: false, windowMsFor: () => W };
    expect(evaluateBootHold({ ...input, nowMs: W + S.silentSpanMs }).hold).toBe(true);
    expect(evaluateBootHold({ ...input, nowMs: W + S.silentSpanMs + 1 }).hold).toBe(false);
  });
  it('the preferred machine itself waits for no lower id', () => {
    const v = evaluateBootHold({ nowMs: 10_000, selfMachineId: 'm_b', preferredMachineId: 'm_b', knownPeers: ['m_a'], probes: both(), newerViewSeen: false, windowMsFor: () => W });
    expect(v.hold).toBe(false);
  });
});
