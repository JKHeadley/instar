// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1: the practice record's file and the asking rate (docs/specs/local-verify-borrowed-slices-count.md, F
 * "The practice record", "Asking the helper", "Verifies that hold nothing back"):
 *  - a lost or unreadable file, a file of the first design (version 1) and a lane that does not read
 *    strictly all mean practice from the start;
 *  - one status request per verify; after 10 unanswered in a row only every 5th verify; after 7 days
 *    without an answer not at all until the helper announces itself;
 *  - one verify in ten is compare-only, drawn before the helper is asked.
 * This replaces the first design's breaker tests (the back-off of up to 8 hours is gone).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { ASK_LIMITS, askDecision, borrowedFilesDigest, drawAssignment, freshAsk, noteAsked, noteHere, noteSkipped, parseAsk, type AskState } from '../../../src/localVerify/borrowedAsk.js';
import { applyVerifyOutcome, freshLane, recordDryRun } from '../../../src/localVerify/borrowedPractice.js';
import { BorrowedPracticeStore, freshHelper, measuredThroughput, parseHelperState } from '../../../src/localVerify/borrowedState.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'borrowedState.test.ts' }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvstate-'))); dirs.push(d); return d; };
const DAY = 24 * 60 * 60_000;
const T0 = Date.parse('2026-11-19T08:00:00.000Z');

describe('asking the helper', () => {
  /** Run `n` verifies against a silent helper; returns which of them asked. */
  function silent(n: number, start: AskState = freshAsk(), now = T0): { asked: boolean[]; state: AskState } {
    let s = start;
    const asked: boolean[] = [];
    for (let i = 0; i < n; i++) {
      const d = askDecision(s, now);
      asked.push(d === 'ask');
      s = d === 'ask' ? noteAsked(s, false, now) : d === 'skip' ? noteSkipped(s) : s;
    }
    return { asked, state: s };
  }

  it('asks on every verify while the helper answers, and through 9 unanswered requests', () => {
    expect(askDecision(freshAsk(), T0)).toBe('ask');
    const nine = silent(9);
    expect(nine.asked.every(Boolean)).toBe(true);
    expect(nine.state.unanswered).toBe(9);
    expect(askDecision(nine.state, T0)).toBe('ask'); // the 10th is still asked
  });

  it('after 10 unanswered in a row asks on every 5th verify only', () => {
    const r = silent(10 + 15);
    expect(r.asked.slice(0, 10).every(Boolean)).toBe(true);
    // verifies 11..25: four passed over, then one asked, three times.
    expect(r.asked.slice(10)).toEqual([false, false, false, false, true, false, false, false, false, true, false, false, false, false, true]);
    expect(r.state.unanswered).toBe(13);
  });

  it('one answer restores asking on every verify; so does the helper\'s "I am here", at once', () => {
    const slow = silent(12).state;
    expect(askDecision(slow, T0)).toBe('skip');
    expect(noteAsked(slow, true, T0)).toEqual(freshAsk());
    expect(askDecision(noteHere(), T0)).toBe('ask');
    expect(noteHere()).toEqual(freshAsk());
  });

  it('after 7 days without an answer stops asking until the helper announces itself', () => {
    const s = noteAsked(freshAsk(), false, T0); // the silence began at T0
    expect(s.silentSince).toBe(T0);
    expect(askDecision(s, T0 + ASK_LIMITS.stopAfterMs - 1)).toBe('ask');
    expect(askDecision(s, T0 + ASK_LIMITS.stopAfterMs)).toBe('stopped');
    expect(askDecision({ ...silent(14).state }, T0 + 8 * DAY)).toBe('stopped'); // also from the slowed rate
    // The silence is counted from its first unanswered request, not from the last.
    expect(noteAsked(s, false, T0 + DAY).silentSince).toBe(T0);
    expect(askDecision(noteHere(), T0 + 30 * DAY)).toBe('ask');
  });

  it('the limits are the spec\'s, and a malformed stored state reads as fresh', () => {
    expect(ASK_LIMITS).toMatchObject({ statusTimeoutMs: 2_000, slowAfterUnanswered: 10, slowEvery: 5, stopAfterMs: 7 * DAY, compareOnlyOneIn: 10 });
    expect(parseAsk({ unanswered: 3, silentSince: T0, skippedSinceAsk: 1 })).toEqual({ unanswered: 3, silentSince: T0, skippedSinceAsk: 1 });
    for (const bad of [null, 'x', { unanswered: -1, silentSince: null, skippedSinceAsk: 0 }, { unanswered: 1, silentSince: 'yesterday', skippedSinceAsk: 0 }, { unanswered: 1.5, silentSince: null, skippedSinceAsk: 0 }]) expect(parseAsk(bad)).toEqual(freshAsk());
  });
});

describe('the one-in-ten compare-only assignment and the record field\'s digest', () => {
  it('draws compare-only for exactly one of the ten values of the random source, before anything is asked', () => {
    const asked: number[] = [];
    const draws = Array.from({ length: 10 }, (_, i) => drawAssignment((n) => { asked.push(n); return i; }));
    expect(draws.filter((d) => d === 'compare-only').length).toBe(1);
    expect(draws[0]).toBe('compare-only');
    expect(draws.slice(1).every((d) => d === 'counting')).toBe(true);
    expect(asked.every((n) => n === 10)).toBe(true);
    // The default source is cryptographic and in range.
    for (let i = 0; i < 50; i++) expect(['counting', 'compare-only']).toContain(drawAssignment());
  });

  it('the files digest is 64 hex characters, order-independent, ignores duplicates and differs for different lists', () => {
    const a = borrowedFilesDigest(['tests/integration/b.test.ts', 'tests/integration/a.test.ts']);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(borrowedFilesDigest(['tests/integration/a.test.ts', 'tests/integration/b.test.ts', 'tests/integration/a.test.ts'])).toBe(a);
    expect(borrowedFilesDigest(['tests/integration/a.test.ts'])).not.toBe(a);
    expect(borrowedFilesDigest([])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('BorrowedPracticeStore', () => {
  const file = (dir: string) => path.join(dir, 'state', 'local-verify', 'borrowed-helpers.json');

  it('keeps each helper\'s lanes, asking state, spot rate, dry-run request, events and told ids across a restart', () => {
    const dir = tmp();
    const s = new BorrowedPracticeStore(dir);
    expect(s.loadedFresh).toBe('absent');
    const lane = recordDryRun(s.lane('m_laptop', 'integration', T0), { eligible: ['tests/integration/a.test.ts'], compared: [], eligibleDigest: 'a'.repeat(64) }, T0);
    s.setLane('m_laptop', 'integration', lane);
    const h = s.get('m_laptop');
    h.ask = noteAsked(h.ask, false, T0);
    h.spot = { raisedVerifiesLeft: 7 };
    h.dryRunIntent = { requestedAt: T0, lanes: ['integration'], by: 'echo', state: 'requested' };
    for (let i = 0; i < 60; i++) s.addRun('m_laptop', { at: i, counted: true, slicesSent: 1, done: 1, agree: 1, disagree: 0, helperMs: 1, localMs: 1, prepMs: 1, vitestStartMs: 1 });
    s.addEvent({ id: 'e'.repeat(32), at: T0, runMachineId: 'm_studio', helper: 'm_laptop', lane: 'integration', kind: 'suspended' });
    s.markTold(['e'.repeat(32)]);
    s.save();
    const again = new BorrowedPracticeStore(dir);
    expect(again.loadedFresh).toBeNull();
    expect(again.peekLane('m_laptop', 'integration')).toEqual(lane);
    expect(again.peekLane('m_laptop', 'unit')).toBeNull(); // never creates
    expect(again.get('m_laptop')).toMatchObject({ ask: { unanswered: 1, silentSince: T0 }, spot: { raisedVerifiesLeft: 7 }, dryRunIntent: { lanes: ['integration'], state: 'requested' } });
    expect(again.get('m_laptop').runs.length).toBe(50);
    expect(again.events().map((e) => e.kind)).toEqual(['suspended']);
    expect([...again.told()]).toEqual(['e'.repeat(32)]);
    expect(again.helperIds()).toEqual(['m_laptop']);
  });

  it('a lost file, an unreadable file and a file of the first design all mean practice from the start', () => {
    const dir = tmp();
    fs.mkdirSync(path.dirname(file(dir)), { recursive: true });
    fs.writeFileSync(file(dir), '{not json');
    const unreadable = new BorrowedPracticeStore(dir);
    expect(unreadable.loadedFresh).toBe('unreadable');
    expect(unreadable.get('m_laptop')).toEqual(freshHelper());
    // Version 1 (the first design's breaker file): not read, whatever it holds.
    fs.writeFileSync(file(dir), JSON.stringify({ v: 1, helpers: { m_laptop: { breaker: { consecutiveBad: 2 }, runs: [], lanes: { unit: { state: 'counting' } } } } }));
    const v1 = new BorrowedPracticeStore(dir);
    expect(v1.loadedFresh).toBe('version');
    expect(v1.helperIds()).toEqual([]);
    expect(v1.lane('m_laptop', 'unit', T0)).toEqual(freshLane(T0));
    // Saving writes version 2.
    v1.save();
    expect(JSON.parse(fs.readFileSync(file(dir), 'utf-8'))).toMatchObject({ v: 2 });
  });

  it('a lane that does not read strictly is dropped alone: that lane starts practice again, the others stay', () => {
    const good = applyVerifyOutcome(freshLane(T0), { verifyId: 'v', kind: 'waiting', change: '1', compareOnly: false, assigned: 'counting', sent: 1, finished: 1, agreed: ['tests/unit/a.test.ts'], digestDiffersBothPass: [], helperFailedLocalPassed: [], confirmedWrongPasses: [], failingAgreed: [], environmentDifferences: 0, check: 'right', answers: ['valid'] }, T0).lane;
    const h = parseHelperState({ ask: { unanswered: 2, silentSince: T0, skippedSinceAsk: 0 }, lanes: { unit: good, integration: { ...good, state: 'counting' }, e2e: 'counting', other: good } });
    expect(Object.keys(h.lanes)).toEqual(['unit']); // `counting` without a decision, a string, and an unknown lane name are all dropped
    expect(h.lanes.unit).toEqual(good);
    expect(h.ask.unanswered).toBe(2);
    expect(parseHelperState('nonsense')).toEqual(freshHelper());
  });

  it('measured throughput needs 5 counted runs', () => {
    const run = (counted: boolean) => ({ at: 0, counted, slicesSent: 1, done: 1, agree: 1, disagree: 0, helperMs: 1000, localMs: 2000, prepMs: 1, vitestStartMs: 1 });
    expect(measuredThroughput([run(true), run(true), run(true), run(true), run(false)])).toBeNull();
    expect(measuredThroughput([run(true), run(true), run(true), run(true), run(true)])).toBe(2);
  });
});
