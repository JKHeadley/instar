/**
 * ConversationEmbeddingIndex — the message index behind meaning search over conversations
 * (docs/specs/conversation-search.md §4).
 *
 * One SQLite file per machine (`<stateDir>/state/conversation-embeddings.db`): one row per
 * message this machine holds, keyed by (conversation ref, source key), with the message time,
 * platform, who sent it, a hash of the text that was embedded, and the vector (384 floats from
 * the shared local all-MiniLM-L6-v2 EmbeddingProvider). A row with no vector means "looked at,
 * too short to embed" (under MIN_WORDS words), so coverage can count it as done. The index holds
 * vectors and hashes, never the message text: a search re-reads each candidate from its own store,
 * so the snippet is the current text, and a message that is gone is dropped (and forgotten here).
 *
 * The feeder (`ConversationEmbeddingFeeder`) fills it in the background from the same sources the
 * keyword search reads (TopicMemory rows for Telegram, the app conversation store, the Slack rows
 * the history read serves). Each tick checks the newest messages of every source first, then
 * continues one sweep page (newest-first) through the older ones, embedding at most
 * MAX_EMBEDS_PER_TICK messages or MAX_EMBED_MS_PER_TICK of embedding time, whichever comes first,
 * yielding to the event loop between embeds, and skipping the tick entirely when the machine is
 * busy (host CPU at or above BUSY_SKIP_PCT, or the 1-minute load above LOAD_SKIP_RATIO per core:
 * the same "idle under 15%" line the heavy-work admission hook uses). When a sweep reaches the
 * oldest message it starts again from the newest, which picks up late-replicated messages and
 * edited text (the hash differs) on the next pass.
 *
 * Machine-local by design: each machine indexes what it holds; `scope=pool` merges answers.
 * Vector search is a full scan over the rows the caller may see (`vec_distance_cosine` from
 * sqlite-vec when it loads, a JS cosine otherwise), so the visibility filter is applied in SQL
 * BEFORE ranking, never after a global top-k.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import { cpuLoadRatio } from '../core/cpuStarvation.js';
import { makeHostCpuBusySampler } from '../monitoring/hostCpuBusySampler.js';

/** What the index needs from an embedding provider (the shared EmbeddingProvider satisfies it). */
export interface Embedder {
  readonly dimensions: number;
  embed(text: string): Promise<Float32Array>;
  /** sqlite-vec, when the provider has it; absent or false ⇒ the JS cosine is used. */
  loadVecExtension?(db: BetterSqliteDatabase): boolean;
}

export type IndexPlatform = 'app' | 'telegram' | 'slack';

/** A message as a source lists it. `text` null ⇒ read lazily through `readText` (only for a missing row). */
export interface SourceItem { ref: string; key: string; at: string; fromUser: boolean; text: string | null }

/** One place messages come from. Pages are newest-first; the cursor is the source's own. */
export interface IndexSource {
  platform: IndexPlatform;
  /** True when a message's text never changes once written (the app store): a present row is never re-read. */
  immutable?: boolean;
  page(cursor: string | null, limit: number): { items: SourceItem[]; next: string | null };
  /** The text (and sender) of an item listed without text; null when it is gone or unreadable. */
  readText?(item: SourceItem): { text: string; fromUser: boolean } | null;
  /** How many messages this source holds now, or null when it cannot tell. */
  total(): number | null;
}

export interface IndexHitRow { ref: string; key: string; platform: IndexPlatform; at: string; fromUser: boolean; similarity: number }

/** Messages under this many words are not embedded (a "thanks" or "ok" means little on its own). */
export const MIN_WORDS = 3;
/** How much of a message is embedded: the model reads about 256 tokens; the start carries the topic. */
export const EMBED_CHARS = 1200;
export const MODEL_ID = 'Xenova/all-MiniLM-L6-v2@384';
/** Newest messages this machine keeps vectors for; older ones are not backfilled past it. */
export const MAX_INDEXED = 200_000;

// Throttle (measured on the Mac Studio, 2026-11-14: ~9.3 ms of one core per message, 200 real
// Telegram messages cut to 1200 characters, single ONNX thread). 48 × 9.3 ms ≈ 450 ms per 10 s
// tick ≈ 4.5% of ONE core while backfilling; nothing at all once caught up and idle.
export const TICK_MS = 10_000;
export const FIRST_TICK_MS = 60_000;
export const MAX_EMBEDS_PER_TICK = 48;
export const MAX_EMBED_MS_PER_TICK = 600;
export const HEAD_PAGE = 100;
export const SWEEP_PAGE = 400;
/** Skip the tick when the host CPU is at least this busy (idle under 15%, the heavy-work line). */
export const BUSY_SKIP_PCT = 85;
/** …or when the 1-minute load average is above this per core (CPU starvation starts at 1.5). */
export const LOAD_SKIP_RATIO = 1.0;

const WORD_RE = /[\p{L}\p{N}\p{M}]+/gu;

export function wordCount(text: string): number {
  let n = 0;
  for (const _ of text.matchAll(WORD_RE)) { n++; if (n >= 64) break; }
  return n;
}

/** The hash of the text that was (or would be) embedded. */
export function textHash(text: string): string {
  return crypto.createHash('sha256').update(text.slice(0, EMBED_CHARS)).digest('hex').slice(0, 24);
}

function toBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** 1 − cosine for two float32 blobs (the JS fallback when sqlite-vec is not loaded). */
function cosineDistanceBlobs(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length) >> 2;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a.readFloatLE(i * 4), y = b.readFloatLE(i * 4);
    dot += x * y; na += x * x; nb += y * y;
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / Math.sqrt(na * nb);
}

export class ConversationEmbeddingIndex {
  private db: BetterSqliteDatabase | null = null;
  private distanceFn: 'vec_distance_cosine' | 'cse_cosine_distance' = 'cse_cosine_distance';
  private unregister: (() => void) | null = null;

  constructor(private readonly opts: { dbPath: string; dimensions?: number }) {}

  get dimensions(): number { return this.opts.dimensions ?? 384; }
  get isOpen(): boolean { return this.db !== null; }
  /** Which distance the search uses (observability and tests). */
  get distance(): string { return this.distanceFn; }

  /** Open (creating) the file. A corrupt file is derived state: set aside and started fresh. */
  open(embedder?: Pick<Embedder, 'loadVecExtension'> | null): void {
    if (this.db) return;
    fs.mkdirSync(path.dirname(this.opts.dbPath), { recursive: true });
    const tryOpen = (): BetterSqliteDatabase => {
      const db = new Database(this.opts.dbPath); /* state-registry: derived-conversation-embeddings */
      try { fs.chmodSync(this.opts.dbPath, 0o600); } catch { /* @silent-fallback-ok — mode bits are best-effort on some filesystems */ }
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('busy_timeout = 2000');
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS msg (
          ref TEXT NOT NULL, key TEXT NOT NULL, platform TEXT NOT NULL, at TEXT NOT NULL,
          from_user INTEGER NOT NULL, text_hash TEXT NOT NULL, embedding BLOB,
          PRIMARY KEY (ref, key)
        );
        CREATE INDEX IF NOT EXISTS msg_at ON msg(at);
      `);
      const ok = db.pragma('quick_check', { simple: true });
      if (ok !== 'ok') throw new Error(`quick_check: ${String(ok)}`);
      return db;
    };
    let db: BetterSqliteDatabase;
    try {
      db = tryOpen();
    } catch {
      // @silent-fallback-ok — a derived cache: set the broken file aside and rebuild it from the stores.
      for (const suffix of ['', '-wal', '-shm']) {
        const p = this.opts.dbPath + suffix;
        if (fs.existsSync(p)) fs.renameSync(p, `${p}.corrupt-${Date.now()}`);
      }
      db = tryOpen();
    }
    // A different model (or dimension) makes every stored vector meaningless: start over.
    const model = (db.prepare("SELECT v FROM meta WHERE k = 'model'").get() as { v: string } | undefined)?.v;
    const want = `${MODEL_ID}:${this.dimensions}`;
    if (model !== want) {
      db.exec('DELETE FROM msg');
      db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('model', ?)").run(want);
    }
    db.function('cse_cosine_distance', { deterministic: true }, (a: unknown, b: unknown) =>
      Buffer.isBuffer(a) && Buffer.isBuffer(b) ? cosineDistanceBlobs(a, b) : 2);
    let vec = false;
    try { vec = embedder?.loadVecExtension?.(db) === true; } catch { vec = false; /* @silent-fallback-ok — the JS cosine answers the same, slower */ }
    this.distanceFn = vec ? 'vec_distance_cosine' : 'cse_cosine_distance';
    this.db = db;
    this.unregister = registerSqliteHandle(() => { try { db.close(); } catch { /* @silent-fallback-ok — already closed */ } });
  }

  close(): void {
    if (!this.db) return;
    try { this.db.close(); } catch { /* @silent-fallback-ok — already closed */ }
    this.db = null;
    this.unregister?.();
    this.unregister = null;
  }

  private need(): BetterSqliteDatabase {
    if (!this.db) throw new Error('conversation embedding index is not open');
    return this.db;
  }

  /** The stored hash for a message, or null when it has no row. */
  hashOf(ref: string, key: string): string | null {
    const r = this.need().prepare('SELECT text_hash AS h FROM msg WHERE ref = ? AND key = ?').get(ref, key) as { h: string } | undefined;
    return r ? r.h : null;
  }

  /** Insert or replace one row; `embedding` null ⇒ looked at, too short to embed. */
  upsert(row: { ref: string; key: string; platform: IndexPlatform; at: string; fromUser: boolean; hash: string; embedding: Float32Array | null }): void {
    if (row.embedding && row.embedding.length !== this.dimensions) throw new Error(`embedding has ${row.embedding.length} dimensions, the index ${this.dimensions}`);
    this.need().prepare('INSERT OR REPLACE INTO msg (ref, key, platform, at, from_user, text_hash, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.ref, row.key, row.platform, row.at, row.fromUser ? 1 : 0, row.hash, row.embedding ? toBuffer(row.embedding) : null);
  }

  /** Drop a row whose message is gone. */
  forget(ref: string, key: string): void {
    this.need().prepare('DELETE FROM msg WHERE ref = ? AND key = ?').run(ref, key);
  }

  /** Rows (embedded or looked-at), and of those the embedded ones. */
  counts(): { rows: number; embedded: number } {
    const r = this.need().prepare('SELECT COUNT(*) AS n, COUNT(embedding) AS e FROM msg').get() as { n: number; e: number };
    return { rows: r.n, embedded: r.e };
  }

  /** Keep only the newest `max` rows (by message time). */
  pruneTo(max: number): number {
    const db = this.need();
    const { rows } = this.counts();
    if (rows <= max) return 0;
    return db.prepare('DELETE FROM msg WHERE rowid IN (SELECT rowid FROM msg ORDER BY at ASC LIMIT ?)').run(rows - max).changes;
  }

  /**
   * The `k` rows nearest the query among the given refs only (the caller's visibility, applied
   * in SQL before ranking). Similarity is 1 − cosine distance (vectors are normalized), best first.
   */
  search(query: Float32Array, refs: ReadonlyArray<string>, k: number): IndexHitRow[] {
    if (refs.length === 0) return [];
    if (query.length !== this.dimensions) throw new Error(`query has ${query.length} dimensions, the index ${this.dimensions}`);
    const rows = this.need().prepare(`
      SELECT ref, key, platform, at, from_user AS fromUser, ${this.distanceFn}(embedding, ?) AS d
      FROM msg
      WHERE embedding IS NOT NULL AND ref IN (SELECT value FROM json_each(?))
      ORDER BY d ASC, at DESC
      LIMIT ?
    `).all(toBuffer(query), JSON.stringify(refs), Math.max(1, Math.min(500, Math.floor(k)))) as Array<{ ref: string; key: string; platform: IndexPlatform; at: string; fromUser: number; d: number }>;
    return rows.map((r) => ({
      ref: r.ref, key: r.key, platform: r.platform, at: r.at, fromUser: !!r.fromUser,
      similarity: Math.max(-1, Math.min(1, 1 - Number(r.d))),
    }));
  }
}

export interface FeederStatus {
  ticks: number;
  embedded: number;
  /** Total time spent embedding, ms. */
  embedMs: number;
  skippedForLoad: number;
  sweepsCompleted: number;
  lastTickAt: string | null;
  lastSkip: string | null;
  /** Fraction of the messages this machine holds that the index has looked at (null until known). */
  coverage: number | null;
}

export type TickOutcome =
  | { ran: true; embedded: number; looked: number; embedMs: number; budget: boolean }
  | { ran: false; reason: 'busy-tick' | 'off' | 'no-model' | 'load' | 'closed' };

export interface FeederOptions {
  index: ConversationEmbeddingIndex;
  sources: () => IndexSource[];
  embedder: () => Embedder | null;
  /** Read live every tick (the off switches). */
  enabled: () => boolean;
  /** True ⇒ skip this tick (the machine is busy). Default: host CPU busy % and load per core. */
  busy?: () => boolean;
  report?: (what: string, detail: string) => void;
  limits?: Partial<{ maxEmbeds: number; maxEmbedMs: number; headPage: number; sweepPage: number; maxIndexed: number }>;
  now?: () => number;
}

/** The default load gate: busy CPU (sampled between ticks) or a long run queue. */
export function defaultBusyGate(): () => boolean {
  const sampler = makeHostCpuBusySampler(undefined, { minWindowMs: 5_000 });
  return () => {
    const busy = sampler.sample();
    if (busy !== null && busy >= BUSY_SKIP_PCT) return true;
    return cpuLoadRatio() > LOAD_SKIP_RATIO;
  };
}

const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

export class ConversationEmbeddingFeeder {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cursors = new Map<string, string | null>();
  private readonly busy: () => boolean;
  private readonly now: () => number;
  private coverageCache: { at: number; value: number | null } | null = null;
  readonly status: FeederStatus = { ticks: 0, embedded: 0, embedMs: 0, skippedForLoad: 0, sweepsCompleted: 0, lastTickAt: null, lastSkip: null, coverage: null };

  constructor(private readonly opts: FeederOptions) {
    this.busy = opts.busy ?? defaultBusyGate();
    this.now = opts.now ?? (() => Date.now());
  }

  private get limits() {
    const l = this.opts.limits ?? {};
    return {
      maxEmbeds: l.maxEmbeds ?? MAX_EMBEDS_PER_TICK, maxEmbedMs: l.maxEmbedMs ?? MAX_EMBED_MS_PER_TICK,
      headPage: l.headPage ?? HEAD_PAGE, sweepPage: l.sweepPage ?? SWEEP_PAGE, maxIndexed: l.maxIndexed ?? MAX_INDEXED,
    };
  }

  /** Start the background ticks (unref'd: never holds the process open). */
  start(): void {
    if (this.timer) return;
    const loop = (delay: number) => {
      this.timer = setTimeout(() => {
        void this.tick().catch((err) => { // @silent-fallback-ok — reported; the next tick tries again
          this.opts.report?.('ConversationEmbeddings.tick', err instanceof Error ? err.message : String(err));
        }).finally(() => { if (this.timer) loop(TICK_MS); });
      }, delay);
      this.timer.unref?.();
    };
    loop(FIRST_TICK_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * One bounded pass: newest messages of every source, then one sweep page each.
   * `ignoreLoad` skips only the busy-machine check (tests and a deliberate catch-up); every other bound holds.
   */
  async tick(opts: { ignoreLoad?: boolean } = {}): Promise<TickOutcome> {
    if (this.running) return { ran: false, reason: 'busy-tick' };
    const skip = (reason: 'off' | 'no-model' | 'load' | 'closed'): TickOutcome => { this.status.lastSkip = reason; return { ran: false, reason }; };
    if (!this.opts.enabled()) return skip('off');
    if (!this.opts.index.isOpen) return skip('closed');
    const embedder = this.opts.embedder();
    if (!embedder) return skip('no-model');
    if (!opts.ignoreLoad && this.busy()) { this.status.skippedForLoad++; return skip('load'); }
    this.running = true;
    const lim = this.limits;
    const budget = { embeds: lim.maxEmbeds, ms: lim.maxEmbedMs };
    let embedded = 0, looked = 0, embedMs = 0, exhausted = false;
    try {
      const sources = this.opts.sources();
      // Returns how many of `items` were fully handled (in order) before the budget ran out.
      const handle = async (src: IndexSource, items: SourceItem[]): Promise<number> => {
        let done = 0;
        for (const it of items) {
          const stored = this.opts.index.hashOf(it.ref, it.key);
          if (stored !== null && (src.immutable || it.text === null)) { done++; continue; }
          let text = it.text;
          let fromUser = it.fromUser;
          if (stored !== null && text !== null && textHash(text) === stored) { done++; continue; }
          if (text === null) {
            const read = src.readText?.(it) ?? null;
            if (read === null) { done++; continue; } // gone or unreadable: nothing to index
            text = read.text;
            fromUser = read.fromUser;
          }
          const hash = textHash(text);
          if (stored === hash) { done++; continue; }
          looked++;
          if (wordCount(text) < MIN_WORDS) {
            this.opts.index.upsert({ ref: it.ref, key: it.key, platform: src.platform, at: it.at, fromUser, hash, embedding: null });
            done++;
            continue;
          }
          if (budget.embeds <= 0 || budget.ms <= 0) { exhausted = true; break; }
          const t0 = this.now();
          const vec = await embedder.embed(text.slice(0, EMBED_CHARS));
          const spent = Math.max(0, this.now() - t0);
          budget.embeds--; budget.ms -= spent; embedMs += spent; embedded++;
          this.opts.index.upsert({ ref: it.ref, key: it.key, platform: src.platform, at: it.at, fromUser, hash, embedding: vec });
          done++;
          await yieldLoop();
        }
        return done;
      };
      // 1. The newest messages of every source (a new message is searchable within a tick or two).
      for (const src of sources) {
        if (exhausted) break;
        const { items } = src.page(null, lim.headPage);
        await handle(src, items);
      }
      // 2. One sweep page per source, newest-first through the older messages; wraps at the end.
      const full = this.opts.index.counts().rows >= lim.maxIndexed;
      for (const src of sources) {
        if (exhausted || full) break;
        const cursor = this.cursors.get(src.platform) ?? null;
        const page = src.page(cursor, lim.sweepPage);
        const done = await handle(src, page.items);
        if (done === page.items.length) {
          this.cursors.set(src.platform, page.next);
          if (page.next === null) this.status.sweepsCompleted++;
        } else if (done > 0) {
          // Resume just after the last handled item: its key is the source's own cursor shape.
          this.cursors.set(src.platform, src.page(cursor, done).next);
        }
      }
      if (this.opts.index.counts().rows > lim.maxIndexed) this.opts.index.pruneTo(lim.maxIndexed);
      this.coverageCache = null;
      this.status.coverage = this.coverage();
    } finally {
      this.running = false;
      this.status.ticks++;
      this.status.embedded += embedded;
      this.status.embedMs += embedMs;
      this.status.lastTickAt = new Date(this.now()).toISOString();
      this.status.lastSkip = null;
    }
    return { ran: true, embedded, looked, embedMs, budget: exhausted };
  }

  /**
   * Fraction of the messages this machine holds that the index has looked at (embedded or ruled
   * too short), 0..1, cached for 30 s. Null when a source cannot count its messages.
   */
  coverage(): number | null {
    const t = this.now();
    if (this.coverageCache && t - this.coverageCache.at < 30_000) return this.coverageCache.value;
    let total = 0;
    let value: number | null;
    try {
      for (const s of this.opts.sources()) {
        const n = s.total();
        if (n === null) { total = -1; break; }
        total += n;
      }
      if (total < 0) value = null;
      else if (total === 0) value = 1;
      else value = Math.round(Math.min(1, this.opts.index.counts().rows / Math.min(total, this.limits.maxIndexed)) * 1000) / 1000;
    } catch { value = null; /* @silent-fallback-ok — coverage reads unknown (null), never a made-up number */ }
    this.coverageCache = { at: t, value };
    return value;
  }
}
