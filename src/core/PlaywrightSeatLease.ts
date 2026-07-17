/**
 * Host-wide lease for the physical Playwright operator seat.
 *
 * The browser's default user-data directory is shared by MCP processes on one
 * host, including processes launched from different agent homes. Therefore the
 * lease file lives under ~/.instar/state, not in an agent's project state.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';

// Ten minutes exceeds the browser/tool execution ceilings used by Instar's MCP
// surfaces while remaining self-recovering after a crashed session.
export const PLAYWRIGHT_SEAT_LEASE_TTL_MS = 10 * 60_000;
const LOCK_WAIT_MS = 2_000;

export interface PlaywrightSeatLeaseRecord {
  holderId: string;
  holderLabel: string;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
}

export type PlaywrightSeatLeaseResult =
  | { acquired: true; lease: PlaywrightSeatLeaseRecord }
  | { acquired: false; holderLabel: string; retryAfterMs: number; expiresAt: string };

export interface PlaywrightSeatLeaseOptions {
  filePath?: string;
  now?: () => number;
  ttlMs?: number;
}

/**
 * Serializes access to the host's single logged-in Playwright browser profile.
 * Same-session calls renew the lease; conflicting live holders receive a
 * bounded retry interval, and expired holders are reclaimed automatically.
 */
export class PlaywrightSeatLease {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: PlaywrightSeatLeaseOptions = {}) {
    this.filePath = options.filePath ?? path.join(os.homedir(), '.instar', 'state', 'playwright-seat-lease.json');
    this.lockPath = `${this.filePath}.lock`;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? PLAYWRIGHT_SEAT_LEASE_TTL_MS;
  }

  acquire(holderId: string, holderLabel: string): PlaywrightSeatLeaseResult {
    const id = clamp(holderId, 256);
    if (!id) throw new Error('holderId is required');
    const label = clamp(holderLabel, 128) || 'another active browser drive';

    return this.withLock(() => {
      const now = this.now();
      const current = this.read();
      const currentExpiry = current ? Date.parse(current.expiresAt) : 0;
      if (current && current.holderId !== id && Number.isFinite(currentExpiry) && currentExpiry > now) {
        return {
          acquired: false,
          holderLabel: current.holderLabel,
          retryAfterMs: Math.max(1, currentExpiry - now),
          expiresAt: current.expiresAt,
        };
      }

      const renewedAt = new Date(now).toISOString();
      const lease: PlaywrightSeatLeaseRecord = {
        holderId: id,
        holderLabel: label,
        acquiredAt: current?.holderId === id ? current.acquiredAt : renewedAt,
        renewedAt,
        expiresAt: new Date(now + this.ttlMs).toISOString(),
      };
      this.persist(lease);
      return { acquired: true, lease };
    });
  }

  private read(): PlaywrightSeatLeaseRecord | null {
    if (!fs.existsSync(this.filePath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<PlaywrightSeatLeaseRecord>;
      if (
        typeof parsed.holderId === 'string' &&
        typeof parsed.holderLabel === 'string' &&
        typeof parsed.acquiredAt === 'string' &&
        typeof parsed.renewedAt === 'string' &&
        typeof parsed.expiresAt === 'string'
      ) return parsed as PlaywrightSeatLeaseRecord;
    } catch { /* corrupt state is treated as expired and replaced under the lock */ }
    return null;
  }

  private persist(record: PlaywrightSeatLeaseRecord): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  private withLock<T>(fn: () => T): T {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      let fd: number | undefined;
      try {
        fd = fs.openSync(this.lockPath, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: this.now() }));
        fs.closeSync(fd);
        fd = undefined;
        try { return fn(); } finally {
          try { SafeFsExecutor.safeUnlinkSync(this.lockPath, { operation: 'PlaywrightSeatLease lock release' }); } catch { /* best effort */ }
        }
      } catch (error) {
        if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) {
          try {
            const age = Date.now() - fs.statSync(this.lockPath).mtimeMs;
            if (age >= LOCK_WAIT_MS) {
              SafeFsExecutor.safeUnlinkSync(this.lockPath, { operation: 'PlaywrightSeatLease stale-lock reclaim' });
            }
          } catch { /* another contender may have released it */ }
          if (Date.now() >= deadline + LOCK_WAIT_MS) throw new Error('playwright seat lease lock unavailable');
        }
      }
    }
  }
}

function clamp(value: string, max: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max)
    : '';
}
