import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';

const HOUR_MS = 60 * 60_000;
export const PUBLIC_PR_ATTEMPT_LIMIT = 8;
export const PUBLIC_PR_PAGE_LIMIT = 300;
export const PUBLIC_PR_AUTONOMOUS_RETRY_FLOOR_MS = 15_000;
export const PUBLIC_PR_WARMUP_BUDGET_FILE = 'public-pr-warmup-budget.json';

type BudgetRow = {
  version: 1;
  attempts: number[];
  pages: number[];
  outstanding: string[];
  retryNotBefore: number;
  lastObservedAt: number;
};

function validTimes(value: unknown, limit: number, last: number): value is number[] {
  return Array.isArray(value) && value.length <= limit && value.every((time, i) =>
    Number.isSafeInteger(time) && time >= 0 && time <= last && (i === 0 || time >= value[i - 1]));
}

function validOutstanding(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 2 && new Set(value).size === value.length
    && value.every(id => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id));
}

/** Plan a rolling-window charge before its caller commits the durable record. */
export function reservePublicPrTimestamp(times: readonly number[], wall: number, limit: number, minGapMs = 0): number[] | null {
  const retained = times.filter(at => at > wall - HOUR_MS);
  const last = retained.at(-1);
  if (retained.length >= limit || (last !== undefined && wall - last < minGapMs)) return null;
  return [...retained, wall];
}

/** Pre-provisioned by explicit installation enrollment. An absent file denies network work. */
export class PublicPrWarmupBudget {
  private readonly file: string;
  private readonly activePages = new Set<string>();
  private writeFailed = false;

  constructor(stateDir: string, private readonly lockHeld: () => boolean, private readonly now = Date.now) {
    this.file = path.join(stateDir, 'state', PUBLIC_PR_WARMUP_BUDGET_FILE);
  }

  read(): BudgetRow | null {
    try {
      if (this.writeFailed || !this.lockHeld()) return null;
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.size > 16_384) return null;
      const row = JSON.parse(fs.readFileSync(this.file, 'utf8')) as BudgetRow;
      if (row.version !== 1 || !Number.isSafeInteger(row.lastObservedAt) || row.lastObservedAt < 0
        || !Number.isSafeInteger(row.retryNotBefore) || row.retryNotBefore < 0
        || !validTimes(row.attempts, PUBLIC_PR_ATTEMPT_LIMIT, row.lastObservedAt)
        || !validTimes(row.pages, PUBLIC_PR_PAGE_LIMIT, row.lastObservedAt)
        || !validOutstanding(row.outstanding)) return null;
      return { version: 1, attempts: row.attempts, pages: row.pages, outstanding: row.outstanding,
        retryNotBefore: row.retryNotBefore, lastObservedAt: row.lastObservedAt };
    } catch {
      return null; // Missing or invalid operational budget fails closed.
    }
  }

  retryFloor(): number {
    const row = this.read();
    if (!row || row.outstanding.some(id => !this.activePages.has(id))) return Infinity;
    return Math.max(row.retryNotBefore, row.lastObservedAt);
  }

  reserveAttempt(autonomous = false): boolean {
    const row = this.reserve('attempts', autonomous ? PUBLIC_PR_AUTONOMOUS_RETRY_FLOOR_MS : 0);
    return row !== null && this.write(row);
  }

  reservePage(): string | null {
    const row = this.reserve('pages');
    if (!row || row.outstanding.length >= 2) return null;
    const id = randomUUID();
    row.outstanding.push(id);
    if (!this.write(row)) return null;
    this.activePages.add(id);
    return id;
  }

  settlePage(id: string, waitMs: number): boolean {
    const row = this.read();
    if (!row || !this.activePages.has(id) || !row.outstanding.includes(id)) return false;
    row.outstanding = row.outstanding.filter(outstanding => outstanding !== id);
    this.extendFloor(row, waitMs);
    if (!this.write(row)) return false;
    this.activePages.delete(id);
    return true;
  }

  private reserve(kind: 'attempts' | 'pages', minGapMs = 0): BudgetRow | null {
    const row = this.read();
    const wall = this.now();
    if (!row || row.outstanding.some(id => !this.activePages.has(id))
      || wall < row.lastObservedAt || wall < row.retryNotBefore) return null;
    const limit = kind === 'attempts' ? PUBLIC_PR_ATTEMPT_LIMIT : PUBLIC_PR_PAGE_LIMIT;
    const charged = reservePublicPrTimestamp(row[kind], wall, limit, minGapMs);
    if (!charged) return null;
    row[kind] = charged;
    row.lastObservedAt = wall;
    return row;
  }

  private extendFloor(row: BudgetRow, waitMs: number): void {
    row.lastObservedAt = Math.max(row.lastObservedAt, this.now());
    row.retryNotBefore = Math.max(row.retryNotBefore, row.lastObservedAt + waitMs);
  }

  private write(row: BudgetRow): boolean {
    try {
      if (!this.lockHeld()) return false;
      SafeFsExecutor.atomicWriteJsonSync(this.file, row, { operation: 'PublicPrWarmupBudget.record', mode: 0o600 });
      const directory = fs.openSync(path.dirname(this.file), 'r');
      try { fs.fsyncSync(directory); }
      finally { fs.closeSync(directory); }
      return true;
    } catch {
      this.writeFailed = true;
      return false; // No new scan or page can use an unrecorded reservation.
    }
  }
}
