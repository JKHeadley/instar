/**
 * UsagePoolPuller — the lease holder's pull of every peer's usage rollups
 * (docs/specs/unified-usage-ledger.md, Slice 4: Pool view).
 *
 * Each machine serves `GET /usage/rollup?after=<change_seq>`; the holder applies each
 * page into its pooled copy and advances the peer's cursor only after the page commits.
 * Cadence and brakes: a background pull every 5 minutes; a read that finds a peer older
 * than 60 s triggers a single-flight background pull (the read returns cached data at
 * once). Per-peer exponential backoff up to 30 minutes; after 3 consecutive failures the
 * peer shows `not-reached` with the reason. Pages drain with a yield between them.
 *
 * Tier 0: pure data movement, no LLM, no outward action beyond the pool's own reads.
 */

import type { UsageLedger, ExportPage } from './UsageLedger.js';

export type PeerPullState = 'ok' | 'warming' | 'not-reached';

export interface PeerPullStatus {
  machineId: string;
  state: PeerPullState;
  lastPullAt: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  nextAttemptAt: number;
}

export interface UsagePoolPullerOptions {
  ledger: UsageLedger;
  /** Every OTHER live pool machine. */
  peers: () => Array<{ machineId: string }>;
  /** GET a path on a peer, returning parsed JSON or throwing. */
  fetchPeer: (machineId: string, path: string) => Promise<unknown>;
  /** Is this machine the lease holder right now? Only the holder pulls. */
  isHolder: () => boolean;
  now?: () => number;
  intervalMs?: number;
  staleMs?: number;
  maxBackoffMs?: number;
  failuresBeforeNotReached?: number;
  maxPagesPerPull?: number;
}

const BASE_BACKOFF_MS = 60_000;

export class UsagePoolPuller {
  private readonly o: Required<UsagePoolPullerOptions>;
  private readonly status = new Map<string, PeerPullStatus>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private wasHolder = false;

  constructor(opts: UsagePoolPullerOptions) {
    this.o = {
      now: () => Date.now(),
      intervalMs: 5 * 60_000,
      staleMs: 60_000,
      maxBackoffMs: 30 * 60_000,
      failuresBeforeNotReached: 3,
      maxPagesPerPull: 200,
      ...opts,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.pullAll(); }, this.o.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Pull every peer that is due. On becoming holder, every peer is pulled eagerly (shown warming until it answers). */
  async pullAll(): Promise<void> {
    if (!this.o.isHolder()) { this.wasHolder = false; return; }
    const eager = !this.wasHolder;
    this.wasHolder = true;
    const peers = this.o.peers();
    await Promise.all(peers.map(p => {
      const st = this.status.get(p.machineId);
      if (eager && st) st.state = st.state === 'not-reached' ? st.state : 'warming';
      if (!eager && st && st.nextAttemptAt > this.o.now()) return Promise.resolve();
      return this.pullPeer(p.machineId);
    }));
  }

  /** A read found a peer's data older than the stale window: pull it in the background (single-flight). */
  touch(): void {
    if (!this.o.isHolder()) return;
    const now = this.o.now();
    for (const p of this.o.peers()) {
      const st = this.status.get(p.machineId);
      if (st && (st.nextAttemptAt > now || (st.lastPullAt != null && now - st.lastPullAt < this.o.staleMs))) continue;
      void this.pullPeer(p.machineId);
    }
  }

  pullPeer(machineId: string): Promise<void> {
    const cur = this.inFlight.get(machineId);
    if (cur) return cur;
    const run = this.drain(machineId).finally(() => this.inFlight.delete(machineId));
    this.inFlight.set(machineId, run);
    return run;
  }

  private async drain(machineId: string): Promise<void> {
    const st = this.status.get(machineId) ?? {
      machineId, state: 'warming' as PeerPullState, lastPullAt: null, consecutiveFailures: 0, lastError: null, nextAttemptAt: 0,
    };
    this.status.set(machineId, st);
    try {
      for (let i = 0; i < this.o.maxPagesPerPull; i++) {
        const cursor = this.o.ledger.peerCursors().find(c => c.machineId === machineId);
        const after = cursor?.lastSeq ?? 0;
        const page = await this.o.fetchPeer(machineId, `/usage/rollup?after=${after}`) as ExportPage;
        if (!page || typeof page !== 'object' || !Array.isArray(page.rows) || typeof page.generationId !== 'string') {
          throw new Error('the peer answered with something that is not a usage page');
        }
        // A peer may only write rows under its own machine id (validated per row as well).
        if (page.machineId !== machineId) throw new Error('the peer answered for a different machine');
        const r = this.o.ledger.applyPeerPage(machineId, page);
        if (!r.reset && !page.more) break;
        await new Promise<void>(res => setImmediate(res));
      }
      const cursor = this.o.ledger.peerCursors().find(c => c.machineId === machineId);
      st.state = cursor?.warming ? 'warming' : 'ok';
      st.lastPullAt = this.o.now();
      st.consecutiveFailures = 0;
      st.lastError = null;
      st.nextAttemptAt = 0;
    } catch (err) { /* @silent-fallback-ok: a peer that does not answer is named not-reached in every read, never shown as zero */
      st.consecutiveFailures++;
      st.lastError = err instanceof Error ? err.message : String(err);
      if (st.consecutiveFailures >= this.o.failuresBeforeNotReached) st.state = 'not-reached';
      const backoff = Math.min(this.o.maxBackoffMs, BASE_BACKOFF_MS * 2 ** (st.consecutiveFailures - 1));
      st.nextAttemptAt = this.o.now() + backoff;
    }
  }

  /** Per-peer status for every live peer (a peer never pulled yet shows warming). */
  peerStatus(): PeerPullStatus[] {
    return this.o.peers().map(p => this.status.get(p.machineId) ?? {
      machineId: p.machineId, state: 'warming' as PeerPullState, lastPullAt: null, consecutiveFailures: 0, lastError: null, nextAttemptAt: 0,
    });
  }
}
