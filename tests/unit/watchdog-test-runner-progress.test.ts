/**
 * The test-runner floor used to expire on wall clock alone. On 2026-10-20 a
 * healthy full suite was SIGINT-ed at 3610s: past the floor the hard ceiling
 * (default 1800s) is already exceeded, so every fail-closed path votes to
 * interrupt — the kill is arithmetic, not a judgement.
 *
 * These tests pin both halves of the fix: measured CPU progress can hold the
 * floor open, and only measured progress can (an unknown reading behaves
 * exactly as before, which is why every pre-existing floor test still passes
 * untouched).
 */
import { describe, expect, it } from 'vitest';
import {
  classifyProtectedWait,
  classifyTestRunnerProtection,
  MAX_TEST_RUNNER_ABSOLUTE_MS,
  MAX_TEST_RUNNER_PROTECTION_MS,
} from '../../src/monitoring/SessionWatchdog.js';
import {
  MIN_PROGRESS_CPU_DELTA_MS,
  MIN_PROGRESS_SAMPLE_GAP_MS,
  parseCpuTime,
  TestRunnerProgressTracker,
} from '../../src/monitoring/testRunnerProgress.js';

const PAST_FLOOR = MAX_TEST_RUNNER_PROTECTION_MS + 1;

describe('parseCpuTime', () => {
  it.each([
    ['0:00.00', 0],
    ['0:00.37', 370],
    ['12:34.56', 754_560],
    ['1:02:03', 3_723_000],
    ['2-01:02:03', 176_523_000],
    ['123:45.67', 7_425_670], // macOS lets minutes exceed 59
  ])('reads %s as %ims of CPU time', (cell, expected) => {
    expect(parseCpuTime(cell)).toBe(expected);
  });

  it.each(['', '   ', '-', '?', 'abc', '1:2:3:4', '-5:00', 'x:00'])(
    'returns undefined rather than zero for an unreadable cell: %s',
    (cell) => {
      // Load-bearing: "I could not measure it" must never be reported as
      // "it used no CPU", because the latter would end protection.
      expect(parseCpuTime(cell)).toBeUndefined();
    },
  );

  it('returns undefined for a missing cell', () => {
    expect(parseCpuTime(undefined)).toBeUndefined();
  });
});

describe('TestRunnerProgressTracker', () => {
  const GAP = MIN_PROGRESS_SAMPLE_GAP_MS;

  it('reports a baseline on the first reading — there is nothing to compare yet', () => {
    const t = new TestRunnerProgressTracker();
    expect(t.observe(100, 5_000, 1_000)).toBe('baseline');
    expect(t.size).toBe(1);
  });

  it('reports progress when the subtree burned CPU between comparable samples', () => {
    const t = new TestRunnerProgressTracker();
    t.observe(100, 5_000, 1_000);
    expect(t.observe(100, 5_000 + MIN_PROGRESS_CPU_DELTA_MS, 1_000 + GAP)).toBe('progressed');
  });

  it('reports idle when two comparable samples show essentially no CPU used', () => {
    const t = new TestRunnerProgressTracker();
    t.observe(100, 5_000, 1_000);
    expect(t.observe(100, 5_000 + MIN_PROGRESS_CPU_DELTA_MS - 1, 1_000 + GAP)).toBe('idle');
  });

  it('keeps the older baseline when samples arrive too close together', () => {
    const t = new TestRunnerProgressTracker();
    t.observe(100, 5_000, 1_000);
    // A burst of close samples must not reset the baseline — otherwise a fast
    // poll loop could never reach a verdict at all.
    expect(t.observe(100, 5_100, 1_000 + GAP - 1)).toBe('baseline');
    expect(t.observe(100, 5_000 + MIN_PROGRESS_CPU_DELTA_MS, 1_000 + GAP)).toBe('progressed');
  });

  it('reports the standing verdict, not a flap, when a poll lands too soon to compare', () => {
    const t = new TestRunnerProgressTracker();
    t.observe(100, 5_000, 1_000);
    expect(t.observe(100, 9_000, 1_000 + GAP)).toBe('progressed');
    // Two polls close together must not drop a protected run to 'baseline'
    // (or anything weaker) purely on timing.
    expect(t.observe(100, 9_001, 1_000 + GAP + 1)).toBe('progressed');
    expect(t.observe(100, 9_001, 1_000 + 2 * GAP)).toBe('idle');
    expect(t.observe(100, 9_001, 1_000 + 2 * GAP + 1)).toBe('idle');
  });

  it('rebaselines instead of judging when CPU time goes backwards (pid reuse)', () => {
    const t = new TestRunnerProgressTracker();
    t.observe(100, 900_000, 1_000);
    expect(t.observe(100, 10, 1_000 + GAP)).toBe('baseline');
    expect(t.observe(100, 10 + MIN_PROGRESS_CPU_DELTA_MS, 1_000 + 2 * GAP)).toBe('progressed');
  });

  it.each([undefined, Number.NaN, -1])('reports unknown for an unusable reading: %s', (cpu) => {
    const t = new TestRunnerProgressTracker();
    t.observe(100, 5_000, 1_000);
    expect(t.observe(100, cpu as number | undefined, 1_000 + GAP)).toBe('unknown');
  });

  it('tracks pids independently', () => {
    const t = new TestRunnerProgressTracker();
    t.observe(100, 5_000, 1_000);
    t.observe(200, 5_000, 1_000);
    expect(t.observe(100, 9_000, 1_000 + GAP)).toBe('progressed');
    expect(t.observe(200, 5_000, 1_000 + GAP)).toBe('idle');
  });

  it('expires a baseline that has not been re-observed within the retention window', () => {
    const t = new TestRunnerProgressTracker({ retentionMs: 60_000 });
    t.observe(100, 5_000, 1_000);
    // Re-appearing after the window is a new run as far as the tracker knows.
    expect(t.observe(100, 900_000, 1_000 + 60_001)).toBe('baseline');
    expect(t.size).toBe(1);
  });

  it('prunes pids absent from the live snapshot, and forgets one on request', () => {
    const t = new TestRunnerProgressTracker();
    t.observe(100, 1, 1_000);
    t.observe(200, 1, 1_000);
    t.prune([100]);
    expect(t.size).toBe(1);
    t.forget(100);
    expect(t.size).toBe(0);
  });
});

describe('test-runner floor past its wall-clock bound', () => {
  it('holds protection open for a run whose CPU time is still advancing', () => {
    expect(classifyTestRunnerProtection('npm test', PAST_FLOOR, [], 'progressed'))
      .toEqual({ protected: true, reason: 'test-runner', extendedByProgress: true });
  });

  it('releases a run that is past the floor and burning no CPU', () => {
    expect(classifyTestRunnerProtection('npm test', PAST_FLOOR, [], 'idle'))
      .toEqual({ protected: false });
  });

  it('releases a run whose progress could not be measured', () => {
    // The conservative direction, and the reason every pre-existing floor test
    // still passes: without evidence, behaviour is unchanged.
    expect(classifyTestRunnerProtection('npm test', PAST_FLOOR, [], 'unknown'))
      .toEqual({ protected: false });
    expect(classifyTestRunnerProtection('npm test', PAST_FLOOR, []))
      .toEqual({ protected: false });
  });

  it('gives a first-sighted run one poll of grace, so it can be measured at all', () => {
    // A watchdog that meets an already-old run on its first poll (after a
    // server restart) has no baseline to compare. Interrupting there would
    // kill on no evidence whatsoever; one poll later there is a real verdict.
    expect(classifyTestRunnerProtection('npm test', PAST_FLOOR, [], 'baseline'))
      .toEqual({ protected: true, reason: 'test-runner', extendedByProgress: true });
    // And the grace does not survive the absolute bound.
    expect(classifyTestRunnerProtection('npm test', MAX_TEST_RUNNER_ABSOLUTE_MS + 1, [], 'baseline'))
      .toEqual({ protected: false });
  });

  it('extends an ancestor of a live runner too (a push running a pre-push tier)', () => {
    expect(classifyTestRunnerProtection('/usr/bin/git push origin HEAD', PAST_FLOOR, ['node (vitest)'], 'progressed'))
      .toEqual({ protected: true, reason: 'test-runner-ancestor', extendedByProgress: true });
  });

  it('does not extend anything that is not a test runner', () => {
    expect(classifyTestRunnerProtection('python3 poll.py', PAST_FLOOR, ['sleep 5'], 'progressed')).toBeNull();
  });

  it('never marks a run inside the floor as extended — the floor alone covers it', () => {
    expect(classifyTestRunnerProtection('npm test', 190_000, [], 'idle'))
      .toEqual({ protected: true, reason: 'test-runner' });
    expect(classifyTestRunnerProtection('npm test', 190_000, [], 'progressed'))
      .toEqual({ protected: true, reason: 'test-runner' });
  });

  it('closes the door at the absolute bound even while CPU is still advancing', () => {
    expect(classifyTestRunnerProtection('npm test', MAX_TEST_RUNNER_ABSOLUTE_MS, [], 'progressed').protected).toBe(true);
    expect(classifyTestRunnerProtection('npm test', MAX_TEST_RUNNER_ABSOLUTE_MS + 1, [], 'progressed'))
      .toEqual({ protected: false });
  });

  it('bounds the extension at three hours — long enough for a saturated suite, short enough to end', () => {
    expect(MAX_TEST_RUNNER_ABSOLUTE_MS).toBe(3 * 60 * 60 * 1_000);
    expect(MAX_TEST_RUNNER_ABSOLUTE_MS).toBeGreaterThan(MAX_TEST_RUNNER_PROTECTION_MS);
  });

  it('is reachable through classifyProtectedWait, which is what the watchdog calls', () => {
    expect(classifyProtectedWait('npm test', '', PAST_FLOOR, [], 'progressed'))
      .toEqual({ protected: true, reason: 'test-runner', extendedByProgress: true });
    expect(classifyProtectedWait('npm test', '', PAST_FLOOR, [], 'idle'))
      .toEqual({ protected: false });
  });
});
