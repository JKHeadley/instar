/**
 * Unit tests for GeminiLoopDriver (need-gem-002) — the multi-turn re-prompt
 * engine for the Gemini mentee.
 *
 * Every side effect is injected (spawn, budget gate, handle capture, sleep), so
 * these tests exercise the FULL loop logic with zero real gemini calls and zero
 * quota. Both sides of every decision boundary are covered:
 *   - done-sentinel ends the loop (turn 1 AND a later turn)
 *   - max-turns ends the loop (and runs EXACTLY maxTurns)
 *   - budget gate halts (before turn 1 AND mid-loop) — and a passing gate doesn't
 *   - spawn failure ends the loop (turn 1 AND a later turn)
 *   - handle-capture failure ABORTS (never falls back to `latest`)
 *   - argv integrity: turn 1 is one-shot (-m,-p, NO -r); turns 2+ resume
 *     (-m,-r <handle>,-p) with the constant continuation (NO transcript re-send)
 *   - min-turn-interval sleeps between turns
 *   - maxTurns clamps to >= 1
 */

import { describe, it, expect, vi } from 'vitest';
import {
  GeminiLoopDriver,
  DEFAULT_DONE_SENTINEL,
  type GeminiLoopSpawnResult,
  type GeminiLoopSpawn,
} from '../../src/monitoring/GeminiLoopDriver.js';

function ok(stdout: string): GeminiLoopSpawnResult {
  return { exitCode: 0, stdout, stderr: '', truncated: false };
}

/** A spawn that returns a scripted sequence of results, recording every argv. */
function scriptedSpawn(results: GeminiLoopSpawnResult[]): {
  spawn: GeminiLoopSpawn;
  calls: string[][];
} {
  const calls: string[][] = [];
  let i = 0;
  const spawn: GeminiLoopSpawn = async (argv) => {
    calls.push(argv);
    const r = results[Math.min(i, results.length - 1)];
    i += 1;
    return r;
  };
  return { spawn, calls };
}

const HANDLE = 'ef951c6e-49b4-49df-a8f0-b8aa62b4403f';
const captureOk = async () => HANDLE;

describe('GeminiLoopDriver — completion boundaries', () => {
  it('done-sentinel on turn 1 stops immediately (one-shot, no handle)', async () => {
    const { spawn, calls } = scriptedSpawn([ok(`all set\n${DEFAULT_DONE_SENTINEL}`)]);
    const driver = new GeminiLoopDriver({ spawn, captureHandle: captureOk });
    const res = await driver.run({ model: 'gemini-2.5-flash', goalPrompt: 'do X', maxTurns: 5 });

    expect(res.stopReason).toBe('done-sentinel');
    expect(res.turns).toHaveLength(1);
    expect(res.sessionHandle).toBeNull();
    expect(calls).toHaveLength(1); // only turn 1 ran
  });

  it('done-sentinel on a LATER turn stops, with the captured handle', async () => {
    const { spawn, calls } = scriptedSpawn([
      ok('working...'),
      ok('still working'),
      ok(`finished\n${DEFAULT_DONE_SENTINEL}`),
    ]);
    const driver = new GeminiLoopDriver({ spawn, captureHandle: captureOk });
    const res = await driver.run({ model: 'm', goalPrompt: 'g', maxTurns: 10 });

    expect(res.stopReason).toBe('done-sentinel');
    expect(res.turns).toHaveLength(3);
    expect(res.sessionHandle).toBe(HANDLE);
    expect(res.turns[2].done).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('runs EXACTLY maxTurns when never done, stopReason max-turns', async () => {
    const { spawn, calls } = scriptedSpawn([ok('a'), ok('b'), ok('c'), ok('d')]);
    const driver = new GeminiLoopDriver({ spawn, captureHandle: captureOk });
    const res = await driver.run({ model: 'm', goalPrompt: 'g', maxTurns: 3 });

    expect(res.stopReason).toBe('max-turns');
    expect(res.turns).toHaveLength(3);
    expect(calls).toHaveLength(3);
    expect(res.sessionHandle).toBe(HANDLE);
  });

  it('maxTurns clamps to >= 1 (0 still runs one turn)', async () => {
    const { spawn, calls } = scriptedSpawn([ok('one turn')]);
    const driver = new GeminiLoopDriver({ spawn, captureHandle: captureOk });
    const res = await driver.run({ model: 'm', goalPrompt: 'g', maxTurns: 0 });

    expect(calls).toHaveLength(1);
    expect(res.stopReason).toBe('max-turns');
  });
});

describe('GeminiLoopDriver — budget gate', () => {
  it('halts BEFORE turn 1 when the gate is closed (no spawn at all)', async () => {
    const { spawn, calls } = scriptedSpawn([ok('should not run')]);
    const driver = new GeminiLoopDriver({
      spawn,
      captureHandle: captureOk,
      budgetGate: () => ({ ok: false, reason: 'daily cap reached' }),
    });
    const res = await driver.run({ model: 'm', goalPrompt: 'g', maxTurns: 5 });

    expect(res.stopReason).toBe('budget-halt');
    expect(res.haltReason).toBe('daily cap reached');
    expect(calls).toHaveLength(0); // nothing spawned
    expect(res.turns).toHaveLength(0);
  });

  it('halts MID-loop when the gate closes after some turns', async () => {
    let allowed = 0;
    const { spawn, calls } = scriptedSpawn([ok('t1'), ok('t2'), ok('t3')]);
    const driver = new GeminiLoopDriver({
      spawn,
      captureHandle: captureOk,
      // allow turns 1 and 2, then close the gate before turn 3
      budgetGate: () => (allowed++ < 2 ? { ok: true } : { ok: false, reason: 'budget low' }),
    });
    const res = await driver.run({ model: 'm', goalPrompt: 'g', maxTurns: 9 });

    expect(res.stopReason).toBe('budget-halt');
    expect(res.haltReason).toBe('budget low');
    expect(calls).toHaveLength(2); // only turns 1 + 2 spawned
    expect(res.sessionHandle).toBe(HANDLE);
  });
});

describe('GeminiLoopDriver — failure boundaries', () => {
  it('non-zero exit on turn 1 → spawn-failure, no handle', async () => {
    const { spawn } = scriptedSpawn([
      { exitCode: 1, stdout: '', stderr: 'router classifier died', truncated: false },
    ]);
    const driver = new GeminiLoopDriver({ spawn, captureHandle: captureOk });
    const res = await driver.run({ model: 'm', goalPrompt: 'g', maxTurns: 5 });

    expect(res.stopReason).toBe('spawn-failure');
    expect(res.sessionHandle).toBeNull();
    expect(res.turns).toHaveLength(1);
  });

  it('non-zero exit on a later turn → spawn-failure, with handle', async () => {
    const { spawn } = scriptedSpawn([
      ok('t1'),
      { exitCode: 1, stdout: 'partial', stderr: 'boom', truncated: false },
    ]);
    const driver = new GeminiLoopDriver({ spawn, captureHandle: captureOk });
    const res = await driver.run({ model: 'm', goalPrompt: 'g', maxTurns: 5 });

    expect(res.stopReason).toBe('spawn-failure');
    expect(res.sessionHandle).toBe(HANDLE);
    expect(res.turns).toHaveLength(2);
  });

  it('ABORTS when the handle cannot be captured (never falls back to latest)', async () => {
    const { spawn, calls } = scriptedSpawn([ok('t1'), ok('t2-should-not-run')]);
    const driver = new GeminiLoopDriver({
      spawn,
      captureHandle: async () => null, // capture fails
    });
    const res = await driver.run({ model: 'm', goalPrompt: 'g', maxTurns: 5 });

    expect(res.stopReason).toBe('handle-capture-failure');
    expect(res.sessionHandle).toBeNull();
    expect(calls).toHaveLength(1); // only turn 1 ran; never resumed a foreign session
  });
});

describe('GeminiLoopDriver — argv integrity (quota-efficient resume, model bypass)', () => {
  it('turn 1 is a one-shot (-m, -p; NO -r); turns 2+ resume by handle (-m, -r <handle>, -p)', async () => {
    const { spawn, calls } = scriptedSpawn([ok('t1'), ok('t2'), ok(`done\n${DEFAULT_DONE_SENTINEL}`)]);
    const driver = new GeminiLoopDriver({ spawn, captureHandle: captureOk });
    await driver.run({ model: 'gemini-2.5-pro', goalPrompt: 'GOAL TEXT', maxTurns: 9 });

    // Turn 1: one-shot
    expect(calls[0]).toContain('-m');
    expect(calls[0]).toContain('gemini-2.5-pro');
    expect(calls[0]).toContain('-p');
    expect(calls[0]).not.toContain('-r');
    expect(calls[0]).toContain('GOAL TEXT'); // goal goes in turn 1

    // Turns 2 + 3: resume by the stable handle
    for (const argv of [calls[1], calls[2]]) {
      expect(argv).toContain('-m');
      expect(argv).toContain('gemini-2.5-pro'); // explicit model EVERY turn (router-classifier bypass)
      const ri = argv.indexOf('-r');
      expect(ri).toBeGreaterThanOrEqual(0);
      expect(argv[ri + 1]).toBe(HANDLE); // resume the captured handle, not 'latest'
      // NO transcript re-send: the goal text is NOT repeated on resume turns
      expect(argv.join(' ')).not.toContain('GOAL TEXT');
    }
  });

  it('uses a custom continuation prompt when provided', async () => {
    const { spawn, calls } = scriptedSpawn([ok('t1'), ok('t2')]);
    const driver = new GeminiLoopDriver({ spawn, captureHandle: captureOk });
    await driver.run({
      model: 'm',
      goalPrompt: 'g',
      maxTurns: 2,
      continuationPrompt: 'NEXT STEP PLEASE',
    });
    expect(calls[1].join(' ')).toContain('NEXT STEP PLEASE');
  });

  it('honors a custom doneSentinel', async () => {
    const { spawn } = scriptedSpawn([ok('finished -- ALL_DONE_XYZ')]);
    const driver = new GeminiLoopDriver({ spawn, captureHandle: captureOk });
    const res = await driver.run({
      model: 'm',
      goalPrompt: 'g',
      maxTurns: 3,
      doneSentinel: 'ALL_DONE_XYZ',
    });
    expect(res.stopReason).toBe('done-sentinel');
    expect(res.turns).toHaveLength(1);
  });
});

describe('GeminiLoopDriver — anti-spin min interval', () => {
  it('sleeps the configured interval between turns (not before turn 1)', async () => {
    const sleep = vi.fn(async () => {});
    const { spawn } = scriptedSpawn([ok('t1'), ok('t2'), ok('t3')]);
    const driver = new GeminiLoopDriver({ spawn, captureHandle: captureOk, sleep });
    await driver.run({ model: 'm', goalPrompt: 'g', maxTurns: 3, minTurnIntervalMs: 2000 });

    // 3 turns → sleeps before turn 2 and turn 3 only (2 sleeps, never before turn 1)
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('does not sleep when interval is 0/unset', async () => {
    const sleep = vi.fn(async () => {});
    const { spawn } = scriptedSpawn([ok('t1'), ok('t2')]);
    const driver = new GeminiLoopDriver({ spawn, captureHandle: captureOk, sleep });
    await driver.run({ model: 'm', goalPrompt: 'g', maxTurns: 2 });
    expect(sleep).not.toHaveBeenCalled();
  });
});
