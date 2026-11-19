/**
 * restart-lock-continuity part C.1: lock watch, one report per host episode.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LockWatch, HOURLY_FLOOR, PENDING_RECLAIM_MS, type LockReading } from '../../src/monitoring/LockWatch.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MIN = 60_000;
let dir: string;
let clock: number;
let reports: string[];

function watch(over: { reading?: () => LockReading; scope?: { watched: boolean; interruptsWork: boolean; lockOnly: boolean }; agent?: string; machineId?: string } = {}) {
  return new LockWatch({
    hostDir: dir,
    read: async () => (over.reading ?? (() => 'locked'))(),
    scope: () => over.scope ?? { watched: true, interruptsWork: false, lockOnly: true },
    report: (r) => { reports.push(r.feature); },
    machineId: over.machineId ?? 'm_a',
    agentName: over.agent ?? 'echo',
    bootAt: 1,
    now: () => clock,
  });
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lockwatch-')); clock = 1_000_000_000_000; reports = []; });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/lock-watch.test.ts' }); });

describe('LockWatch', () => {
  it('no report before the hold; one report at the hold; none again in the episode', async () => {
    const w = watch();
    expect(await w.tick()).toBe('locked-holding');
    clock += 5 * MIN; expect(await w.tick()).toBe('locked-holding');
    clock += 5 * MIN; expect(await w.tick()).toBe('reported');
    clock += 5 * MIN; expect(await w.tick()).toBe('already-delivered');
    expect(reports).toHaveLength(1);
  });

  it('two co-resident agents with different machine ids give one report', async () => {
    const a = watch({ agent: 'echo', machineId: 'm_a' });
    const b = watch({ agent: 'luna', machineId: 'm_b' });
    await a.tick(); clock += 5 * MIN; await b.tick(); clock += 5 * MIN;
    const ra = await a.tick(); const rb = await b.tick();
    expect([ra, rb].filter((x) => x === 'reported')).toHaveLength(1);
    expect(reports).toHaveLength(1);
  });

  it('a restarting agent inherits the run its sibling kept; a real gap restarts the hold', async () => {
    const a = watch(); const b = watch({ agent: 'luna', machineId: 'm_b' });
    await a.tick(); clock += 5 * MIN; await b.tick(); // a "restarts", b keeps reading
    clock += 5 * MIN;
    const fresh = watch(); // a after restart
    expect(await fresh.tick()).toBe('reported');

    reports = []; clock += 60 * MIN;
    const u = watch({ reading: () => 'unlocked' }); await u.tick();
    const c = watch(); await c.tick();
    clock += 20 * MIN; // nobody read for 20 min: gap > interval + 60 s
    expect(await c.tick()).toBe('locked-holding');
  });

  it('an unknown reading interrupts the run without ending the episode', async () => {
    let r: LockReading = 'locked';
    const w = watch({ reading: () => r });
    await w.tick(); const ep1 = w.status().file.episode!.episodeId;
    clock += 5 * MIN; r = 'unknown'; expect(await w.tick()).toBe('interrupted');
    clock += 5 * MIN; r = 'locked'; expect(await w.tick()).toBe('locked-holding');
    expect(w.status().file.episode!.episodeId).toBe(ep1);
  });

  it('unlocked ends the episode; a new lock is a new episode with its own feature', async () => {
    let r: LockReading = 'locked';
    const w = watch({ reading: () => r });
    await w.tick(); clock += 5 * MIN; await w.tick(); clock += 5 * MIN; await w.tick();
    r = 'unlocked'; clock += MIN; expect(await w.tick()).toBe('episode-ended');
    r = 'locked'; clock += MIN; await w.tick(); clock += 5 * MIN; await w.tick(); clock += 5 * MIN; await w.tick();
    expect(reports).toHaveLength(2);
    expect(reports[0]).not.toBe(reports[1]);
  });

  it('hourly floor: a fourth episode within the hour is recorded, not alerted, unless it interrupts work', async () => {
    let r: LockReading = 'locked';
    let busy = false;
    const w = new LockWatch({ hostDir: dir, read: async () => r, scope: () => ({ watched: true, interruptsWork: busy, lockOnly: true }), report: (x) => reports.push(x.feature), machineId: 'm', agentName: 'e', bootAt: 1, now: () => clock });
    for (let i = 0; i < HOURLY_FLOOR; i++) {
      r = 'locked'; await w.tick(); clock += 5 * MIN; await w.tick(); clock += 5 * MIN; await w.tick(); r = 'unlocked'; await w.tick(); clock += MIN;
    }
    expect(reports).toHaveLength(HOURLY_FLOOR);
    r = 'locked'; await w.tick(); clock += 5 * MIN; await w.tick(); clock += 5 * MIN; expect(await w.tick()).toBe('floored');
    busy = true; clock += MIN; expect(await w.tick()).toBe('reported');
  });

  it('an attended coordinator reports only while Local Verify work is waiting', async () => {
    let busy = false;
    const w = new LockWatch({ hostDir: dir, read: async () => 'locked', scope: () => ({ watched: true, interruptsWork: busy, lockOnly: false }), report: (x) => reports.push(x.feature), machineId: 'm', agentName: 'e', bootAt: 1, now: () => clock });
    await w.tick(); clock += 5 * MIN; await w.tick(); clock += 5 * MIN;
    expect(await w.tick()).toBe('locked-attended-idle');
    busy = true; clock += MIN;
    expect(await w.tick()).toBe('reported');
  });

  it('a pending claim left by a crashed agent is reclaimed after 2 minutes', async () => {
    const w = watch();
    await w.tick(); clock += 10 * MIN;
    const file = path.join(dir, 'lock-watch.json');
    const f = JSON.parse(fs.readFileSync(file, 'utf-8'));
    f.episode.continuousLockedSince = clock - 10 * MIN;
    f.episode.lastLockedReadingAt = clock - 4 * MIN;
    f.episode.report = { state: 'pending', claimedAt: clock, by: 'dead@x' };
    fs.writeFileSync(file, JSON.stringify(f));
    expect(await w.tick()).toBe('already-pending');
    clock += PENDING_RECLAIM_MS + 1;
    const g = JSON.parse(fs.readFileSync(file, 'utf-8')); g.episode.lastLockedReadingAt = clock - MIN; fs.writeFileSync(file, JSON.stringify(g));
    expect(await w.tick()).toBe('reported');
  });

  it('a machine that is not watched never reports', async () => {
    const w = watch({ scope: { watched: false, interruptsWork: false, lockOnly: true } });
    await w.tick(); clock += 20 * MIN;
    expect(await w.tick()).toBe('locked-not-watched');
    expect(reports).toHaveLength(0);
  });

  it('brakes: 12 unknown readings in a row pause the watch', async () => {
    const w = watch({ reading: () => 'unknown' });
    for (let i = 0; i < 12; i++) await w.tick();
    expect(w.status().paused).toBe(true);
    expect(await w.tick()).toBe('paused');
  });

  it('a paused watch resumes when another agent on the host gets a definite reading', async () => {
    const w = watch({ reading: () => 'unknown' });
    for (let i = 0; i < 12; i++) await w.tick();
    expect(w.status().paused).toBe(true);
    clock += MIN;
    await watch({ agent: 'luna', machineId: 'm_b', reading: () => 'unlocked' }).tick();
    clock += MIN;
    expect(await w.tick()).not.toBe('paused');
  });

  it('the deadline re-read takes a second, fresh reading after an unknown', async () => {
    const seq: LockReading[] = ['unknown', 'locked'];
    let calls = 0;
    const w = new LockWatch({ hostDir: dir, read: async () => seq[Math.min(calls++, seq.length - 1)], scope: () => ({ watched: true, interruptsWork: false, lockOnly: true }), report: () => {}, machineId: 'm', agentName: 'e', bootAt: 1, now: () => clock, rereadDelayMs: 0 });
    await w.tick({ deadlineReread: true });
    expect(calls).toBe(2);
  });

  it('work seen at any reading keeps an attended coordinator\'s episode reportable', async () => {
    let busy = true;
    const w = new LockWatch({ hostDir: dir, read: async () => 'locked', scope: () => ({ watched: true, interruptsWork: busy, lockOnly: false }), report: (x) => reports.push(x.feature), machineId: 'm', agentName: 'e', bootAt: 1, now: () => clock });
    await w.tick(); busy = false; clock += 5 * MIN; await w.tick(); clock += 5 * MIN;
    expect(await w.tick()).toBe('reported');
  });
});
