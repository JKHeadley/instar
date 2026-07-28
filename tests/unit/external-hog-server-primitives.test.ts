import { describe, it, expect } from 'vitest';
import { makeCpuCoresOver, parseTmuxPanePids, createExternalHogServerPrimitives } from '../../src/monitoring/ExternalHogServerPrimitives.js';

/**
 * ExternalHogServerPrimitives — the §4.5 kill-time CPU probe + the primitive factory (CMT-1901).
 * The probe is the safety-relevant piece: it must resolve a fresh core-equivalents reading and
 * fail-safe to null (→ the kill aborts) on any pid-gone / pid-reused / unknown-delta condition.
 */

// A ps row: pid ppid uid <lstart 5 tokens> <time> comm. cputime `MMM:SS.ss`.
function psRow(cputimeSeconds: number, start = 'Wed Jul 2 10:00:00 2026'): string {
  const mm = Math.floor(cputimeSeconds / 60);
  const ss = (cputimeSeconds % 60).toFixed(2).padStart(5, '0');
  return `9000 1 501 ${start} ${mm}:${ss} Code Helper (Plugin)`;
}

/** exec fake that returns a scripted sequence of ps outputs (one per call). */
function scriptedExec(outputs: string[]) {
  let i = 0;
  return async () => outputs[Math.min(i++, outputs.length - 1)]!;
}
const noSleep = async () => {};
let clock = 0;
const stepClock = (ms: number) => () => (clock += ms);

describe('makeCpuCoresOver — the §4.5 kill-time CPU re-confirm', () => {
  it('a STILL-pinning process resolves ~2 cores over a 30s window', async () => {
    clock = 0;
    // +60 cpu-sec across a 30_000ms window = 2 cores. Clock advances 30_000 between the two reads.
    let first = true;
    const now = () => { if (first) { first = false; return 0; } return 30_000; };
    const probe = makeCpuCoresOver(scriptedExec([psRow(100), psRow(160)]), now, noSleep);
    const cores = await probe(9000, 30_000);
    expect(cores).not.toBeNull();
    expect(cores!).toBeCloseTo(2, 1);
  });

  it('an IDLE process (no cputime growth) resolves ~0 cores', async () => {
    let first = true;
    const now = () => { if (first) { first = false; return 0; } return 30_000; };
    const probe = makeCpuCoresOver(scriptedExec([psRow(100), psRow(100)]), now, noSleep);
    const cores = await probe(9000, 30_000);
    expect(cores).toBeCloseTo(0, 1); // below any kill threshold → the caller vetoes
  });

  it('a VANISHED pid (empty ps) → null (fail-safe → abort)', async () => {
    const probe = makeCpuCoresOver(scriptedExec(['', '']), stepClock(30_000), noSleep);
    expect(await probe(9000, 30_000)).toBeNull();
  });

  it('a pid REUSED mid-window (startTime changed) → null (abort)', async () => {
    let first = true;
    const now = () => { if (first) { first = false; return 0; } return 30_000; };
    const probe = makeCpuCoresOver(
      scriptedExec([psRow(100, 'Wed Jul 2 10:00:00 2026'), psRow(160, 'Wed Jul 2 11:00:00 2026')]),
      now, noSleep,
    );
    expect(await probe(9000, 30_000)).toBeNull();
  });

  it('an exec THROW → null (fail-safe)', async () => {
    const probe = makeCpuCoresOver(async () => { throw new Error('ps failed'); }, stepClock(30_000), noSleep);
    expect(await probe(9000, 30_000)).toBeNull();
  });
});

describe('parseTmuxPanePids', () => {
  it('parses pane pids, ignoring blanks/garbage', () => {
    expect(parseTmuxPanePids('123\n\n456\nnotapid\n789')).toEqual([123, 456, 789]);
  });
});

describe('createExternalHogServerPrimitives — assembly', () => {
  it('wires the primitives (config/loadArm/serverPid/ownEuid pass through; tmux pids parsed)', async () => {
    const prims = createExternalHogServerPrimitives({
      exec: async (cmd) => (cmd === 'tmux' ? '111\n222' : ''),
      signal: () => true,
      evaluate: async () => '{"action":"leave"}',
      raiseAttention: () => undefined,
      config: () => ({ enabled: true, dryRun: true }),
      stateDir: '/nonexistent-state-dir',
      ownEuid: 501,
      serverPid: 42,
      sleep: noSleep,
    });
    expect(prims.ownEuid()).toBe(501);
    expect(prims.serverPid()).toBe(42);
    expect(prims.config()).toEqual({ enabled: true, dryRun: true });
    expect(await prims.listTmuxPanePids()).toEqual([111, 222]);
    // loadArm on a nonexistent stateDir fails closed to disarmed (marker null).
    expect(prims.loadArm()).toEqual({ marker: null, lastDisarmEpoch: 0 });
    expect(await prims.callModel('x')).toBe('{"action":"leave"}');
  });
});
