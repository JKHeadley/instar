/**
 * The Local Verify waiting list (fb-7fde7f49-8ee): the PRs refused because the queue was
 * full, in the order they were FIRST refused, so a freed slot goes to the PR that has
 * waited longest instead of to whichever PR happens to ask next.
 *
 * Keyed by PR and bound to the offered revision (a moved head starts a new wait). Each waiter carries `firstRefusedAt`
 * (never reset while it waits; carried onto the queue entry when it is admitted, so the
 * wait outside the queue can be measured) and `lastOfferedAt` (the last time the PR was
 * offered to the queue and reached the capacity check).
 *
 * A waiter only holds its place while it keeps being offered: one not offered for
 * `staleAfterMs` of running, `main`-healthy time is STALE and reserves nothing, so a PR
 * that stops being eligible or stops being offered can never hold a slot empty. The
 * clock stops while `main` is unhealthy (the watcher offers nothing then) and across a
 * server stop (the saved file carries a heartbeat `savedAt`; downtime is added back on
 * load). Idle waiters remain durable. At capacity, new requests are refused explicitly.
 *
 * Machine-local, single writer (the LocalVerifyService of the lease holder), persisted
 * atomically at `state/local-verify/waiting.json`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isValidPr } from './record.js';

const MIN = 60_000;

export const WAITING_LIST_LIMITS = Object.freeze({
  /** Three default merge-watcher passes (10 min each): a waiter not offered for this long reserves nothing. */
  staleAfterMs: 30 * MIN,
  /** Bounded accumulation: new requests cannot displace existing ones. */
  maxWaiters: 200,
  /** Heartbeat write while the list is non-empty, so downtime can be told from idleness on load. */
  heartbeatMs: 5 * MIN,
  /** How often, and how many, waiters are checked for a closed or merged PR. */
  closedSweepEveryMs: 5 * MIN,
  closedSweepBatch: 5,
});

export interface WaitingHead {
  headSha: string;
  baseRefName: string;
}

export interface Waiter {
  head?: WaitingHead;
  explicit?: true;
  pr: number;
  /** First queue-full refusal of this PR in this wait. Never reset while it waits. */
  firstRefusedAt: number;
  /** Last time the PR was offered and reached the capacity check (refused or admitted). */
  lastOfferedAt: number;
  refusals: number;
}

interface WaitingFile {
  v: 1;
  savedAt: number;
  pausedSince: number | null;
  waiters: Waiter[];
}

export type WaiterRemoval = 'admitted' | 'closed' | 'recorded' | 'untrusted-head' | 'revision-changed' | 'held';

/** Oldest first: by firstRefusedAt, then PR number. */
export function waiterOrder(a: Waiter, b: Waiter): number {
  return (a.firstRefusedAt - b.firstRefusedAt) || (a.pr - b.pr);
}

export class WaitingList {
  private readonly waiters = new Map<number, Waiter>();
  /** Set while `main` is unhealthy: the waiting clock is stopped at this time. */
  private pausedSince: number | null = null;
  private lastJson: string | null = null;
  private lastWriteAt = 0;
  private sweepAt = 0;
  private sweepCursor = 0;
  private retryAfter: Waiter | null = null;
  private lastRetryAt = 0;

  constructor(
    private readonly file: string,
    private readonly now: () => number,
    private readonly audit: (e: Record<string, unknown>) => void,
  ) {}

  /** The clock the staleness rule reads: stopped while paused. */
  private clock(): number {
    return this.pausedSince ?? this.now();
  }

  isLive(w: Waiter): boolean {
    return this.clock() - w.lastOfferedAt <= WAITING_LIST_LIMITS.staleAfterMs;
  }

  get(pr: number): Waiter | null {
    return this.waiters.get(pr) ?? null;
  }

  size(): number {
    return this.waiters.size;
  }

  /** Oldest first, with liveness. */
  list(): Array<Waiter & { live: boolean }> {
    return [...this.waiters.values()].sort(waiterOrder).map((w) => ({ ...w, live: this.isLive(w) }));
  }

  /**
   * The live waiters ahead of `pr`: every live waiter refused before it (all live waiters
   * when `pr` is not waiting). Stale waiters are never ahead of anyone.
   */
  liveAhead(pr: number): Waiter[] {
    const mine = this.waiters.get(pr);
    return [...this.waiters.values()]
      .filter((w) => w.pr !== pr && this.isLive(w) && (!mine || waiterOrder(w, mine) < 0))
      .sort(waiterOrder);
  }

  /** A queue-full refusal: add the PR (keeping its first refusal time) and mark it offered. */
  refused(pr: number, head?: WaitingHead, explicit = false): Waiter | null {
    const now = this.now();
    const previous = this.waiters.get(pr);
    if (!this.hasRoom(pr)) return null;
    const revision = head ?? previous?.head;
    const previousHead = previous?.head;
    const sameRevision = !head || !previousHead
      || (previousHead.headSha === head.headSha && previousHead.baseRefName === head.baseRefName);
    const carried = sameRevision ? previous : undefined;
    const waiter: Waiter = {
      pr, firstRefusedAt: carried?.firstRefusedAt ?? now, lastOfferedAt: now,
      refusals: (carried?.refusals ?? 0) + 1,
      ...(revision ? { head: revision } : {}),
      ...(explicit || carried?.explicit ? { explicit: true as const } : {}),
    };
    this.waiters.set(pr, waiter);
    if (this.persist(true)) return waiter;
    if (previous) this.waiters.set(pr, previous);
    else this.waiters.delete(pr);
    return null;
  }

  bindHead(waiter: Waiter, head: WaitingHead): boolean {
    if (this.waiters.get(waiter.pr) !== waiter) return false;
    waiter.head = head;
    if (this.persist(true)) return true;
    delete waiter.head;
    return false;
  }

  retryBatch(): Waiter[] {
    const now = this.now();
    if (this.waiters.size === 0 || now - this.lastRetryAt < WAITING_LIST_LIMITS.closedSweepEveryMs) return [];
    this.lastRetryAt = now;
    const all = [...this.waiters.values()].sort(waiterOrder);
    const after = this.retryAfter;
    const start = after ? all.findIndex((waiter) => waiterOrder(waiter, after) > 0) : 0;
    return all.slice(Math.max(0, start), Math.max(0, start) + WAITING_LIST_LIMITS.closedSweepBatch);
  }

  noteRetry(waiter: Waiter | null): void {
    this.retryAfter = waiter;
  }

  hasRoom(pr: number): boolean {
    return this.waiters.has(pr) || this.waiters.size < WAITING_LIST_LIMITS.maxWaiters;
  }

  /**
   * Put a PR on the list without a refusal (spec local-verify-queue-controls.md): an operator
   * release that found the queue and its overflow full, or a held waiter put back. A PR that is
   * already waiting keeps its place and nothing changes. `head` places it before every other
   * waiter, so it takes the next free place; otherwise it gets `firstRefusedAt` as given.
   */
  put(pr: number, firstRefusedAt: number, opts: { head?: boolean; refusals?: number; revision?: WaitingHead; explicit?: true } = {}): Waiter | null {
    const existing = this.waiters.get(pr);
    if (existing) return existing;
    if (!this.hasRoom(pr)) return null;
    const now = this.now();
    let at = Math.min(firstRefusedAt, now);
    if (opts.head) for (const w of this.waiters.values()) at = Math.min(at, w.firstRefusedAt - 1);
    const waiter = { pr, head: opts.revision, explicit: opts.explicit, firstRefusedAt: at, lastOfferedAt: now, refusals: Math.max(1, opts.refusals ?? 1) };
    this.waiters.set(pr, waiter);
    if (this.persist(true)) return waiter;
    this.waiters.delete(pr);
    return null;
  }

  remove(pr: number, reason: WaiterRemoval): Waiter | null {
    const w = this.waiters.get(pr);
    if (!w) return null;
    this.waiters.delete(pr);
    this.audit({ event: 'waiter-removed', pr, reason, firstRefusedAt: w.firstRefusedAt, refusals: w.refusals, waitedMs: this.now() - w.firstRefusedAt });
    this.persist(true);
    return w;
  }

  /**
   * `main` health, read on every service tick. Unhealthy stops the waiting clock (nothing is
   * offered then); healthy again moves every waiter's last offer forward by the pause.
   */
  setHealthy(healthy: boolean): void {
    const now = this.now();
    if (!healthy && this.pausedSince === null) {
      this.pausedSince = now;
      this.persist(true);
    } else if (healthy && this.pausedSince !== null) {
      const paused = Math.max(0, now - this.pausedSince);
      // A waiter offered during the pause is as fresh as now (never stamped in the future).
      for (const w of this.waiters.values()) w.lastOfferedAt = Math.min(now, w.lastOfferedAt + paused);
      this.pausedSince = null;
      this.persist(true);
    }
  }

  /** Heartbeat the file while requests are waiting. */
  tick(): void {
    this.persist(false);
  }

  /**
   * The next few waiters to check for a closed or merged PR (bounded, rotating), or [] when
   * a sweep ran within `closedSweepEveryMs`.
   */
  sweepBatch(): number[] {
    const now = this.now();
    if (this.waiters.size === 0 || now - this.sweepAt < WAITING_LIST_LIMITS.closedSweepEveryMs) return [];
    this.sweepAt = now;
    const all = [...this.waiters.values()].sort(waiterOrder).map((w) => w.pr);
    const count = Math.min(WAITING_LIST_LIMITS.closedSweepBatch, all.length);
    const start = this.sweepCursor % all.length;
    this.sweepCursor = (start + count) % all.length;
    return Array.from({ length: count }, (_, n) => all[(start + n) % all.length]);
  }


  /** Atomic write. `changed` false = heartbeat only (written at most every heartbeatMs, and only while non-empty). */
  persist(changed: boolean): boolean {
    const now = this.now();
    if (!changed && (this.waiters.size === 0 || now - this.lastWriteAt < WAITING_LIST_LIMITS.heartbeatMs)) return true;
    const body: WaitingFile = { v: 1, savedAt: now, pausedSince: this.pausedSince, waiters: [...this.waiters.values()].sort(waiterOrder) };
    const json = JSON.stringify(body);
    if (json === this.lastJson) return true;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, json, { mode: 0o600 }); /* state-registry: local-verify-waiting */
      fs.renameSync(tmp, this.file);
      this.lastJson = json;
      this.lastWriteAt = now;
      return true;
    } catch (e) {
      this.audit({ event: 'waiting-persist-failed', detail: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  /**
   * Boot: read the saved list. Downtime (now − savedAt) is added back to every waiter's
   * last offer, so a restart neither revives a stale waiter nor ages a live one. A file that
   * cannot be parsed is moved aside and audited; the list then starts empty (today's behaviour).
   */
  load(): void {
    let text: string;
    try { text = fs.readFileSync(this.file, 'utf-8'); } catch { return; } // @silent-fallback-ok: no saved list (first boot, or never full)
    let o: Partial<WaitingFile> | null = null;
    try { o = JSON.parse(text) as Partial<WaitingFile>; } catch { o = null; }
    if (!o || o.v !== 1 || !Array.isArray(o.waiters) || !Number.isFinite(o.savedAt)) {
      const aside = `${this.file}.corrupt-${this.now()}`;
      try { fs.renameSync(this.file, aside); } catch { /* @silent-fallback-ok: audited below either way */ }
      this.audit({ event: 'waiting-restore-unreadable', movedTo: path.basename(aside), bytes: text.length });
      return;
    }
    const now = this.now();
    const downtime = Math.max(0, now - (o.savedAt as number));
    const valid = o.waiters.filter((x): x is Waiter => !!x && isValidPr(x.pr) && Number.isFinite(x.firstRefusedAt)
      && Number.isFinite(x.lastOfferedAt) && Number.isSafeInteger(x.refusals) && x.refusals > 0);
    this.waiters.clear();
    for (const w of valid) {
      if (this.waiters.has(w.pr)) continue;
      this.waiters.set(w.pr, { pr: w.pr, firstRefusedAt: w.firstRefusedAt, lastOfferedAt: Math.min(now, w.lastOfferedAt + downtime), refusals: w.refusals,
        ...(w.explicit === true ? { explicit: true as const } : {}),
        ...(typeof w.head?.headSha === 'string' && typeof w.head?.baseRefName === 'string' ? { head: w.head } : {}) });
    }
    this.pausedSince = Number.isFinite(o.pausedSince) ? Math.min(now, (o.pausedSince as number) + downtime) : null;
    this.audit({ event: 'waiting-restored', waiters: this.waiters.size, skipped: o.waiters.length - valid.length, downtimeMs: downtime });
    this.tick();
    this.persist(true);
  }
}
