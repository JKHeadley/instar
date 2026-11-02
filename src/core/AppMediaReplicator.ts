/**
 * AppMediaReplicator — copying app media between the agent's machines
 * (docs/specs/mobile-native-chat-media.md §4.12, the rest of increment 1).
 *
 * Metadata (`media-message`, `purge`, … events) already replicates with the `appConversations`
 * store kind. The bytes do not: every machine pulls every unpurged blob an event it holds
 * references, through the `app-media-pull` mesh verb (the same signed, recipient-bound MeshRpc
 * transport `working-set-pull` rides; its own code).
 *
 *   serve  — answers a registered peer: a ≤ 1 MiB slice of a blob an unpurged local event
 *            references (async positional reads, O_NOFOLLOW + inode check, never a re-hash),
 *            this machine's inventory (full sorted pages, or a diff against a version the peer
 *            already has), or a nudge (the peer asks this machine to pull hashes it lacks).
 *   pull   — a 5 s tick, at most 8 slices per tick, lowest priority; paused below the disk floor,
 *            paused for at most an hour at a time while the load verdict is saturated/impaired
 *            (then one slice per tick until it clears). Slices land in `pulls/<sha>.part`; a
 *            complete file is hashed in a worker and kept ONLY if length and SHA-256 equal the
 *            referencing event's.
 *   blame  — a partial copy comes from ONE peer: the peer that served offset 0 serves every later
 *            slice of it; if that peer stops answering, the partial copy is discarded and the
 *            file restarts from another peer. So a failed whole-file hash is blamed on exactly
 *            the one peer whose bytes it was. A serving peer re-hashes a blob whose size or
 *            mtime changed since its last check and quarantines it locally instead of serving it.
 *   brakes — per blob: exponential backoff 30 s → 1 h; after 7 days with no peer able to serve
 *            it the blob is `unrecoverable` (one notice per machine) until a new event or a peer
 *            inventory names a holder. Per peer: 5 consecutive verification failures open its
 *            breaker for 15 minutes; 3 opens in a day keep it open until the next day (one notice).
 *   copies — hourly peer inventories; `singleCopyBlobs` counts held, unpurged blobs no peer
 *            inventory younger than 2 hours lists (null, never 0, when that cannot be measured),
 *            with the alarm ladder of §4.12.
 *
 * Nothing here decides by content: hashes, sizes, fixed limits and the existing load verdict.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import type { AppMediaStore } from './AppMediaStore.js';
import type { AppConversationStore } from './AppConversationStore.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { hashFile } from './appMediaWorker.js';
import { isSha256Hex } from './appMediaTypes.js';

export const APP_MEDIA_SLICE_BYTES = 1024 * 1024;
export const MAX_SERVES_AT_ONCE = 2;
export const PULL_TICK_MS = 5_000;
export const SLICES_PER_TICK = 8;
export const LOAD_PAUSE_MAX_MS = 60 * 60_000;
export const BACKOFF_MIN_MS = 30_000;
export const BACKOFF_MAX_MS = 60 * 60_000;
export const GIVE_UP_MS = 7 * 24 * 60 * 60_000;
export const PEER_FAILURES_TO_OPEN = 5;
export const PEER_OPEN_MS = 15 * 60_000;
export const PEER_OPENS_TO_LATCH = 3;
export const INVENTORY_EVERY_MS = 60 * 60_000;
export const INVENTORY_FRESH_MS = 2 * 60 * 60_000;
export const INVENTORY_PAGE = 5_000;
export const INVENTORY_MAX_PAGES = 50;
export const NUDGE_MAX = 500;
export const SINGLE_COPY_GRACE_MS = 60 * 60_000;
export const SINGLE_COPY_OFFLINE_MS = 24 * 60 * 60_000;
export const UNMEASURABLE_ALARM_MS = 2 * 60 * 60_000;
/** The owner waits this long for missing blobs before dispatching with "still copying" (§4.12). */
export const OWNER_PULL_WAIT_MS = 60_000;
/** A "still copying" row older than this becomes a "could not be copied" line. */
export const PENDING_DELIVERY_TTL_MS = 7 * 24 * 60 * 60_000;
/** The app-media-path helper waits this long for a pull (§4.5). */
export const MEDIA_PATH_WAIT_MS = 30_000;
const WANTED_REFRESH_MS = 60_000;
const OWN_INVENTORY_REUSE_MS = 5 * 60_000;
const SLICE_TIMEOUT_MS = 20_000;
const INVENTORY_TIMEOUT_MS = 20_000;
const OP = 'src/core/AppMediaReplicator.ts';

/** The mesh verb. One verb, three operations, all read/observe class. */
export type AppMediaPullCommand = {
  type: 'app-media-pull';
  op: 'slice' | 'inventory' | 'nudge';
  sha256?: string;
  offset?: number;
  /** inventory: the version the asker already holds (answer `unchanged` or a diff). */
  since?: string;
  /** inventory: page cursor (hashes strictly after this one). */
  after?: string;
  /** nudge: hashes the asker holds alone. */
  hashes?: string[];
};

export type SliceAnswer = { ok: true; size: number; offset: number; dataB64: string } | { ok: false; reason: string };
export type InventoryAnswer =
  | { ok: true; version: string; unchanged: true }
  | { ok: true; version: string; diff: { added: string[]; removed: string[] } }
  | { ok: true; version: string; full: true; hashes: string[]; next: string | null }
  | { ok: false; reason: string };

export interface MeshSendResult { ok: boolean; status?: number; result?: unknown; reason?: string }

export interface AppMediaTransport {
  /** Every registered peer (never this machine); `online: null` when unknown. */
  peers: () => Array<{ machineId: string; nickname?: string; online: boolean | null }>;
  send: (machineId: string, command: AppMediaPullCommand, timeoutMs: number) => Promise<MeshSendResult>;
  /** This machine's load verdict (trustworthy-machine-load); absent ⇒ never paused for load. */
  loadVerdict?: () => string;
}

export interface AppMediaReplicatorDeps {
  media: AppMediaStore;
  store: AppConversationStore;
  selfId: () => string;
  now?: () => number;
  report?: (detail: string) => void;
  raiseAttention?: (item: { conditionKey: string; title: string; body: string }) => void;
  clearAttention?: (conditionKey: string) => void;
  /** A blob landed on this machine (pending "still copying" rows resolve here). */
  onBlobLanded?: (sha: string) => void;
}

interface PullRow { sha256: string; firstWantedAt: number; attempts: number; nextAttemptAt: number; lastServedAt: number | null; unrecoverable: number; lastError: string | null }
interface PeerInventory { version: string; set: Set<string>; at: number }

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const versionOf = (hashes: readonly string[]) => crypto.createHash('sha256').update(hashes.join('\n')).digest('hex');

export class AppMediaReplicator {
  private transport: AppMediaTransport | null = null;
  private readonly now: () => number;
  private readonly db: BetterSqliteDatabase;
  private serving = 0;
  private ticking = false;
  private wanted: string[] = [];
  private wantedAt = 0;
  private wantedDirty = true;
  /** On-demand pulls (a download, app-media-path, an owner dispatch) go first and ignore the load pause. */
  private readonly priority = new Set<string>();
  private readonly waiters = new Map<string, Array<(landed: boolean) => void>>();
  private readonly peerCursor = new Map<string, number>();
  /** The one peer each partial copy comes from (§ blame, above). In memory: after a restart a part with no known source is restarted. */
  private readonly partPeer = new Map<string, string>();
  /** When an on-demand ask or a nudge last skipped this file's backoff (at most once per backoff window). */
  private readonly lastHurryAt = new Map<string, number>();
  private readonly peerInventories = new Map<string, PeerInventory>();
  private ownInventories: Array<{ version: string; hashes: string[]; set: Set<string>; at: number }> = [];
  private loadPausedSince: number | null = null;
  private lastInventoryRound = 0;
  private inventoryRunning = false;
  // Alarm state (§4.12): when the count first went above 0, when peers were nudged, when it went null.
  private singleSince: number | null = null;
  private nudgedAt: number | null = null;
  private unmeasurableSince: number | null = null;
  /** First time each held hash was seen held alone (the 24 h offline-peer rule). */
  private readonly singleFirstSeen = new Map<string, number>();
  /* @self-action-controller: app-media-replication */
  /** Notice latch: one notice per condition episode, re-armed only when the condition clears. */
  private readonly raised = new Map<string, string>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  readonly counters = { slicesServed: 0, slicesPulled: 0, blobsLanded: 0, verifyFailures: 0, busyRefusals: 0, nudgesSent: 0 };

  constructor(private readonly d: AppMediaReplicatorDeps) {
    this.now = d.now ?? Date.now;
    this.db = d.media.indexDb;
    d.media.setReplicationHealth(() => ({ unrecoverableBlobs: this.unrecoverableCount(), singleCopyBlobs: this.singleCopy().count }));
  }

  attachTransport(t: AppMediaTransport | null): void { this.transport = t; this.wantedDirty = true; }
  hasTransport(): boolean { return this.transport !== null; }

  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => { void this.tick(); }, PULL_TICK_MS);
    this.tickTimer.unref?.();
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const [sha, ws] of this.waiters) { for (const w of ws) w(false); this.waiters.delete(sha); }
  }

  private report(detail: string): void { try { this.d.report?.(detail); } catch { /* @silent-fallback-ok — reporting never fails the copier */ } }

  /** New events landed (replication or a local send): the wanted list is recomputed on the next tick. */
  markWantedDirty(hashes?: readonly string[]): void {
    this.wantedDirty = true;
    // A new event naming an unrecoverable hash re-arms it (§4.12).
    for (const h of hashes ?? []) this.rearm(h);
  }

  private rearm(sha: string): void {
    this.db.prepare('UPDATE pulls SET unrecoverable = 0, attempts = 0, nextAttemptAt = 0, lastServedAt = ? WHERE sha256 = ? AND unrecoverable = 1').run(this.now(), sha);
  }

  // ── Serve ────────────────────────────────────────────────────────────────────────

  async serve(raw: unknown): Promise<SliceAnswer | InventoryAnswer | { ok: true; queued: number } | { ok: false; reason: string }> {
    const cmd = (raw ?? {}) as AppMediaPullCommand;
    if (cmd.op === 'slice') return this.serveSlice(cmd.sha256, cmd.offset);
    if (cmd.op === 'inventory') return this.serveInventory(cmd.since, cmd.after);
    if (cmd.op === 'nudge') return this.serveNudge(cmd.hashes);
    return { ok: false, reason: 'bad-op' };
  }

  /** Unpurged references from any event this machine holds (live or deleted conversations). */
  private referenced(sha: string): { size: number } | null {
    const r = this.d.store.mediaBlobRefs(sha);
    return r && r.allRefs > 0 ? { size: r.size } : null;
  }

  private async serveSlice(sha: unknown, offset: unknown): Promise<SliceAnswer> {
    if (!isSha256Hex(sha) || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return { ok: false, reason: 'bad-request' };
    if (!this.referenced(sha)) return { ok: false, reason: 'not-referenced' };
    const blob = this.d.media.locateBlob(sha);
    if (!blob) return { ok: false, reason: 'not-held' };
    if (this.serving >= MAX_SERVES_AT_ONCE) { this.counters.busyRefusals++; return { ok: false, reason: 'busy' }; }
    this.serving++;
    let handle: fs.promises.FileHandle | null = null;
    try {
      // A blob changed since its last check is re-hashed first; a damaged one is quarantined, never served.
      if (!(await this.d.media.verifyBeforeServe(sha))) return { ok: false, reason: 'not-held' };
      const st = fs.lstatSync(blob);
      if (!st.isFile()) return { ok: false, reason: 'not-held' };
      handle = await fs.promises.open(blob, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat();
      if (opened.ino !== st.ino || opened.dev !== st.dev) return { ok: false, reason: 'not-held' };
      if (offset > opened.size) return { ok: false, reason: 'bad-offset' };
      const len = Math.min(APP_MEDIA_SLICE_BYTES, opened.size - offset);
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const { bytesRead } = await handle.read(buf, got, len - got, offset + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      this.counters.slicesServed++;
      return { ok: true, size: opened.size, offset, dataB64: buf.subarray(0, got).toString('base64') };
    } catch {
      return { ok: false, reason: 'not-held' }; // @silent-fallback-ok — a blob that cannot be opened safely reads as absent; the peer tries elsewhere
    } finally {
      this.serving--;
      if (handle) await handle.close().catch(() => undefined);
    }
  }

  /** This machine's held, unpurged hashes; recomputed at most every 5 minutes, last 3 versions kept for diffs. */
  ownInventory(): { version: string; hashes: string[] } {
    const latest = this.ownInventories[this.ownInventories.length - 1];
    if (latest && this.now() - latest.at < OWN_INVENTORY_REUSE_MS) return latest;
    const hashes = this.d.media.heldHashes().filter((h) => this.referenced(h));
    const version = versionOf(hashes);
    if (latest && latest.version === version) { latest.at = this.now(); return latest; }
    const snap = { version, hashes, set: new Set(hashes), at: this.now() };
    this.ownInventories = [...this.ownInventories, snap].slice(-3);
    return snap;
  }

  private serveInventory(since: unknown, after: unknown): InventoryAnswer {
    const cur = this.ownInventory();
    if (typeof since === 'string' && after === undefined) {
      if (since === cur.version) return { ok: true, version: cur.version, unchanged: true };
      const old = this.ownInventories.find((s) => s.version === since);
      if (old) {
        const curSet = new Set(cur.hashes);
        const added = cur.hashes.filter((h) => !old.set.has(h));
        const removed = old.hashes.filter((h) => !curSet.has(h));
        if (added.length + removed.length <= INVENTORY_PAGE) return { ok: true, version: cur.version, diff: { added, removed } };
      }
    }
    const start = typeof after === 'string' ? cur.hashes.findIndex((h) => h > after) : 0;
    const from = start < 0 ? cur.hashes.length : start;
    const page = cur.hashes.slice(from, from + INVENTORY_PAGE);
    const next = from + INVENTORY_PAGE < cur.hashes.length ? page[page.length - 1] : null;
    return { ok: true, version: cur.version, full: true, hashes: page, next };
  }

  private serveNudge(hashes: unknown): { ok: true; queued: number } | { ok: false; reason: string } {
    if (!Array.isArray(hashes) || hashes.length > NUDGE_MAX || !hashes.every(isSha256Hex)) return { ok: false, reason: 'bad-request' };
    let queued = 0;
    for (const h of hashes) {
      if (!this.referenced(h) || this.d.media.locateBlob(h)) continue;
      this.rearm(h); // a peer naming itself as a holder re-arms a given-up file (§4.12)
      this.hurry(h);
      queued++;
    }
    if (queued > 0) this.wantedDirty = true;
    return { ok: true, queued };
  }

  // ── Pull ─────────────────────────────────────────────────────────────────────────

  /** Referenced, unpurged hashes this machine does not hold. Cached for a minute (or until dirty). */
  private wantedHashes(): string[] {
    if (!this.wantedDirty && this.now() - this.wantedAt < WANTED_REFRESH_MS) return this.wanted;
    const missing: string[] = [];
    for (const r of this.d.store.mediaReferencedHashes()) if (!this.d.media.locateBlob(r.sha256)) missing.push(r.sha256);
    missing.sort();
    this.wanted = missing;
    this.wantedAt = this.now();
    this.wantedDirty = false;
    const t = this.now();
    const ins = this.db.prepare('INSERT OR IGNORE INTO pulls (sha256, firstWantedAt) VALUES (?, ?)');
    for (const h of missing) ins.run(h, t);
    // Rows for hashes no longer wanted (landed, purged) and their partial files go.
    const keep = new Set(missing);
    for (const r of this.db.prepare('SELECT sha256 FROM pulls').all() as Array<{ sha256: string }>) {
      if (keep.has(r.sha256)) continue;
      this.db.prepare('DELETE FROM pulls WHERE sha256 = ?').run(r.sha256);
      this.removePart(r.sha256);
    }
    return missing;
  }

  private partPath(sha: string): string { return path.join(this.d.media.pullsDir, `${sha}.part`); }

  private removePart(sha: string): void {
    if (fs.existsSync(this.partPath(sha))) SafeFsExecutor.safeRmSync(this.partPath(sha), { force: true, operation: `${OP}:part` });
  }

  private pullRow(sha: string): PullRow | null {
    return (this.db.prepare('SELECT * FROM pulls WHERE sha256 = ?').get(sha) as PullRow | undefined) ?? null;
  }

  isUnrecoverable(sha: string): boolean { return this.pullRow(sha)?.unrecoverable === 1; }

  /** Ask for this blob now (download, app-media-path, owner dispatch). */
  want(sha: string): void {
    if (!isSha256Hex(sha) || this.d.media.locateBlob(sha) || !this.referenced(sha)) return;
    this.priority.add(sha);
    this.db.prepare('INSERT OR IGNORE INTO pulls (sha256, firstWantedAt) VALUES (?, ?)').run(sha, this.now());
    this.hurry(sha);
    void this.tick();
  }

  /**
   * Skip a file's backoff for one immediate attempt, at most once per backoff window: an app
   * polling a download every 2 s, or repeated nudges, can never turn the backoff into a hot loop.
   */
  private hurry(sha: string): void {
    const row = this.pullRow(sha);
    if (!row || row.unrecoverable === 1 || row.nextAttemptAt <= this.now()) return;
    const window = Math.min(BACKOFF_MIN_MS * 2 ** Math.min(Math.max(row.attempts - 1, 0), 20), BACKOFF_MAX_MS);
    const last = this.lastHurryAt.get(sha);
    if (last !== undefined && this.now() - last < window) return;
    this.lastHurryAt.set(sha, this.now());
    this.db.prepare('UPDATE pulls SET nextAttemptAt = ? WHERE sha256 = ?').run(this.now(), sha);
  }

  /** Whether an on-demand copy can start now; otherwise the plain reason (the download route's 202 vs 404). */
  canFetch(sha: string): { ok: true } | { ok: false; reason: string } {
    if (!this.transport) return { ok: false, reason: 'this machine is not connected to the agent\'s other machines' };
    if (this.isUnrecoverable(sha)) return { ok: false, reason: 'no machine of this agent has been able to provide it for 7 days' };
    if (this.d.media.belowDiskFloor()) return { ok: false, reason: 'this machine is nearly out of disk space, so nothing is copied here until space is freed' };
    if (this.candidatePeers(sha).length === 0) return { ok: false, reason: this.noPeerReason() };
    return { ok: true };
  }

  /** Online peers with a closed breaker that could hold this file (a fresh inventory that lacks it rules a peer out). */
  private candidatePeers(sha: string): string[] {
    const t = this.now();
    return (this.transport?.peers() ?? []).filter((p) => {
      if (p.online === false || this.breakerOpen(p.machineId, t)) return false;
      const inv = this.peerInventories.get(p.machineId);
      return !inv || t - inv.at > INVENTORY_FRESH_MS || inv.set.has(sha);
    }).map((p) => p.machineId);
  }

  private noPeerReason(): string {
    const peers = this.transport?.peers() ?? [];
    if (peers.length === 0) return 'no other machine of this agent is registered';
    const offline = peers.filter((p) => p.online === false).map((p) => p.nickname || p.machineId);
    if (offline.length === peers.length) return `${offline.join(', ')} ${offline.length === 1 ? 'is' : 'are'} not reachable`;
    return 'no reachable machine of this agent holds it';
  }

  /** On-demand asks waiting for a blob right now (observability and tests). */
  waiterCount(): number { let n = 0; for (const ws of this.waiters.values()) n += ws.length; return n; }

  /** Resolve true when the blob is held, or false after `ms` (the pull keeps going in the background). */
  awaitBlob(sha: string, ms: number): Promise<boolean> {
    if (this.d.media.locateBlob(sha)) return Promise.resolve(true);
    if (!this.transport || !this.referenced(sha) || this.isUnrecoverable(sha)) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (v: boolean) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
      const timer = setTimeout(() => {
        // Timed out: this waiter leaves the list (the pull itself keeps going).
        const list = this.waiters.get(sha);
        if (list) {
          const rest = list.filter((w) => w !== finish);
          if (rest.length > 0) this.waiters.set(sha, rest); else this.waiters.delete(sha);
        }
        finish(false);
      }, ms);
      timer.unref?.();
      const list = this.waiters.get(sha) ?? [];
      list.push(finish);
      this.waiters.set(sha, list);
      this.want(sha);
    });
  }

  /** Why a blob is not here yet, in plain words (app-media-path's message). */
  whyNotHere(sha: string): string {
    const row = this.pullRow(sha);
    const can = this.canFetch(sha);
    if (!can.ok) return can.reason;
    const paused = this.loadPausedSince !== null && this.now() - this.loadPausedSince < LOAD_PAUSE_MAX_MS;
    const load = paused ? '; background copying is paused while this machine is overloaded, this file is copied on request' : '';
    return `${row?.lastError ? `still copying (${row.lastError})` : 'still copying'}${load}`;
  }

  private settleWaiters(sha: string, landed: boolean): void {
    const ws = this.waiters.get(sha);
    if (!ws) return;
    this.waiters.delete(sha);
    for (const w of ws) w(landed);
  }

  /** One pull tick. Single-flight; never throws. */
  async tick(): Promise<void> {
    if (this.ticking || !this.transport) return;
    this.ticking = true;
    try { await this.runTick(); } catch (err) { this.report(`pull tick: ${err instanceof Error ? err.message : String(err)}`); } finally { this.ticking = false; } // @silent-fallback-ok — reported through deps.report; the next tick retries
    if (this.now() - this.lastInventoryRound >= INVENTORY_EVERY_MS) void this.inventoryRound();
  }

  /** How many slices this tick may move for background (non-priority) pulls. */
  private backgroundBudget(): number {
    const v = this.transport?.loadVerdict?.() ?? 'ok';
    if (v !== 'saturated' && v !== 'impaired') { this.loadPausedSince = null; return SLICES_PER_TICK; }
    if (this.loadPausedSince === null) this.loadPausedSince = this.now();
    return this.now() - this.loadPausedSince < LOAD_PAUSE_MAX_MS ? 0 : 1;
  }

  private async runTick(): Promise<void> {
    if (this.d.media.belowDiskFloor()) return; // never write a blob below the floor (§4.7); missingBlobs counts it
    const wanted = this.wantedHashes();
    const background = this.backgroundBudget();
    const t = this.now();
    const due = (sha: string) => { const r = this.pullRow(sha); return !!r && r.unrecoverable === 0 && r.nextAttemptAt <= t; };
    const queue = [...[...this.priority].filter(due), ...wanted.filter((h) => !this.priority.has(h) && due(h))];
    let slices = 0;
    let bgSlices = 0;
    for (const sha of queue) {
      if (slices >= SLICES_PER_TICK) break;
      const isPriority = this.priority.has(sha);
      if (!isPriority && bgSlices >= background) continue;
      // Move this blob as far as the budget allows; stop on the first refusal.
      for (;;) {
        if (slices >= SLICES_PER_TICK || (!isPriority && bgSlices >= background)) break;
        const step = await this.pullOneSlice(sha);
        if (step === 'moved') { slices++; if (!isPriority) bgSlices++; continue; }
        if (step === 'landed') { slices++; if (!isPriority) bgSlices++; }
        break;
      }
    }
  }

  private peerChoice(sha: string, have: number): string | null {
    const t = this.now();
    const peers = (this.transport?.peers() ?? []).filter((p) => p.online !== false && !this.breakerOpen(p.machineId, t));
    if (have > 0) {
      // A partial copy continues only from the peer that started it.
      const pinned = this.partPeer.get(sha);
      return pinned && peers.some((p) => p.machineId === pinned) ? pinned : null;
    }
    if (peers.length === 0) return null;
    const holders = peers.filter((p) => this.peerInventories.get(p.machineId)?.set.has(sha));
    const pool = holders.length > 0 ? holders : peers;
    const i = this.peerCursor.get(sha) ?? 0;
    return pool[i % pool.length].machineId;
  }

  private advancePeer(sha: string): void { this.peerCursor.set(sha, (this.peerCursor.get(sha) ?? 0) + 1); }

  private async pullOneSlice(sha: string): Promise<'moved' | 'landed' | 'refused'> {
    const refs = this.referenced(sha);
    if (!refs) { this.priority.delete(sha); return 'refused'; }
    if (this.d.media.locateBlob(sha)) { this.landed(sha); return 'refused'; }
    const part = this.partPath(sha);
    let have = 0;
    try { have = fs.statSync(part).size; } catch { have = 0; } // @silent-fallback-ok — no partial file yet
    if (have > refs.size) { this.removePart(sha); have = 0; }
    // A complete part left by an earlier tick (the disk floor, a crash): verify and keep it, no request.
    if (have === refs.size) return this.finishPart(sha, refs.size, this.partPeer.get(sha) ?? null);
    let peer = this.peerChoice(sha, have);
    if (!peer && have > 0) {
      // The peer that started this partial copy is gone (offline, breaker, restart): start over from another.
      this.removePart(sha);
      this.partPeer.delete(sha);
      have = 0;
      peer = this.peerChoice(sha, 0);
    }
    if (!peer) { this.blobFailure(sha, 'no peer is reachable'); return 'refused'; }
    let res: MeshSendResult;
    try { res = await this.transport!.send(peer, { type: 'app-media-pull', op: 'slice', sha256: sha, offset: have }, SLICE_TIMEOUT_MS); } catch (err) {
      this.advancePeer(sha);
      if (have > 0) { this.removePart(sha); this.partPeer.delete(sha); }
      this.blobFailure(sha, `${peer} did not answer (${err instanceof Error ? err.message : String(err)})`);
      return 'refused';
    }
    const r = (res.ok ? res.result : null) as SliceAnswer | null;
    if (!r || r.ok !== true) {
      const reason = r && r.ok === false ? r.reason : (res.reason ?? `status ${res.status ?? '?'}`);
      this.advancePeer(sha);
      // The pinned peer no longer serves this file: the partial copy restarts from another peer.
      if (have > 0 && reason !== 'busy') { this.removePart(sha); this.partPeer.delete(sha); }
      if (reason === 'busy') return 'refused'; // try again next tick, no backoff
      this.blobFailure(sha, `${peer}: ${reason}`);
      return 'refused';
    }
    const data = typeof r.dataB64 === 'string' ? Buffer.from(r.dataB64, 'base64') : null;
    // A slice must be exactly what was asked for, from a file of the referenced size.
    if (!data || r.offset !== have || r.size !== refs.size || data.length === 0 || data.length > APP_MEDIA_SLICE_BYTES || have + data.length > refs.size) {
      this.removePart(sha);
      this.partPeer.delete(sha);
      this.verifyFailure(peer, sha, 'a slice did not match the request');
      return 'refused';
    }
    if (have === 0) this.partPeer.set(sha, peer);
    const fd = fs.openSync(part, have === 0 ? 'w' : 'r+', 0o600); /* state-registry: app-media */
    try { fs.writeSync(fd, data, 0, data.length, have); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.counters.slicesPulled++;
    this.db.prepare('UPDATE pulls SET lastServedAt = ?, attempts = 0, nextAttemptAt = 0, lastError = NULL WHERE sha256 = ?').run(this.now(), sha);
    if (have + data.length < refs.size) return 'moved';
    return this.finishPart(sha, refs.size, peer);
  }

  /** Hash the complete part in a worker; keep it only if length and SHA-256 equal the reference. */
  private async finishPart(sha: string, size: number, peer: string | null): Promise<'landed' | 'refused'> {
    const part = this.partPath(sha);
    const h = await hashFile(part);
    if (h.sha256 !== sha || h.size !== size) {
      this.removePart(sha);
      this.partPeer.delete(sha);
      if (peer) this.verifyFailure(peer, sha, 'the copied file did not match its hash');
      else this.blobFailure(sha, 'a partial copy did not match its hash');
      return 'refused';
    }
    // A purge can land while the hash runs: purged bytes are never published (§4.7, §4.12).
    if (!this.referenced(sha)) { this.dropUnreferenced(sha); return 'refused'; }
    if (this.d.media.belowDiskFloor()) return 'refused'; // keep the verified part; publish when the floor clears
    fs.chmodSync(part, 0o400);
    if (!this.d.media.publishPulled(part, sha)) { this.dropUnreferenced(sha); return 'refused'; }
    this.partPeer.delete(sha);
    if (peer) this.peerSuccess(peer);
    this.counters.blobsLanded++;
    this.landed(sha);
    return 'landed';
  }

  /** The file stopped being wanted mid-copy (purged): its partial copy and pull state go, waiters hear no. */
  private dropUnreferenced(sha: string): void {
    this.removePart(sha);
    this.partPeer.delete(sha);
    this.priority.delete(sha);
    this.db.prepare('DELETE FROM pulls WHERE sha256 = ?').run(sha);
    this.wantedDirty = true;
    this.settleWaiters(sha, false);
  }

  private landed(sha: string): void {
    this.db.prepare('DELETE FROM pulls WHERE sha256 = ?').run(sha);
    this.priority.delete(sha);
    this.lastHurryAt.delete(sha);
    this.wanted = this.wanted.filter((h) => h !== sha);
    const latest = this.ownInventories[this.ownInventories.length - 1];
    if (latest) latest.at = 0; // the next inventory read recomputes (versions stay valid for diffs)
    this.settleWaiters(sha, true);
    try { this.d.onBlobLanded?.(sha); } catch (err) { this.report(`blob landed hook: ${err instanceof Error ? err.message : String(err)}`); }
  }

  /** Backoff 30 s → 1 h; unrecoverable after 7 days with no peer serving it. */
  private blobFailure(sha: string, why: string): void {
    const row = this.pullRow(sha);
    if (!row) return;
    const attempts = row.attempts + 1;
    const wait = Math.min(BACKOFF_MIN_MS * 2 ** Math.min(attempts - 1, 20), BACKOFF_MAX_MS);
    const since = row.lastServedAt ?? row.firstWantedAt;
    const giveUp = this.now() - since >= GIVE_UP_MS;
    this.db.prepare('UPDATE pulls SET attempts = ?, nextAttemptAt = ?, lastError = ?, unrecoverable = ? WHERE sha256 = ?')
      .run(attempts, this.now() + wait, why.slice(0, 200), giveUp ? 1 : 0, sha);
    if (giveUp) { this.priority.delete(sha); this.settleWaiters(sha, false); this.evaluateUnrecoverable(); }
  }

  // ── Peer breaker ─────────────────────────────────────────────────────────────────

  private peerRow(id: string): { failures: number; openUntil: number; opensDay: string | null; opens: number } {
    return (this.db.prepare('SELECT failures, openUntil, opensDay, opens FROM pull_peers WHERE machineId = ?').get(id) as { failures: number; openUntil: number; opensDay: string | null; opens: number } | undefined)
      ?? { failures: 0, openUntil: 0, opensDay: null, opens: 0 };
  }

  breakerOpen(id: string, t = this.now()): boolean {
    const r = this.peerRow(id);
    if (r.opensDay === dayOf(t) && r.opens >= PEER_OPENS_TO_LATCH) return true;
    if (r.opens >= PEER_OPENS_TO_LATCH && r.opensDay !== dayOf(t)) this.clearNotice(`app-media:peer-breaker:${id}`);
    return r.openUntil > t;
  }

  private verifyFailure(peer: string, sha: string, why: string): void {
    this.counters.verifyFailures++;
    this.blobFailure(sha, `${peer}: ${why}`);
    const t = this.now();
    const r = this.peerRow(peer);
    let { failures, openUntil, opensDay, opens } = r;
    failures++;
    if (opensDay !== dayOf(t)) { opensDay = dayOf(t); opens = 0; }
    if (failures >= PEER_FAILURES_TO_OPEN) {
      failures = 0;
      openUntil = t + PEER_OPEN_MS;
      opens++;
      this.report(`copies from ${peer} failed verification ${PEER_FAILURES_TO_OPEN} times in a row; not asking it for 15 minutes`);
      if (opens >= PEER_OPENS_TO_LATCH) {
        this.raiseOnce(`app-media:peer-breaker:${peer}`, 'latched', {
          title: `Files copied from ${peer} keep arriving damaged`,
          body: `This machine stopped copying app files from ${peer} until tomorrow: its copies failed verification ${PEER_FAILURES_TO_OPEN * PEER_OPENS_TO_LATCH} times today. Files are still copied from the agent's other machines. A damaged copy is never kept.`,
        });
      }
    }
    this.db.prepare('INSERT OR REPLACE INTO pull_peers (machineId, failures, openUntil, opensDay, opens) VALUES (?, ?, ?, ?, ?)').run(peer, failures, openUntil, opensDay, opens);
  }

  private peerSuccess(peer: string): void {
    this.db.prepare('UPDATE pull_peers SET failures = 0 WHERE machineId = ?').run(peer);
  }

  // ── Inventories and copy counts ──────────────────────────────────────────────────

  /** Fetch every online peer's inventory (diff when possible), then evaluate the alarms. */
  async inventoryRound(): Promise<void> {
    if (this.inventoryRunning || !this.transport) return;
    this.inventoryRunning = true;
    this.lastInventoryRound = this.now();
    try {
      for (const p of this.transport.peers()) {
        if (p.online === false) continue;
        try { await this.fetchInventory(p.machineId); } catch (err) { this.report(`inventory from ${p.machineId}: ${err instanceof Error ? err.message : String(err)}`); }
      }
      this.evaluateAlarms();
      this.evaluateUnrecoverable();
    } finally { this.inventoryRunning = false; }
  }

  private async fetchInventory(peer: string): Promise<void> {
    const prev = this.peerInventories.get(peer);
    const first = await this.transport!.send(peer, { type: 'app-media-pull', op: 'inventory', ...(prev ? { since: prev.version } : {}) }, INVENTORY_TIMEOUT_MS);
    const a = (first.ok ? first.result : null) as InventoryAnswer | null;
    if (!a || a.ok !== true) return; // the old inventory ages out; singleCopyBlobs turns null
    let set: Set<string>;
    if ('unchanged' in a && prev) set = prev.set;
    else if ('diff' in a && prev) {
      set = new Set(prev.set);
      for (const h of a.diff.added) if (isSha256Hex(h)) set.add(h);
      for (const h of a.diff.removed) set.delete(h);
    } else if ('full' in a) {
      set = new Set(a.hashes.filter(isSha256Hex));
      let next = a.next;
      let pages = 1;
      while (next && pages < INVENTORY_MAX_PAGES) {
        const r = await this.transport!.send(peer, { type: 'app-media-pull', op: 'inventory', after: next }, INVENTORY_TIMEOUT_MS);
        const page = (r.ok ? r.result : null) as InventoryAnswer | null;
        if (!page || page.ok !== true || !('full' in page) || page.version !== a.version) return; // changed mid-read: keep the old one
        for (const h of page.hashes) if (isSha256Hex(h)) set.add(h);
        next = page.next;
        pages++;
      }
      if (next) return; // too many pages for one round; the inventory is not complete
    } else return;
    this.peerInventories.set(peer, { version: a.version, set, at: this.now() });
    // A peer that now holds a blob this machine gave up on re-arms it (§4.12).
    for (const r of this.db.prepare('SELECT sha256 FROM pulls WHERE unrecoverable = 1').all() as Array<{ sha256: string }>) {
      if (set.has(r.sha256)) this.rearm(r.sha256);
    }
  }

  /**
   * Held, unpurged blobs no peer inventory younger than 2 hours lists. `count: null` (never 0)
   * when that cannot be measured: no mesh transport, or a peer whose inventory is old or missing.
   */
  singleCopy(): { count: number | null; hashes: string[]; reason: string | null } {
    if (!this.transport) return { count: null, hashes: [], reason: 'this machine is not connected to the agent\'s other machines' };
    const peers = this.transport.peers();
    const t = this.now();
    const stale = peers.filter((p) => { const inv = this.peerInventories.get(p.machineId); return !inv || t - inv.at > INVENTORY_FRESH_MS; });
    if (stale.length > 0) return { count: null, hashes: [], reason: `no recent list of files from ${stale.map((p) => p.nickname || p.machineId).join(', ')}` };
    const held = this.ownInventory().hashes;
    const alone = held.filter((h) => !peers.some((p) => this.peerInventories.get(p.machineId)!.set.has(h)));
    return { count: alone.length, hashes: alone, reason: null };
  }

  private unrecoverableCount(): number {
    let n = 0;
    for (const r of this.db.prepare('SELECT sha256 FROM pulls WHERE unrecoverable = 1').all() as Array<{ sha256: string }>) if (this.referenced(r.sha256)) n++;
    return n;
  }

  private conversationsOf(hashes: readonly string[]): string {
    const keys = new Set<string>();
    for (const h of hashes.slice(0, 200)) for (const k of this.d.store.mediaConversationsFor(h)) keys.add(k);
    const list = [...keys];
    const titled = list.slice(0, 10).map((k) => {
      const c = this.d.store.getConversation(k.startsWith('app:') ? k.slice(4) : k);
      return c?.title ? `"${c.title}"` : k;
    });
    return `${titled.join(', ')}${list.length > 10 ? ` and ${list.length - 10} more` : ''}`;
  }

  /** The single-copy alarm ladder (§4.12). Called after each inventory round. */
  evaluateAlarms(): void {
    if (!this.transport) return;
    const peers = this.transport.peers();
    if (peers.length === 0) return; // one machine: nothing to copy to, nothing to alarm about
    const self = this.d.selfId();
    const key = `app-media:single-copy:${self}`;
    const t = this.now();
    const sc = this.singleCopy();
    if (sc.count === null) {
      this.singleSince = null; this.nudgedAt = null;
      if (this.unmeasurableSince === null) this.unmeasurableSince = t;
      if (t - this.unmeasurableSince > UNMEASURABLE_ALARM_MS) {
        this.raiseOnce(key, 'unmeasurable', {
          title: 'Cannot tell whether app files have a second copy',
          body: `For over 2 hours this machine could not measure how many app files exist only here: ${sc.reason}.`,
        });
      }
      return;
    }
    this.unmeasurableSince = null;
    for (const h of [...this.singleFirstSeen.keys()]) if (!sc.hashes.includes(h)) this.singleFirstSeen.delete(h);
    for (const h of sc.hashes) if (!this.singleFirstSeen.has(h)) this.singleFirstSeen.set(h, t);
    if (sc.count === 0) {
      this.singleSince = null; this.nudgedAt = null;
      this.clearNotice(key);
      return;
    }
    if (this.singleSince === null) this.singleSince = t;
    const offline = peers.filter((p) => p.online === false);
    if (offline.length > 0) {
      const old = sc.hashes.filter((h) => t - (this.singleFirstSeen.get(h) ?? t) > SINGLE_COPY_OFFLINE_MS);
      if (old.length > 0) {
        this.raiseOnce(key, 'offline', {
          title: 'Some app files exist on one machine only',
          body: `${old.length} file(s) from ${this.conversationsOf(old)} have been on this machine only for over a day, because ${offline.map((p) => p.nickname || p.machineId).join(', ')} ${offline.length === 1 ? 'is' : 'are'} offline. They will be copied when it is back.`,
        });
      }
      return;
    }
    if (t - this.singleSince <= SINGLE_COPY_GRACE_MS) return;
    if (this.nudgedAt === null) {
      // First self-heal: ask every peer to pull what only this machine holds.
      this.nudgedAt = t;
      for (const p of peers) {
        this.counters.nudgesSent++;
        void this.transport.send(p.machineId, { type: 'app-media-pull', op: 'nudge', hashes: sc.hashes.slice(0, NUDGE_MAX) }, INVENTORY_TIMEOUT_MS)
          .catch((err: unknown) => this.report(`nudge to ${p.machineId}: ${err instanceof Error ? err.message : String(err)}`));
      }
      return;
    }
    if (t - this.nudgedAt > SINGLE_COPY_GRACE_MS) {
      this.raiseOnce(key, 'stuck', {
        title: 'Some app files exist on one machine only',
        body: `${sc.count} file(s) from ${this.conversationsOf(sc.hashes)} are still held only by this machine, although every machine is online and was asked to copy them an hour ago.`,
      });
    }
  }

  /** One notice per machine while blobs are unrecoverable (§4.12). */
  evaluateUnrecoverable(): void {
    const key = `app-media:unrecoverable:${this.d.selfId()}`;
    const rows = (this.db.prepare('SELECT sha256 FROM pulls WHERE unrecoverable = 1').all() as Array<{ sha256: string }>).map((r) => r.sha256).filter((h) => this.referenced(h));
    if (rows.length === 0) { this.clearNotice(key); return; }
    this.raiseOnce(key, 'unrecoverable', {
      title: 'Some app files could not be copied to this machine',
      body: `${rows.length} file(s) from ${this.conversationsOf(rows)} could not be copied here: no machine of this agent has been able to provide them for 7 days. They are copied as soon as a machine that holds them is back.`,
    });
  }

  /** Raise once per condition and reason; a new reason refreshes the same item. */
  private raiseOnce(key: string, reason: string, item: { title: string; body: string }): void {
    if (this.raised.get(key) === reason) return;
    this.raised.set(key, reason);
    try { this.d.raiseAttention?.({ conditionKey: key, ...item }); } catch (err) { this.report(`notice: ${err instanceof Error ? err.message : String(err)}`); }
  }

  private clearNotice(key: string): void {
    if (!this.raised.delete(key)) return;
    try { this.d.clearAttention?.(key); } catch (err) { this.report(`notice clear: ${err instanceof Error ? err.message : String(err)}`); }
  }

  /** Observability for tests and /health. */
  status(): Record<string, unknown> {
    return {
      transport: this.transport !== null, wanted: this.wanted.length, priority: this.priority.size, serving: this.serving,
      loadPausedSince: this.loadPausedSince ? new Date(this.loadPausedSince).toISOString() : null,
      peerInventories: [...this.peerInventories.entries()].map(([id, inv]) => ({ machineId: id, blobs: inv.set.size, at: new Date(inv.at).toISOString() })),
      counters: { ...this.counters },
    };
  }
}
