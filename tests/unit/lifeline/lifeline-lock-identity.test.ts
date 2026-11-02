/**
 * The lifeline lock and `lifeline restart` signal a recorded pid only when the
 * live process at that pid is PROVEN to be the one that wrote the record (same
 * process start time). A command line containing "lifeline" is not identity:
 * a reused pid can belong to a `claude -p` builder whose prompt mentions the
 * lifeline. Real child processes, both sides of each decision.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLockFile, provenLifelineRecords, startLockHeartbeat } from '../../../src/lifeline/lifelineLock.js';
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

describe('failed start-time lookup (ps denied / erroring)', () => {
  let savedPath: string | undefined;
  /** Put a `ps` that always fails first on PATH — the shape of a denied or broken lookup. */
  function breakPs(): void {
    const bin = lockDir();
    fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\necho "ps: operation not permitted" >&2\nexit 1\n', { mode: 0o755 });
    savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
  }
  afterEach(() => {
    if (savedPath !== undefined) process.env.PATH = savedPath;
    savedPath = undefined;
  });

  it('a live holder whose identity cannot be read is unproven, and its lock is kept', async () => {
    const holder = plainSleeper();
    const procStart = await startOf(holder.pid!);
    const lockPath = path.join(lockDir(), 'lifeline.lock');
    const record = { pid: holder.pid, procStart, startedAt: tenMinutesAgo() };
    fs.writeFileSync(lockPath, JSON.stringify(record));
    breakPs();
    expect(processStartMs(holder.pid!)).toBeNull();
    expect(checkRecordedProcess(record)).toBe('unproven');
    expect(acquireLockFile(lockPath)).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(holder)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid).toBe(holder.pid);
  });

  it('identity turning unreadable during the SIGTERM grace: no SIGKILL, lock kept', async () => {
    // A proven, wedged holder that ignores SIGTERM (our own child).
    const holder = spawn('/bin/sh', ['-c', 'trap "" TERM; while :; do sleep 1; done'], { stdio: 'ignore' });
    children.push(holder);
    const procStart = await startOf(holder.pid!);
    const lockPath = path.join(lockDir(), 'lifeline.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, procStart, startedAt: tenMinutesAgo() }));
    // `ps` answers the first identity check, then fails for the rest.
    const bin = lockDir();
    const count = path.join(bin, 'count');
    fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\nif [ -f "${count}" ]; then exit 1; fi\n: > "${count}"\nexec /bin/ps "$@"\n`, { mode: 0o755 });
    savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    expect(acquireLockFile(lockPath)).toBe(false);
    expect(alive(holder)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid).toBe(holder.pid);
  }, 15_000);

  it('a confirmed-dead holder (ESRCH) is still gone, and the lock is taken over', async () => {
    const holder = plainSleeper();
    const procStart = await startOf(holder.pid!);
    holder.kill('SIGKILL');
    await new Promise((r) => holder.once('exit', r));
    const lockPath = path.join(lockDir(), 'lifeline.lock');
    const record = { pid: holder.pid, procStart, startedAt: tenMinutesAgo() };
    fs.writeFileSync(lockPath, JSON.stringify(record));
    breakPs();
    expect(checkRecordedProcess(record)).toBe('gone');
    expect(acquireLockFile(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid).toBe(process.pid);
  });
});

describe('a holder that heartbeats (issue #2485)', () => {
  /** The shape the issue names: a Node process idling on its event loop. */
  function idleNode(): ChildProcess {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
    children.push(child);
    return child;
  }

  async function heldLock(child: ChildProcess, heartbeatAgeMs: number): Promise<string> {
    const procStart = await startOf(child.pid!);
    const lockPath = path.join(lockDir(), 'lifeline.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: child.pid, procStart, startedAt: tenMinutesAgo(), heartbeatMs: 30_000 }));
    const at = new Date(Date.now() - heartbeatAgeMs);
    fs.utimesSync(lockPath, at, at);
    return lockPath;
  }

  it('a healthy idle holder with a fresh heartbeat is left alone, however old its lock', async () => {
    const holder = idleNode();
    const lockPath = await heldLock(holder, 10_000);
    const before = fs.readFileSync(lockPath, 'utf-8');
    expect(acquireLockFile(lockPath, { secondLookMs: 300 })).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(holder)).toBe(true);
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe(before);
  });

  it('a holder whose heartbeat stopped >5 min ago is terminated and the lock taken over', async () => {
    const holder = idleNode();
    const exited = new Promise((r) => holder.once('exit', r));
    const lockPath = await heldLock(holder, 6 * 60_000);
    expect(acquireLockFile(lockPath, { secondLookMs: 300 })).toBe(true);
    await exited;
    expect(alive(holder)).toBe(false);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid).toBe(process.pid);
  }, 15_000);

  it('a stale heartbeat that moves during the second look is left alone (a Mac waking from sleep)', async () => {
    const holder = idleNode();
    const lockPath = await heldLock(holder, 6 * 60_000);
    // A real second process, because acquire blocks this event loop while it looks.
    const toucher = spawn(process.execPath, ['-e', `setTimeout(()=>{const n=new Date();require('fs').utimesSync(${JSON.stringify(lockPath)},n,n)},400)`], { stdio: 'ignore' });
    children.push(toucher);
    expect(acquireLockFile(lockPath, { secondLookMs: 8_000 })).toBe(false);
    expect(alive(holder)).toBe(true);
  }, 15_000);

  it('a clock jump during the second look does not cut it short', async () => {
    const holder = idleNode();
    const lockPath = await heldLock(holder, 6 * 60_000);
    const toucher = spawn(process.execPath, ['-e', `setTimeout(()=>{const n=new Date();require('fs').utimesSync(${JSON.stringify(lockPath)},n,n)},1500)`], { stdio: 'ignore' });
    children.push(toucher);
    const realNow = Date.now.bind(Date);
    let calls = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + (++calls > 3 ? 60 * 60_000 : 0));
    try {
      expect(acquireLockFile(lockPath, { secondLookMs: 8_000 })).toBe(false);
    } finally {
      clock.mockRestore();
    }
    expect(alive(holder)).toBe(true);
  }, 15_000);

  it('a lock with a heartbeat field written by this code carries the cadence', () => {
    const lockPath = path.join(lockDir(), 'lifeline.lock');
    expect(acquireLockFile(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).heartbeatMs).toBe(30_000);
  });
});

describe('startLockHeartbeat', () => {
  const past = () => new Date(Date.now() - 60 * 60_000);

  it('touches its own lock without changing the content, and stops when told', async () => {
    const lockPath = path.join(lockDir(), 'lifeline.lock');
    expect(acquireLockFile(lockPath)).toBe(true);
    const content = fs.readFileSync(lockPath, 'utf-8');
    fs.utimesSync(lockPath, past(), past());
    const stale = fs.statSync(lockPath).mtimeMs;
    const stop = startLockHeartbeat(lockPath, 20);
    await new Promise((r) => setTimeout(r, 120));
    stop();
    const touched = fs.statSync(lockPath).mtimeMs;
    expect(touched).toBeGreaterThan(stale);
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe(content);
    fs.utimesSync(lockPath, past(), past());
    const stopped = fs.statSync(lockPath).mtimeMs;
    await new Promise((r) => setTimeout(r, 80));
    expect(fs.statSync(lockPath).mtimeMs).toBe(stopped);
  });

  it('never touches a lock owned by another process', async () => {
    const lockPath = path.join(lockDir(), 'lifeline.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 1, startedAt: new Date().toISOString() }));
    fs.utimesSync(lockPath, past(), past());
    const stale = fs.statSync(lockPath).mtimeMs;
    const stop = startLockHeartbeat(lockPath, 20);
    await new Promise((r) => setTimeout(r, 80));
    stop();
    expect(fs.statSync(lockPath).mtimeMs).toBe(stale);
  });

  it('the lifeline starts it after taking the lock and stops it before releasing', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lifeline/TelegramLifeline.ts'), 'utf-8');
    const acquired = src.indexOf('if (!acquireLockFile(this.lockPath))');
    expect(src.indexOf('startLockHeartbeat(this.lockPath)')).toBeGreaterThan(acquired);
    const stopped = src.indexOf('this.stopLockHeartbeat();');
    expect(stopped).toBeGreaterThan(-1);
    expect(stopped).toBeLessThan(src.indexOf('releaseLockFile(this.lockPath)'));
  });
});

describe('only one starter wins the lock', () => {
  const rival = () => JSON.stringify({ pid: process.pid + 1, startedAt: new Date().toISOString() });

  it('with no lock: a rival that creates it first wins, and this starter leaves it alone', () => {
    const lockPath = path.join(lockDir(), 'lifeline.lock');
    const theirs = rival();
    expect(acquireLockFile(lockPath, { beforeCreate: () => fs.writeFileSync(lockPath, theirs) })).toBe(false);
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe(theirs);
  });

  it('with a dead holder: a rival that takes over first wins', async () => {
    const dead = plainSleeper();
    const procStart = await startOf(dead.pid!);
    dead.kill('SIGKILL');
    await new Promise((r) => dead.once('exit', r));
    const lockPath = path.join(lockDir(), 'lifeline.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: dead.pid, procStart, startedAt: tenMinutesAgo() }));
    const theirs = rival();
    expect(acquireLockFile(lockPath, { beforeCreate: () => fs.writeFileSync(lockPath, theirs) })).toBe(false);
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe(theirs);
  });

  it('a stale lock another starter is taking over is left to that starter', () => {
    const lockPath = path.join(lockDir(), 'lifeline.lock');
    const stale = JSON.stringify({ pid: 999_999, procStart: 1, startedAt: tenMinutesAgo() });
    fs.writeFileSync(lockPath, stale);
    fs.writeFileSync(`${lockPath}.takeover`, '1');
    expect(acquireLockFile(lockPath)).toBe(false);
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe(stale);
  });

  it('a takeover mutex left by a crashed starter ages out', () => {
    const lockPath = path.join(lockDir(), 'lifeline.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999_999, procStart: 1, startedAt: tenMinutesAgo() }));
    fs.writeFileSync(`${lockPath}.takeover`, '1');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${lockPath}.takeover`, old, old);
    expect(acquireLockFile(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid).toBe(process.pid);
    expect(fs.existsSync(`${lockPath}.takeover`)).toBe(false);
  });

  // Real processes on the built code: a same-instant start is exactly what an
  // in-process test cannot produce. The old code let all 20 win.
  it.each([
    ['no lock', null],
    ['a dead holder', JSON.stringify({ pid: 999_999, procStart: 1, startedAt: tenMinutesAgo() })],
  ])('20 processes starting at once on %s: exactly one wins', async (_name, existing) => {
    const dir = lockDir();
    const lockPath = path.join(dir, 'lifeline.lock');
    if (existing) fs.writeFileSync(lockPath, existing);
    const lib = path.join(process.cwd(), 'dist/lifeline/lifelineLock.js');
    const script = path.join(dir, 'starter.mjs');
    fs.writeFileSync(script, `import { acquireLockFile } from ${JSON.stringify(lib)};
const when = Number(process.argv[3]);
await new Promise((r) => setTimeout(r, Math.max(0, when - Date.now() - 5)));
while (Date.now() < when) {}
console.log(acquireLockFile(process.argv[2]) ? 'WON' : 'lost');
setTimeout(() => process.exit(0), 800);
`);
    const when = Date.now() + 3000;
    const outputs = await Promise.all(Array.from({ length: 20 }, () => new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [script, lockPath, String(when)], { stdio: ['ignore', 'pipe', 'ignore'] });
      children.push(child);
      let out = '';
      child.stdout!.on('data', (d) => { out += d; });
      child.on('exit', () => resolve(out));
    })));
    expect(outputs.filter((o) => o.includes('lost') || o.includes('WON'))).toHaveLength(20);
    expect(outputs.filter((o) => o.includes('WON'))).toHaveLength(1);
  }, 30_000);

  it('on a filesystem without hard links, a dead holder is still taken over', async () => {
    const dead = plainSleeper();
    const procStart = await startOf(dead.pid!);
    dead.kill('SIGKILL');
    await new Promise((r) => dead.once('exit', r));
    const dir = lockDir();
    const lockPath = path.join(dir, 'lifeline.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: dead.pid, procStart, startedAt: tenMinutesAgo() }));
    const link = vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    });
    try {
      expect(acquireLockFile(lockPath)).toBe(true);
    } finally {
      link.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid).toBe(process.pid);
    expect(fs.readdirSync(dir)).toEqual(['lifeline.lock']);
  });

  it('an unreadable lock is respected while young and replaced once old', () => {
    const lockPath = path.join(lockDir(), 'lifeline.lock');
    fs.writeFileSync(lockPath, '');
    expect(acquireLockFile(lockPath)).toBe(false);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    expect(acquireLockFile(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid).toBe(process.pid);
  });

  it.each(['null', '[]', '7'])('a lock holding %s counts as unreadable', (content) => {
    const lockPath = path.join(lockDir(), 'lifeline.lock');
    fs.writeFileSync(lockPath, content);
    expect(acquireLockFile(lockPath)).toBe(false);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    expect(acquireLockFile(lockPath)).toBe(true);
  });

  it('leaves no temporary files behind', () => {
    const dir = lockDir();
    const lockPath = path.join(dir, 'lifeline.lock');
    expect(acquireLockFile(lockPath)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(['lifeline.lock']);
  });
});
