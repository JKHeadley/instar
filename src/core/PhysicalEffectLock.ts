import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

export type PhysicalEffectLockFailure = 'provider-unavailable' | 'deadline-exceeded' | 'provider-failed';

export class PhysicalEffectLockError extends Error {
  constructor(public readonly code: PhysicalEffectLockFailure, message: string) {
    super(message);
    this.name = 'PhysicalEffectLockError';
  }
}

export interface PhysicalEffectLease {
  readonly scope: string;
  readonly ownerId: string;
  readonly epoch: number;
  readonly acquiredAt: number;
  readonly requiresReconciliation: boolean;
  assertHeld(): void;
  release(): Promise<void>;
}

export interface PhysicalEffectLockProvider {
  readonly name: string;
  readonly available: boolean;
  readonly unavailableReason?: string;
  acquire(scope: string, deadlineMs: number): Promise<PhysicalEffectLease>;
  acquireSync?(scope: string, deadlineMs: number): PhysicalEffectLeaseSync;
}

export interface PhysicalEffectLeaseSync extends Omit<PhysicalEffectLease, 'release'> {
  release(): void;
}

/** Public funnel used by physical composer/session effects. */
export class PhysicalEffectLock {
  constructor(private readonly provider: PhysicalEffectLockProvider) {}

  status(): { provider: string; available: boolean; reason?: string } {
    return {
      provider: this.provider.name,
      available: this.provider.available,
      ...(this.provider.unavailableReason ? { reason: this.provider.unavailableReason } : {}),
    };
  }

  async acquire(scope: string, deadlineMs: number): Promise<PhysicalEffectLease> {
    if (!this.provider.available) {
      throw new PhysicalEffectLockError(
        'provider-unavailable',
        this.provider.unavailableReason ?? `physical-effect lock provider ${this.provider.name} is unavailable`,
      );
    }
    if (!scope || !Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) {
      throw new PhysicalEffectLockError('deadline-exceeded', 'physical-effect lock deadline has elapsed');
    }
    return this.provider.acquire(scope, deadlineMs);
  }

  acquireSync(scope: string, deadlineMs: number): PhysicalEffectLeaseSync {
    if (!this.provider.available || !this.provider.acquireSync) {
      throw new PhysicalEffectLockError('provider-unavailable',
        this.provider.unavailableReason ?? `physical-effect lock provider ${this.provider.name} has no sync lane`);
    }
    if (!scope || !Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) {
      throw new PhysicalEffectLockError('deadline-exceeded', 'physical-effect lock deadline has elapsed');
    }
    return this.provider.acquireSync(scope, deadlineMs);
  }
}

interface OwnerRecord {
  ownerId: string;
  cleanRelease: boolean;
  epoch: number;
  acquiredAt: number;
}

const PYTHON_FLOCK_HELPER = String.raw`
import errno, fcntl, os, select, sys, time
p, deadline = sys.argv[1], float(sys.argv[2])
fd = os.open(p, os.O_RDWR | os.O_CREAT, 0o600)
os.chmod(p, 0o600)
while True:
  try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    sys.stdout.write("LOCKED\n"); sys.stdout.flush()
    break
  except OSError as e:
    if e.errno not in (errno.EACCES, errno.EAGAIN):
      sys.stderr.write(str(e)); sys.exit(3)
    if time.monotonic() >= deadline:
      sys.stdout.write("TIMEOUT\n"); sys.stdout.flush(); sys.exit(2)
    time.sleep(0.01)
while True:
  ready, _, _ = select.select([sys.stdin], [], [], 1.0)
  if ready:
    if not os.read(sys.stdin.fileno(), 1): break
fcntl.flock(fd, fcntl.LOCK_UN)
os.close(fd)
`;

/**
 * Kernel-backed flock provider for macOS and Linux.
 *
 * The helper owns the file descriptor so process death releases the kernel
 * lock. Files beside the lock are evidence only; they never grant ownership.
 */
export class UnixFlockProvider implements PhysicalEffectLockProvider {
  readonly name = 'unix-flock';
  readonly available: boolean;
  readonly unavailableReason?: string;
  private readonly pythonPath: string | null;
  private readonly lockDir: string;

  constructor(stateDir: string, options: { pythonPath?: string | null } = {}) {
    this.lockDir = path.join(stateDir, 'physical-effect-locks');
    this.pythonPath = options.pythonPath === undefined ? findPython3() : options.pythonPath;
    const supported = process.platform === 'darwin' || process.platform === 'linux';
    this.available = supported && this.pythonPath !== null;
    if (!supported) this.unavailableReason = `flock provider does not support ${process.platform}`;
    else if (!this.pythonPath) this.unavailableReason = 'python3 with fcntl support was not found';
  }

  async acquire(scope: string, deadlineMs: number): Promise<PhysicalEffectLease> {
    if (!this.available || !this.pythonPath) {
      throw new PhysicalEffectLockError('provider-unavailable', this.unavailableReason ?? 'flock unavailable');
    }
    if (deadlineMs <= Date.now()) {
      throw new PhysicalEffectLockError('deadline-exceeded', 'physical-effect lock deadline has elapsed');
    }
    fs.mkdirSync(this.lockDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.lockDir, 0o700); } catch { /* best effort on unusual filesystems */ }
    const stem = crypto.createHash('sha256').update(scope).digest('hex');
    const lockPath = path.join(this.lockDir, `${stem}.lock`);
    const epochPath = path.join(this.lockDir, `${stem}.epoch`);
    const ownerPath = path.join(this.lockDir, `${stem}.owner.json`);
    const remainingSeconds = Math.max(0, deadlineMs - Date.now()) / 1000;
    const monotonicDeadline = Number(process.hrtime.bigint()) / 1e9 + remainingSeconds;
    const helper = spawn(this.pythonPath, ['-c', PYTHON_FLOCK_HELPER, lockPath, String(monotonicDeadline)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await waitForLock(helper, Math.max(1, deadlineMs - Date.now()));

    let released = false;
    let helperExited = false;
    helper.once('exit', () => { helperExited = true; });
    const previous = readOwner(ownerPath);
    const epoch = incrementDurableEpoch(epochPath);
    const acquiredAt = Date.now();
    const ownerId = `${os.hostname()}:${process.pid}:${helper.pid ?? 'unknown'}:${crypto.randomUUID()}`;
    writeDurableJson(ownerPath, { ownerId, cleanRelease: false, epoch, acquiredAt });

    return {
      scope,
      ownerId,
      epoch,
      acquiredAt,
      requiresReconciliation: previous !== null && previous.cleanRelease !== true,
      assertHeld(): void {
        if (released || helperExited || helper.exitCode !== null) {
          throw new PhysicalEffectLockError('provider-failed', 'physical-effect kernel lock is no longer held');
        }
      },
      async release(): Promise<void> {
        if (released) return;
        if (!helperExited && helper.exitCode === null) {
          writeDurableJson(ownerPath, { ownerId, cleanRelease: true, epoch, acquiredAt });
          helper.stdin.end();
          await waitForExit(helper, 2_000);
        }
        released = true;
      },
    };
  }

  acquireSync(scope: string, deadlineMs: number): PhysicalEffectLeaseSync {
    if (!this.available || !this.pythonPath) {
      throw new PhysicalEffectLockError('provider-unavailable', this.unavailableReason ?? 'flock unavailable');
    }
    fs.mkdirSync(this.lockDir, { recursive: true, mode: 0o700 });
    const stem = crypto.createHash('sha256').update(scope).digest('hex');
    const lockPath = path.join(this.lockDir, `${stem}.lock`);
    const epochPath = path.join(this.lockDir, `${stem}.epoch`);
    const ownerPath = path.join(this.lockDir, `${stem}.owner.json`);
    const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
    const worker = new Worker(SYNC_FLOCK_WORKER, {
      eval: true,
      workerData: { signal: signal.buffer, pythonPath: this.pythonPath, helper: PYTHON_FLOCK_HELPER,
        lockPath, remainingMs: Math.max(1, deadlineMs - Date.now()) },
    });
    const wait = Atomics.wait(signal, 0, 0, Math.max(1, deadlineMs - Date.now()) + 100);
    const state = Atomics.load(signal, 0);
    if (wait === 'timed-out' || state !== 1) {
      void worker.terminate();
      throw new PhysicalEffectLockError(state === -2 ? 'deadline-exceeded' : 'provider-failed',
        state === -2 ? 'physical-effect lock deadline exceeded' : 'physical-effect lock worker failed');
    }
    const previous = readOwner(ownerPath);
    const epoch = incrementDurableEpoch(epochPath);
    const acquiredAt = Date.now();
    const ownerId = `${os.hostname()}:${process.pid}:worker:${crypto.randomUUID()}`;
    writeDurableJson(ownerPath, { ownerId, cleanRelease: false, epoch, acquiredAt });
    let released = false;
    return {
      scope, ownerId, epoch, acquiredAt,
      requiresReconciliation: previous !== null && previous.cleanRelease !== true,
      assertHeld(): void {
        if (released || Atomics.load(signal, 0) !== 1) {
          throw new PhysicalEffectLockError('provider-failed', 'physical-effect kernel lock is no longer held');
        }
      },
      release(): void {
        if (released) return;
        writeDurableJson(ownerPath, { ownerId, cleanRelease: true, epoch, acquiredAt });
        Atomics.store(signal, 1, 1);
        Atomics.notify(signal, 1);
        Atomics.wait(signal, 0, 1, 2_000);
        released = true;
        void worker.terminate();
      },
    };
  }
}

const SYNC_FLOCK_WORKER = String.raw`
const { workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const signal = new Int32Array(workerData.signal);
const remaining = workerData.remainingMs / 1000;
const deadline = Number(process.hrtime.bigint()) / 1e9 + remaining;
const child = spawn(workerData.pythonPath, ['-c', workerData.helper, workerData.lockPath, String(deadline)],
  { stdio: ['pipe', 'pipe', 'pipe'] });
let out = '';
const fail = (state) => { Atomics.store(signal, 0, state); Atomics.notify(signal, 0); };
child.stdout.on('data', (b) => {
  out += b.toString();
  if (out.includes('LOCKED\n')) {
    Atomics.store(signal, 0, 1); Atomics.notify(signal, 0);
    Atomics.wait(signal, 1, 0);
    child.stdin.end();
  } else if (out.includes('TIMEOUT\n')) fail(-2);
});
child.once('error', () => fail(-1));
child.once('exit', (code) => {
  if (!out.includes('LOCKED\n')) fail(code === 2 ? -2 : -1);
  else { Atomics.store(signal, 0, 2); Atomics.notify(signal, 0); }
});
`;

class UnavailableProvider implements PhysicalEffectLockProvider {
  readonly available = false;
  constructor(readonly name: string, readonly unavailableReason: string) {}
  acquire(): Promise<PhysicalEffectLease> {
    return Promise.reject(new PhysicalEffectLockError('provider-unavailable', this.unavailableReason));
  }
}

export function createPhysicalEffectLock(stateDir: string): PhysicalEffectLock {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    return new PhysicalEffectLock(new UnixFlockProvider(stateDir));
  }
  return new PhysicalEffectLock(new UnavailableProvider(
    process.platform === 'win32' ? 'windows-lockfileex' : 'unsupported',
    process.platform === 'win32'
      ? 'LockFileEx backend is not installed; Stage B must remain dark'
      : `no conforming physical-effect lock provider for ${process.platform}`,
  ));
}

function findPython3(): string | null {
  for (const candidate of ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3']) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* @silent-fallback-ok: probe the next explicit provider path */ }
  }
  return null;
}

function waitForLock(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new PhysicalEffectLockError('deadline-exceeded', 'physical-effect lock deadline exceeded'));
    }, timeoutMs + 50);
    const finish = (err?: Error) => {
      clearTimeout(timer);
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
      err ? reject(err) : resolve();
    };
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString();
      if (stdout.includes('LOCKED\n')) finish();
      else if (stdout.includes('TIMEOUT\n')) finish(new PhysicalEffectLockError('deadline-exceeded', 'physical-effect lock deadline exceeded'));
    });
    child.once('error', (err) => finish(new PhysicalEffectLockError('provider-failed', err.message)));
    child.once('exit', (code) => {
      if (!stdout.includes('LOCKED\n')) finish(new PhysicalEffectLockError(
        code === 2 ? 'deadline-exceeded' : 'provider-failed',
        stderr.trim() || `flock helper exited with code ${code}`,
      ));
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new PhysicalEffectLockError('provider-failed', 'flock helper did not release promptly'));
    }, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

function readOwner(filePath: string): OwnerRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<OwnerRecord>;
    if (typeof parsed.ownerId !== 'string' || typeof parsed.cleanRelease !== 'boolean' ||
        !Number.isSafeInteger(parsed.epoch) || typeof parsed.acquiredAt !== 'number') return null;
    return parsed as OwnerRecord;
  } catch { return null; }
}

function incrementDurableEpoch(filePath: string): number {
  let current = 0;
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed >= 0) current = parsed;
  } catch { /* first acquisition */ }
  if (current >= Number.MAX_SAFE_INTEGER) throw new PhysicalEffectLockError('provider-failed', 'physical-effect lock epoch exhausted');
  const next = current + 1;
  const fd = fs.openSync(filePath, 'w', 0o600);
  try { fs.writeFileSync(fd, `${next}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return next;
}

function writeDurableJson(filePath: string, value: OwnerRecord): void {
  const fd = fs.openSync(filePath, 'w', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
