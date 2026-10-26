/**
 * machineLiveness (trustworthy-machine-load-and-mesh-floor spec, Part A) — the
 * derived display state and its precedence. Both sides of every boundary.
 */
import { describe, expect, it } from 'vitest';
import {
  appendAttempt,
  classifyPullFailure,
  deriveLiveness,
  formatAge,
  formatLivenessLine,
  ATTEMPT_WINDOW_MS,
  MAX_ATTEMPTS,
  type DirectAttempt,
} from '../../src/core/machineLiveness.js';

const NOW = 1_800_000_000_000;
const THRESH = 15 * 60_000;
const base = { isSelf: false, nowMs: NOW, failoverThresholdMs: THRESH, attempts: [] as DirectAttempt[] };

describe('deriveLiveness precedence (A2)', () => {
  it('self is always live from this machine', () => {
    const l = deriveLiveness({ ...base, isSelf: true });
    expect(l).toMatchObject({ state: 'live', source: 'self', evidenceAgeMs: 0 });
  });

  it('a direct success inside the threshold is live with its age', () => {
    const l = deriveLiveness({ ...base, lastDirectSuccessAtMs: NOW - 30_000 });
    expect(l).toMatchObject({ state: 'live', source: 'direct', evidenceAgeMs: 30_000 });
  });

  it('a direct success AT the threshold is no longer live (boundary)', () => {
    const l = deriveLiveness({ ...base, lastDirectSuccessAtMs: NOW - THRESH });
    expect(l.state).not.toBe('live');
  });

  it('no evidence at all is unknown — never offline', () => {
    const l = deriveLiveness(base);
    expect(l).toEqual({ state: 'unknown', evidenceAgeMs: null, evidenceAt: null, source: 'none' });
    expect(formatLivenessLine(l)).toContain('unknown');
    expect(formatLivenessLine(l)).not.toMatch(/offline/i);
  });

  it('only a relayed (git) beat is stale, with its ORIGINAL age', () => {
    const l = deriveLiveness({ ...base, relayedOriginAtMs: NOW - 50 * 60_000 });
    expect(l).toMatchObject({ state: 'stale', source: 'relayed', evidenceAgeMs: 50 * 60_000 });
  });

  it('only a saved direct record (after a restart) is stale from the saved source', () => {
    const l = deriveLiveness({ ...base, savedDirectAtMs: NOW - 3 * 60_000 });
    expect(l).toMatchObject({ state: 'stale', source: 'saved', evidenceAgeMs: 3 * 60_000 });
    expect(formatLivenessLine(l)).toBe('stale, last evidence 3 min ago from a saved record of a direct check');
  });

  it('stale picks the FRESHEST of saved and relayed, never merging them', () => {
    const l = deriveLiveness({ ...base, savedDirectAtMs: NOW - 10 * 60_000, relayedOriginAtMs: NOW - 2 * 60_000 });
    expect(l).toMatchObject({ state: 'stale', source: 'relayed', evidenceAgeMs: 2 * 60_000 });
  });

  it('failures interleaved with successes in the window read unreachable (struggling)', () => {
    const attempts: DirectAttempt[] = [
      { atMs: NOW - 14 * 60_000, ok: true },
      { atMs: NOW - 10 * 60_000, ok: false, shape: 'timeout' },
      { atMs: NOW - 8 * 60_000, ok: true },
      { atMs: NOW - 2 * 60_000, ok: false, shape: 'partial' },
    ];
    const l = deriveLiveness({ ...base, attempts, lastDirectSuccessAtMs: NOW - THRESH - 1 });
    expect(l).toMatchObject({ state: 'unreachable', shape: 'struggling', lastFailure: 'partial', source: 'direct' });
    expect(formatLivenessLine(l)).toMatch(/^unreachable \(struggling\), last evidence 15 min ago from a direct check/);
  });

  it('resets / refusals read unreachable (refusing); no route reads silent', () => {
    const refusing = deriveLiveness({ ...base, attempts: [{ atMs: NOW - 1000, ok: false, shape: 'refused' }] });
    expect(refusing).toMatchObject({ state: 'unreachable', shape: 'refusing', evidenceAgeMs: null, source: 'none' });
    const silent = deriveLiveness({ ...base, attempts: [{ atMs: NOW - 1000, ok: false, shape: 'no-route' }] });
    expect(silent).toMatchObject({ state: 'unreachable', shape: 'silent' });
    expect(formatLivenessLine(refusing)).toBe('unreachable (refusing), no successful contact on record');
  });

  it('a failure OLDER than the last success does not make a live machine unreachable', () => {
    const l = deriveLiveness({
      ...base,
      attempts: [{ atMs: NOW - 60_000, ok: false, shape: 'timeout' }, { atMs: NOW - 10_000, ok: true }],
      lastDirectSuccessAtMs: NOW - 10_000,
    });
    expect(l.state).toBe('live');
  });

  it('an unreachable machine still reports the age of its last REAL contact (saved beats relayed)', () => {
    const l = deriveLiveness({
      ...base,
      attempts: [{ atMs: NOW - 1000, ok: false, shape: 'reset' }],
      savedDirectAtMs: NOW - 40 * 60_000,
      relayedOriginAtMs: NOW - 5 * 60_000,
    });
    expect(l).toMatchObject({ state: 'unreachable', source: 'saved', evidenceAgeMs: 40 * 60_000 });
  });

  it('a peer sighting is attached for display and NEVER changes the state', () => {
    const l = deriveLiveness({
      ...base,
      peerSighting: { observerMachineId: 'm_mini', ageMs: 60_000, receivedAtMs: NOW - 120_000 },
    });
    expect(l.state).toBe('unknown');
    expect(l.peerSighting).toEqual({ observerMachineId: 'm_mini', ageMs: 180_000 });
    expect(formatLivenessLine(l, (id) => (id === 'm_mini' ? 'Mac Mini' : id))).toBe('unknown — no evidence yet; Mac Mini reached it 3 min ago');
  });
});

describe('classifyPullFailure', () => {
  it('maps abort/timeout, reset, refused and no-route; null (bad answer) is partial; unknown is timeout', () => {
    expect(classifyPullFailure(null)).toBe('partial');
    expect(classifyPullFailure(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('timeout');
    expect(classifyPullFailure({ code: 'ECONNRESET' })).toBe('reset');
    expect(classifyPullFailure({ cause: { code: 'ECONNREFUSED' } })).toBe('refused');
    expect(classifyPullFailure({ code: 'EHOSTUNREACH' })).toBe('no-route');
    expect(classifyPullFailure(new Error('weird'))).toBe('timeout');
  });
});

describe('appendAttempt bounds', () => {
  it('drops attempts outside the window and caps the list', () => {
    let list: DirectAttempt[] = [{ atMs: NOW - ATTEMPT_WINDOW_MS - 1, ok: true }];
    for (let i = 0; i < MAX_ATTEMPTS + 5; i++) list = appendAttempt(list, { atMs: NOW - i, ok: true }, NOW);
    expect(list.length).toBe(MAX_ATTEMPTS);
    expect(list.every((a) => NOW - a.atMs <= ATTEMPT_WINDOW_MS)).toBe(true);
  });
});

describe('formatAge', () => {
  it('never fabricates a value', () => {
    expect(formatAge(null)).toBe('unknown');
    expect(formatAge(Number.NaN)).toBe('unknown');
    expect(formatAge(45_000)).toBe('45 s');
    expect(formatAge(3 * 3600_000)).toBe('3 h');
    expect(formatAge(3 * 24 * 3600_000)).toBe('3 d');
  });
});
