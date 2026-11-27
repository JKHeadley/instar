/** Durable failed-code lockouts; restarting the grant authority does not clear them. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import lockfile from 'proper-lockfile';

export interface RemoteStepUpLockoutPort {
  get(key: string): number;
  set(key: string, untilMs: number): void;
  recordFailure(key: string, nowMs: number): { attempts: number; lockedUntilMs: number };
}

interface AttemptRecord { attempts: number; windowStartMs: number; lockedUntilMs: number }

export class FileRemoteStepUpLockouts implements RemoteStepUpLockoutPort {
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'state', 'remote-stepup-lockouts.json');
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.file)) {
      try { fs.writeFileSync(this.file, '{}', { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    fs.chmodSync(this.file, 0o600);
    this.read();
  }

  private key(raw: string): string {
    if (typeof raw !== 'string' || raw.length < 3 || raw.length > 200) throw new Error('invalid step-up lockout key');
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  private read(): Record<string, AttemptRecord> {
    if (fs.statSync(this.file).size > 1024 * 1024) throw new Error('step-up lockout store capacity exceeded');
    const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid step-up lockout store');
    const rawRows = parsed as Record<string, number | AttemptRecord>;
    if (Object.keys(rawRows).length > 10_000 || Object.entries(rawRows).some(([key, row]) =>
      !/^[0-9a-f]{64}$/.test(key) || (typeof row !== 'number' &&
        (!row || !Number.isSafeInteger(row.attempts) || row.attempts < 0 || row.attempts > 3 ||
          !Number.isSafeInteger(row.windowStartMs) || row.windowStartMs < 0 ||
          !Number.isSafeInteger(row.lockedUntilMs) || row.lockedUntilMs < 0)) ||
        (typeof row === 'number' && (!Number.isSafeInteger(row) || row < 0)))) {
      throw new Error('invalid step-up lockout record');
    }
    return Object.fromEntries(Object.entries(rawRows).map(([key, row]) => [key,
      typeof row === 'number' ? { attempts: 3, windowStartMs: 0, lockedUntilMs: row } : row]));
  }

  get(key: string): number { return this.read()[this.key(key)]?.lockedUntilMs ?? 0; }

  recordFailure(key: string, nowMs: number): { attempts: number; lockedUntilMs: number } {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('invalid step-up attempt time');
    const release = lockfile.lockSync(this.file, { stale: 10_000 });
    try {
      const rows = this.read();
      const id = this.key(key);
      const previous = rows[id];
      if (previous && nowMs < previous.windowStartMs) throw new Error('step-up attempt clock moved backwards');
      const active = previous && nowMs >= previous.windowStartMs && nowMs - previous.windowStartMs < 15 * 60_000;
      const attempts = active ? Math.min(3, previous.attempts + 1) : 1;
      const lockedUntilMs = attempts >= 3 ? Math.max(previous?.lockedUntilMs ?? 0, nowMs + 15 * 60_000) : 0;
      rows[id] = { attempts, windowStartMs: active ? previous.windowStartMs : nowMs, lockedUntilMs };
      this.write(rows);
      return { attempts, lockedUntilMs };
    } finally { release(); }
  }

  set(key: string, untilMs: number): void {
    if (!Number.isSafeInteger(untilMs) || untilMs <= 0) throw new Error('invalid step-up lockout deadline');
    const release = lockfile.lockSync(this.file, { stale: 10_000 });
    try {
      const rows = this.read();
      const id = this.key(key);
      rows[id] = { attempts: 3, windowStartMs: Date.now(), lockedUntilMs: Math.max(rows[id]?.lockedUntilMs ?? 0, untilMs) };
      this.write(rows);
    } finally { release(); }
  }

  private write(rows: Record<string, AttemptRecord>): void {
    if (Object.keys(rows).length > 10_000) throw new Error('step-up lockout store capacity exceeded');
    const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(rows)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
    const dir = fs.openSync(path.dirname(this.file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
}
