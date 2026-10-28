/**
 * The real exec seam's fail-fast stop: an aborted lane process is killed promptly and
 * reported as `aborted`, never as a deadline (a deadline is an infrastructure error).
 */
import { describe, it, expect } from 'vitest';
import { descendantPids, psSnapshot, realExec } from '../../../src/localVerify/orchestratorSeams.js';

const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };

describe('realExec — abort signal', () => {
  it('kills a running process on abort and reports aborted, not deadlineKilled', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = realExec('sleep', ['30'], { cwd: process.cwd(), env, deadlineMs: 60_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.deadlineKilled).toBe(false);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
  it('an already-aborted signal starts nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await realExec('sleep', ['30'], { cwd: process.cwd(), env, deadlineMs: 60_000, signal: ac.signal });
    expect(r.aborted).toBe(true);
    expect(r.pid).toBeNull();
  });
  it('without a signal a process that ends on its own is not aborted', async () => {
    const r = await realExec('true', [], { cwd: process.cwd(), env, deadlineMs: 10_000 });
    expect(r.status).toBe(0);
    expect(r.aborted).toBeUndefined();
  });
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('realExec — the whole process tree is stopped', () => {
  it('an abort also stops a descendant that holds the pipes (the run does not hang)', async () => {
    const ac = new AbortController();
    // The parent shell starts a background sleeper that inherits stdout, prints its pid, then waits.
    const p = realExec('sh', ['-c', 'sleep 60 & echo $!; wait'], { cwd: process.cwd(), env, deadlineMs: 120_000, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    const t0 = Date.now();
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(15_000);
    const sleeper = Number(r.stdout.trim().split('\n')[0]);
    expect(sleeper).toBeGreaterThan(0);
    await new Promise((res) => setTimeout(res, 200));
    expect(alive(sleeper)).toBe(false);
  }, 30_000);
  it('a child that ignores SIGTERM is killed after the grace period', async () => {
    const ac = new AbortController();
    const p = realExec('sh', ['-c', "trap '' TERM; sleep 60"], { cwd: process.cwd(), env, deadlineMs: 120_000, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.deadlineKilled).toBe(false);
  }, 30_000);
  it('a deadline that fires first is a deadline, and a later abort does not relabel it', async () => {
    const ac = new AbortController();
    const p = realExec('sleep', ['30'], { cwd: process.cwd(), env, deadlineMs: 100, signal: ac.signal });
    setTimeout(() => ac.abort(), 400);
    const r = await p;
    expect(r.deadlineKilled).toBe(true);
    expect(r.aborted).toBeUndefined();
  }, 30_000);
  it('a descendant that ignores SIGTERM with its own stdio still gets the SIGKILL after the parent settles', async () => {
    const ac = new AbortController();
    const p = realExec('sh', ['-c', "(trap '' TERM; exec sleep 60) >/dev/null 2>&1 & echo $!; wait"], { cwd: process.cwd(), env, deadlineMs: 120_000, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    const r = await p;
    expect(r.aborted).toBe(true);
    const stubborn = Number(r.stdout.trim().split('\n')[0]);
    expect(stubborn).toBeGreaterThan(0);
    await new Promise((res) => setTimeout(res, 6_500));
    expect(alive(stubborn)).toBe(false);
  }, 30_000);
  it('a process that exits while a descendant holds its pipes settles boundedly once its deadline fires', async () => {
    const t0 = Date.now();
    const r = await realExec('sh', ['-c', 'sleep 20 & exit 0'], { cwd: process.cwd(), env, deadlineMs: 300 });
    expect(r.deadlineKilled).toBe(true);
    expect(Date.now() - t0).toBeLessThan(12_000);
  }, 30_000);
});

describe('descendantPids / psSnapshot', () => {
  const ps = [
    '  1     0 Mon Oct 26 18:00:00 2026',
    ' 10     1 Mon Oct 26 18:00:01 2026',
    ' 11    10 Mon Oct 26 18:00:02 2026',
    ' 12    11 Mon Oct 26 18:00:03 2026',
    ' 13    10 Mon Oct 26 18:00:04 2026',
    ' 20     1 Mon Oct 26 18:00:05 2026',
    'junk line',
  ].join('\n');
  it('walks children and grandchildren from a snapshot, with start times, and nothing else', () => {
    const snap = psSnapshot(ps)!;
    expect(descendantPids(10, snap).map((d) => d.pid).sort((a, b) => a - b)).toEqual([11, 12, 13]);
    expect(descendantPids(10, snap).find((d) => d.pid === 12)?.start).toBe('Mon Oct 26 18:00:03 2026');
    expect(descendantPids(20, snap)).toEqual([]);
  });
  it('the identity carries the command: a reused pid with the same start second but another command does not match', () => {
    const a = psSnapshot(' 30  1 Mon Oct 26 18:00:01 2026     sleep')!;
    const b = psSnapshot(' 30  1 Mon Oct 26 18:00:01 2026     node')!;
    expect(a.get(30)!.start).toBe('Mon Oct 26 18:00:01 2026 sleep');
    expect(a.get(30)!.start === b.get(30)!.start).toBe(false);
  });
  it('the real ps answers with a start time and a command for this process', () => {
    const snap = psSnapshot()!;
    expect(snap.get(process.pid)?.start).toMatch(/\d{4} \S/);
  });
  it('no snapshot means no descendants', () => {
    expect(descendantPids(10, null)).toEqual([]);
  });
});
