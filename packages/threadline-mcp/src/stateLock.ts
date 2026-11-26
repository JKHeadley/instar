/**
 * One threadline-mcp per state directory owns pairing (Echo's review of #2192, SEC-5).
 *
 * Claude Desktop and every Claude Code session each start their own threadline-mcp, all on one
 * state directory and one identity. Without coordination they race on the pairing stores and the
 * relay. The owner holds `<stateDir>/threadline/owner.lock` (its pid, created exclusively); a lock
 * whose pid is no longer running is stale and is taken over. Only the owner pairs and writes
 * pairing state; the others refuse pairing and credentials and re-read
 * pins from disk for every message.
 *
 * Takeover is race-safe (Echo review of #2215, SHOULD-FIX 1): a stale lock is never deleted in place.
 * It is renamed atomically to a unique name, the renamed file is re-read, and only if it still names
 * the dead holder is it discarded; otherwise (another instance took over in between) it is put back
 * and that instance owns pairing. A lock is created with its content in one step (write a temp file,
 * then hard-link it into place, which fails if a lock exists), so a lock is never seen half-written.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export interface StateLock {
  held: boolean;
  holderPid: number | null;
  release(): void;
  /** The owner records the app it serves (the MCP client's name), so a refusal can name the app, never a pid. */
  setApp(name: string): void;
  /** The app named by the current owner, read fresh from the lock, or null. */
  holderApp(): string | null;
  /** True while the lock file on disk still names this instance (false once it was replaced or removed). */
  stillHeld(): boolean;
}

/**
 * Lock file format: the pid on the first line, optionally the app's name on the second. A lock that holds
 * only a pid (threadline-mcp 0.5.x) is still read, and a 0.5.x reader's parseInt still finds the pid.
 */
export function parseLock(text: string): { pid: number | null; app: string | null } {
  const [first, ...rest] = text.split('\n');
  const pid = Number.parseInt(first.trim(), 10);
  const app = rest.join(' ').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100);
  return { pid: Number.isInteger(pid) && pid > 0 ? pid : null, app: app || null };
}
const clean = (name: string) => name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100);

/**
 * What a person calls the app, from the MCP client name it sent at initialize (case-insensitive
 * substring match). Unknown names are kept as sent; an empty name is "another app".
 */
export function friendlyAppName(raw: string | null | undefined): string {
  const n = clean(String(raw ?? ''));
  const l = n.toLowerCase();
  if (l.includes('claude-ai')) return 'Claude Desktop';
  if (l.includes('claude-code')) return 'Claude Code';
  if (l.includes('cursor')) return 'Cursor';
  if (l.includes('visual studio code') || l.includes('vscode')) return 'VS Code';
  if (l.includes('codex') || l.includes('chatgpt')) return 'the ChatGPT app';
  if (l.includes('goose')) return 'Goose';
  return n || 'another app';
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

/** A lock this old whose pid now belongs to a process started after the lock was written is a reused pid. */
export const PID_REUSE_AGE_MS = 24 * 60 * 60_000;

function processStartMs(pid: number): number | null {
  if (process.platform === 'win32') return null;
  try {
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 });
    const t = Date.parse(String(r.stdout || '').trim());
    return Number.isNaN(t) ? null : t;
  } catch { return null; }
}

/**
 * Is the lock's holder still the process that wrote it? A dead pid is stale. A live pid is stale only
 * when the lock is older than a day AND that pid's process started after the lock was written (the
 * pid was reused by an unrelated process). If the start time cannot be read, a live pid counts as alive.
 */
function holderAlive(pid: number, lockMtimeMs: number, now = Date.now()): boolean {
  if (!alive(pid)) return false;
  if (now - lockMtimeMs < PID_REUSE_AGE_MS) return true;
  const started = processStartMs(pid);
  return started === null || started <= lockMtimeMs + 1_000;
}

/** Test hooks for the race-safety tests: called at the moments a racing instance could act. */
export interface LockHooks { beforeRetire?: () => void; now?: () => number }

/** Create `file` with `content` only if it does not exist, in one step (temp file + hard link). */
function createWithContent(file: string, content: string): boolean {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
  }
}

/** How long an empty (pid-less) lock is treated as one still being written. */
export const EMPTY_LOCK_GRACE_MS = 5_000;

const readLock = (file: string) => { try { return { ...parseLock(fs.readFileSync(file, 'utf8')), mtimeMs: fs.statSync(file).mtimeMs }; } catch { return null; } };

export function acquireStateLock(stateDir: string, pid = process.pid, hooks: LockHooks = {}): StateLock {
  const file = path.join(stateDir, 'threadline', 'owner.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (createWithContent(file, String(pid))) return heldLock(file, pid);
    const cur = readLock(file);
    if (!cur) continue; // removed in between: try to create again
    if (cur.pid === pid) return heldLock(file, pid); // already ours (e.g. a re-acquire)
    if (cur.pid !== null && holderAlive(cur.pid, cur.mtimeMs, hooks.now?.())) return notHeldLock(file, cur.pid);
    // A 0.5.x owner creates its lock empty and writes the pid just after; an empty lock that young is
    // being written, not abandoned (Echo, #2215 note 2: otherwise a 0.6 instance retires a live 0.5 lock).
    if (cur.pid === null && (hooks.now?.() ?? Date.now()) - cur.mtimeMs < EMPTY_LOCK_GRACE_MS) return notHeldLock(file, null);
    // Stale (dead holder, reused pid, or unreadable). Retire it without ever deleting a live lock.
    hooks.beforeRetire?.();
    const stale = `${file}.stale-${pid}-${crypto.randomBytes(6).toString('hex')}`;
    try { fs.renameSync(file, stale); } catch { continue; } // someone else retired it first
    const moved = readLock(stale);
    if (!moved || moved.pid !== cur.pid) {
      // Between our read and our rename another instance took over: what we moved is ITS live lock.
      // Put it back (link fails if yet another lock appeared meanwhile; that one then stands) and yield.
      try { fs.linkSync(stale, file); } catch { /* another lock is in place */ }
      try { fs.unlinkSync(stale); } catch { /* gone */ }
      const now = readLock(file);
      return notHeldLock(file, now?.pid ?? moved?.pid ?? null);
    }
    try { fs.unlinkSync(stale); } catch { /* gone */ }
  }
  return notHeldLock(file, readLock(file)?.pid ?? null);
}

function heldLock(file: string, pid: number): StateLock {
  const ours = () => readLock(file)?.pid === pid;
  return {
    held: true, holderPid: pid,
    release: () => { try { if (ours()) fs.unlinkSync(file); } catch { /* gone */ } },
    setApp: (name: string) => {
      const n = clean(name);
      if (!n || !ours()) return;
      const tmp = `${file}.${pid}.tmp`;
      try { fs.writeFileSync(tmp, `${pid}\n${n}`, { mode: 0o600 }); fs.renameSync(tmp, file); } catch { try { fs.unlinkSync(tmp); } catch { /* none */ } }
    },
    holderApp: () => readLock(file)?.app ?? null,
    stillHeld: ours,
  };
}

function notHeldLock(file: string, holderPid: number | null): StateLock {
  return { held: false, holderPid, release: () => {}, setApp: () => {}, holderApp: () => readLock(file)?.app ?? null, stillHeld: () => false };
}

/**
 * Pairing ownership for one threadline-mcp, kept current. `owns()` is true only while the lock on disk
 * still names this instance (a replaced lock stops it acting as owner). `ensure()` makes one attempt to
 * take over when it does not own pairing (the owner exited), and calls `onAcquired` when it does.
 */
export class PairingOwnership {
  private lock: StateLock;
  private app = '';
  /** Called when this instance takes ownership after startup (re-read the pairing stores). */
  onAcquired: (() => void) | null = null;

  constructor(private readonly stateDir: string, private readonly pid = process.pid, private readonly log: (m: string) => void = () => {}, private readonly hooks: LockHooks = {}) {
    this.lock = acquireStateLock(stateDir, pid, hooks);
  }

  get holderPid(): number | null { return this.lock.holderPid; }
  holderApp(): string | null { return this.lock.holderApp(); }
  setApp(name: string): void { this.app = name; this.lock.setApp(name); }
  release(): void { this.lock.release(); }

  owns(): boolean {
    if (!this.lock.held) return false;
    if (this.lock.stillHeld()) return true;
    const file = path.join(this.stateDir, 'threadline', 'owner.lock');
    this.lock = notHeldLock(file, readLock(file)?.pid ?? null);
    this.log('The pairing lock no longer names this instance; it stops acting as the pairing owner.');
    return false;
  }

  ensure(): boolean {
    if (this.owns()) return true;
    const next = acquireStateLock(this.stateDir, this.pid, this.hooks);
    this.lock = next;
    if (!next.held) return false;
    if (this.app) next.setApp(this.app);
    this.log('The previous pairing owner exited; this instance now owns pairing.');
    this.onAcquired?.();
    return true;
  }
}
