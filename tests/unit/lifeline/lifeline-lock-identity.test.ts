/**
 * The lifeline lock and `lifeline restart` signal a recorded pid only when the
 * live process at that pid is PROVEN to be the one that wrote the record (same
 * process start time). A command line containing "lifeline" is not identity:
 * a reused pid can belong to a `claude -p` builder whose prompt mentions the
 * lifeline. Real child processes, both sides of each decision.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLockFile, provenLifelineRecords } from '../../../src/lifeline/lifelineLock.js';
import { checkRecordedProcess, processStartMs } from '../../../src/core/processIdentity.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const children: ChildProcess[] = [];
const dirs: string[] = [];

/** A running process whose command line names the lifeline, like a builder's prompt. */
function foreignLifelineShaped(): ChildProcess {
  const child = spawn('/bin/sh', ['-c', 'sleep 600; : claude -p repair the lifeline'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

function plainSleeper(): ChildProcess {
  const child = spawn('sleep', ['600'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

async function startOf(pid: number): Promise<number> {
  for (let i = 0; i < 40; i++) {
    const t = processStartMs(pid);
    if (t !== null) return t;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no start time for ${pid}`);
}

function alive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function lockDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-lock-'));
  dirs.push(d);
  return d;
}

const tenMinutesAgo = () => new Date(Date.now() - 10 * 60_000).toISOString();

afterEach(() => {
  for (const c of children.splice(0)) if (alive(c)) c.kill('SIGKILL'); // exact child pids we started
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/lifeline/lifeline-lock-identity.test.ts' });
});

describe('checkRecordedProcess', () => {
  it('same only for a matching start time; gone for a dead pid; unproven for a legacy record', async () => {
    const child = plainSleeper();
    const start = await startOf(child.pid!);
    expect(checkRecordedProcess({ pid: child.pid, procStart: start })).toBe('same');
    expect(checkRecordedProcess({ pid: child.pid, procStart: start - 60_000 })).toBe('unproven');
    expect(checkRecordedProcess({ pid: child.pid })).toBe('unproven');
    // Record written before the process existed → the pid was reused.
    expect(checkRecordedProcess({ pid: child.pid, startedAt: new Date(start - 60_000).toISOString() })).toBe('reused');
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    expect(checkRecordedProcess({ pid: child.pid, procStart: start })).toBe('gone');
  });
});

describe('lifeline restart targets (provenLifelineRecords)', () => {
  it('a stale lock whose pid now runs a foreign command mentioning "lifeline" is not a target', async () => {
    const foreign = foreignLifelineShaped();
    await startOf(foreign.pid!);
    const dir = lockDir();
    const lockPath = path.join(dir, 'lifeline.lock');
    // Legacy lock (no start time) and a lock with a stale start time.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: foreign.pid, startedAt: tenMinutesAgo() }));
    expect(provenLifelineRecords(lockPath, null)).toEqual([]);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: foreign.pid, procStart: 1_000, startedAt: tenMinutesAgo() }));
    expect(provenLifelineRecords(lockPath, { pid: foreign.pid!, procStart: 1_000 })).toEqual([]);
  });

  it('the own stuck lock holder and marker pid ARE targets (deduplicated)', async () => {
    const own = plainSleeper();
    const procStart = await startOf(own.pid!);
    const dir = lockDir();
    const lockPath = path.join(dir, 'lifeline.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: own.pid, procStart, startedAt: tenMinutesAgo() }));
    const targets = provenLifelineRecords(lockPath, { pid: own.pid!, procStart });
    expect(targets.map((t) => t.pid)).toEqual([own.pid]);
    // Marker-only (no lock) still reaches the proven marker pid.
    expect(provenLifelineRecords(path.join(dir, 'absent.lock'), { pid: own.pid!, procStart }).map((t) => t.pid)).toEqual([own.pid]);
  });
});

describe('acquireLockFile', () => {
  it('a stale lock whose pid was reused by a foreign process: takes over WITHOUT signalling it', async () => {
    const foreign = foreignLifelineShaped();
    await startOf(foreign.pid!);
    const lockPath = path.join(lockDir(), 'lifeline.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: foreign.pid, startedAt: tenMinutesAgo() }));
    expect(acquireLockFile(lockPath)).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(foreign)).toBe(true);
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    expect(lock.pid).toBe(process.pid);
    expect(lock.procStart).toBe(processStartMs(process.pid));
  });

  it('a live holder with a legacy lock (identity unproven): respects the lock, signals nothing', async () => {
    const foreign = foreignLifelineShaped();
    const start = await startOf(foreign.pid!);
    const lockPath = path.join(lockDir(), 'lifeline.lock');
    // Written a few seconds after the process started, old enough to look wedged.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: foreign.pid, startedAt: new Date(start + 1000).toISOString() }));
    expect(acquireLockFile(lockPath)).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(foreign)).toBe(true);
  });

  it('a fresh proven holder is respected', async () => {
    const own = plainSleeper();
    const procStart = await startOf(own.pid!);
    const lockPath = path.join(lockDir(), 'lifeline.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: own.pid, procStart, startedAt: new Date().toISOString() }));
    expect(acquireLockFile(lockPath)).toBe(false);
    expect(alive(own)).toBe(true);
  });

  it('a proven holder wedged sleeping >5 min is terminated and the lock taken over', async () => {
    const own = plainSleeper();
    const procStart = await startOf(own.pid!);
    const exited = new Promise((r) => own.once('exit', r));
    const lockPath = path.join(lockDir(), 'lifeline.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: own.pid, procStart, startedAt: tenMinutesAgo() }));
    expect(acquireLockFile(lockPath)).toBe(true);
    await exited;
    expect(alive(own)).toBe(false);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid).toBe(process.pid);
  }, 15_000);
});
