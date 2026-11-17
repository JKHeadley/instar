/**
 * QuotaHistoryLedger — the durable, bounded history of every quota reading
 * (docs/specs/quota-pacing-forecast.md §1). Read-only telemetry: nothing reads it to decide.
 *
 * Storage: append-only JSONL per account at `<stateDir>/state/quota-history/<accountId>.jsonl`.
 *   - The account id is checked against ^[a-z0-9-]+$ and the resolved path must stay inside the
 *     history folder, before any filesystem access. An id not in the local pool is not recorded.
 *   - Fixed 5-minute buckets keyed by floor(polledAt / 5 min). A later reading in the same bucket
 *     replaces the earlier one only when both have the same reset (within the shared tolerance)
 *     and validity; otherwise the earlier row is written first, so the last reading before a
 *     reset is never overwritten. The newest row is held in memory (the "tail") and flushed when
 *     its bucket closes, when its window state changes, or on shutdown.
 *   - Retention is round-robin (RRDtool-style): 14 days at full resolution, then one row per hour
 *     to 21 days (so the previous cycle can be replayed for calibration), then only the
 *     cycle-end row per weekly window. A hard cap of 5,000 rows per file is enforced on append and
 *     on load (oldest first, counted as droppedRows). Lines over 4 KB are skipped (malformedRows).
 *   - Compaction (hourly) and the retired-file sweep (daily) run on one unref'd timer, never in
 *     the poll call; loads and rewrites are asynchronous. One in-process writer per file.
 *   - Once a day files whose account left the local pool move to `retired/` (kept 35 days) and
 *     move back when the same id is enrolled again.
 *
 * Every cut is disclosed through `coverage()`. A failure here never reaches the poll result
 * (the poller wraps the call); async failures are counted as ledgerWriteFailures.
 *
 * The hourly tick row (`logs/quota-pacing.jsonl`) is the durable evidence the feature ladder reads.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { maybeRotateJsonlSegment } from '../utils/jsonl-rotation.js';
import { resolveDevAgentGate } from '../core/devAgentGate.js';
import { isQuotaPollSupportedAccount } from '../core/QuotaPoller.js';
import { isDeviceLimitBenched, type AccountQuotaSnapshot, type SubscriptionAccount } from '../core/SubscriptionPool.js';
import {
  ACCOUNT_ID_RE, HOUR_MS, PACING, identityKey, parseMs, sameReset, summarizeLogin, toHistoryWindow,
  type HistoryRow, type HistoryWindow, type LoginSummary, type OutcomeKind, type SlotStatus, type WindowKey,
} from './quotaPacing.js';

export const QUOTA_HISTORY = {
  FULL_RESOLUTION_MS: 14 * 24 * HOUR_MS,
  HOURLY_UNTIL_MS: 21 * 24 * HOUR_MS,
  MAX_ROWS: 5_000,
  MAX_LINE_BYTES: 4 * 1024,
  RETIRED_KEEP_MS: 35 * 24 * HOUR_MS,
  MAINTAIN_EVERY_MS: 5 * 60_000,
  TICK_LOG_MAX_BYTES: 5 * 1024 * 1024,
} as const;

/**
 * The switch: `subscriptionPool.pacing.enabled`, resolved through the development-agent gate
 * (the key is absent from defaults, so a dev agent is on and the fleet is off). Read per call.
 */
export function isQuotaPacingEnabled(config: unknown): boolean {
  const c = config as { developmentAgent?: boolean; subscriptionPool?: { pacing?: { enabled?: unknown } } } | undefined;
  const explicit = c?.subscriptionPool?.pacing?.enabled;
  return resolveDevAgentGate(typeof explicit === 'boolean' ? explicit : undefined, c);
}

export type QuotaHistoryInput =
  | { kind: 'snapshot'; snap: AccountQuotaSnapshot & { measuredAtSynthesized?: boolean; fableUnknown?: boolean }; drifted: boolean }
  | { kind: 'failed'; outcome: OutcomeKind; drifted: boolean };

/** What the poller depends on (injected through QuotaPoller.setHistoryLedger). */
export interface QuotaHistorySink {
  record(accountId: string, input: QuotaHistoryInput): void;
  /** The poller calls this when record() itself threw. */
  noteRecordFailure?(): void;
}

export interface AccountCoverage {
  rows: number;
  fullResolutionSince: string | null;
  hourlySince: string | null;
  cycleEndsKept: number;
  droppedRows: number;
  malformedRows: number;
  /** Earliest retained row's polledAt when rows were cut (droppedRows > 0), else null. */
  historyCutAt: string | null;
}

export interface LedgerCounters {
  ledgerWriteFailures: number;
  unattributedReads: number;
  invalidIds: number;
  futureClamped: number;
  malformedRows: number;
  droppedRows: number;
}

type PoolLike = { get(id: string): SubscriptionAccount | null; list(): SubscriptionAccount[] };

export interface QuotaHistoryLedgerOptions {
  /** The agent's `.instar` directory. */
  stateDir: string;
  /** Where the tick log goes (matches other monitors: `<stateDir>/../logs`). */
  logsDir: string;
  machineId: string;
  pool: PoolLike;
  /** Read per call: when off, nothing is written and no sweeps run. */
  enabled: () => boolean;
  now?: () => number;
}

interface AccountState {
  rows: HistoryRow[];
  tail: HistoryRow | null;
  loaded: boolean;
  droppedRows: number;
  malformedRows: number;
  needsRewrite: boolean;
  lastSeen: { polledAt: string; source: string | null } | null;
}

const WINDOW_KEYS: readonly WindowKey[] = ['fiveHour', 'sevenDay', 'fable'];
const bucketOf = (iso: string) => Math.floor(parseMs(iso) / PACING.BUCKET_MS);

/** Same window state: same outcome, identity, and per window same validity and reset. */
export function sameWindowState(a: HistoryRow, b: HistoryRow): boolean {
  if ((a.outcome ?? null) !== (b.outcome ?? null) || (a.identity ?? null) !== (b.identity ?? null)) return false;
  for (const k of WINDOW_KEYS) {
    const wa = a.windows?.[k], wb = b.windows?.[k];
    if (!wa && !wb) continue;
    if (!wa || !wb) return false;
    const va = !wa.invalid && wa.pct !== null, vb = !wb.invalid && wb.pct !== null;
    if (va !== vb) return false;
    if (va && !sameReset(parseMs(wa.resetsAt), parseMs(wb.resetsAt))) return false;
  }
  return true;
}

/** Validate a parsed row's shape (defence against a hand-edited or torn line). */
export function isHistoryRow(v: unknown): v is HistoryRow {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r.v !== 1 || typeof r.polledAt !== 'string' || !Number.isFinite(Date.parse(r.polledAt))) return false;
  if (!(r.measuredAt === null || (typeof r.measuredAt === 'string' && Number.isFinite(Date.parse(r.measuredAt))))) return false;
  if (!r.windows || typeof r.windows !== 'object' || Array.isArray(r.windows)) return false;
  for (const [k, w] of Object.entries(r.windows as Record<string, unknown>)) {
    if (!WINDOW_KEYS.includes(k as WindowKey) || !w || typeof w !== 'object') return false;
    const ww = w as Record<string, unknown>;
    if (!(ww.pct === null || (typeof ww.pct === 'number' && Number.isFinite(ww.pct)))) return false;
    if (!(ww.resetsAt === null || typeof ww.resetsAt === 'string')) return false;
  }
  return true;
}

/** Indexes of cycle-end rows: the last valid reading of each weekly window before its reset. */
export function cycleEndIndexes(rows: readonly HistoryRow[]): Set<number> {
  const ends = new Set<number>();
  for (const w of ['sevenDay', 'fable'] as const) {
    let lastIdx = -1;
    let lastReset = NaN;
    rows.forEach((r, i) => {
      const win = r.windows?.[w];
      if (r.outcome || !win) return;
      const valid = !win.invalid && win.pct !== null;
      if (!valid) { if (lastIdx >= 0) ends.add(lastIdx); lastIdx = -1; lastReset = NaN; return; }
      const reset = parseMs(win.resetsAt);
      if (lastIdx >= 0 && reset - lastReset > PACING.RESET_TOLERANCE_MS) ends.add(lastIdx);
      lastIdx = i;
      lastReset = reset;
    });
  }
  return ends;
}

/**
 * The retention transform (pure): full resolution for 14 days, the last row of each hour (plus
 * every cycle-end row) to 21 days, then only cycle-end rows. Rows must be in arrival order.
 */
export function compactRows(rows: readonly HistoryRow[], now: number): HistoryRow[] {
  const fullCut = now - QUOTA_HISTORY.FULL_RESOLUTION_MS;
  const hourlyCut = now - QUOTA_HISTORY.HOURLY_UNTIL_MS;
  const ends = cycleEndIndexes(rows);
  const lastInHour = new Map<number, number>();
  rows.forEach((r, i) => {
    const t = parseMs(r.polledAt);
    if (t < fullCut && t >= hourlyCut) lastInHour.set(Math.floor(t / HOUR_MS), i);
  });
  const keepHourly = new Set(lastInHour.values());
  const out: HistoryRow[] = [];
  rows.forEach((r, i) => {
    const t = parseMs(r.polledAt);
    if (t >= fullCut) { out.push(r); return; }
    if (t >= hourlyCut) {
      if (keepHourly.has(i) || ends.has(i)) out.push(r.resolution === 'cycle-end' ? r : { ...r, resolution: 'hourly' });
      return;
    }
    if (ends.has(i)) out.push({ ...r, resolution: 'cycle-end' });
  });
  return out;
}

export class QuotaHistoryLedger implements QuotaHistorySink {
  readonly dir: string;
  readonly retiredDir: string;
  readonly tickFile: string;
  private readonly accounts = new Map<string, AccountState>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly counters: LedgerCounters = { ledgerWriteFailures: 0, unattributedReads: 0, invalidIds: 0, futureClamped: 0, malformedRows: 0, droppedRows: 0 };
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastHour = -1;
  private lastDay = -1;
  private tickSource: (() => Promise<Record<string, unknown>>) | null = null;

  constructor(private readonly opts: QuotaHistoryLedgerOptions) {
    this.dir = path.resolve(opts.stateDir, 'state', 'quota-history');
    this.retiredDir = path.join(this.dir, 'retired');
    this.tickFile = path.join(opts.logsDir, 'quota-pacing.jsonl');
    this.now = opts.now ?? (() => Date.now());
  }

  /** The file for an id, or null when the id fails the pool rule or escapes the folder. */
  fileFor(accountId: string, base: string = this.dir): string | null {
    if (typeof accountId !== 'string' || accountId.length === 0 || accountId.length > 128 || !ACCOUNT_ID_RE.test(accountId)) return null;
    const file = path.resolve(base, `${accountId}.jsonl`);
    if (path.dirname(file) !== base) return null;
    return file;
  }

  // ── Recording ──────────────────────────────────────────────────────────────

  /** Record one read outcome. Synchronous and cheap; the write happens on the file's chain. */
  record(accountId: string, input: QuotaHistoryInput): void {
    if (!this.opts.enabled()) return;
    const file = this.fileFor(accountId);
    if (!file) { this.counters.invalidIds++; return; }
    const account = this.opts.pool.get(accountId);
    if (!account) { this.counters.unattributedReads++; return; }
    const row = this.buildRow(account, input);
    this.enqueue(accountId, () => this.recordNow(accountId, row));
  }

  noteRecordFailure(): void { this.counters.ledgerWriteFailures++; }

  private buildRow(account: SubscriptionAccount, input: QuotaHistoryInput): HistoryRow {
    const nowMs = this.now();
    const polledAt = new Date(nowMs).toISOString();
    const identity = identityKey(account.provider, account.email);
    if (input.kind === 'failed') {
      return { v: 1, polledAt, measuredAt: null, identity, source: null, drifted: input.drifted, windows: {}, outcome: input.outcome };
    }
    const snap = input.snap;
    let measuredAt = typeof snap.measuredAt === 'string' && Number.isFinite(Date.parse(snap.measuredAt)) ? snap.measuredAt : null;
    const synthesized = snap.measuredAtSynthesized === true || measuredAt === null;
    if (measuredAt === null) measuredAt = polledAt;
    if (Date.parse(measuredAt) - nowMs > PACING.FUTURE_CLAMP_MS) { measuredAt = polledAt; this.counters.futureClamped++; }
    const windows: Partial<Record<WindowKey, HistoryWindow>> = {};
    const five = toHistoryWindow(snap.fiveHour, nowMs);
    const seven = toHistoryWindow(snap.sevenDay, nowMs);
    const fable = toHistoryWindow(snap.fable, nowMs, snap.fableUnknown === true);
    if (five) windows.fiveHour = five;
    if (seven) windows.sevenDay = seven;
    if (fable) windows.fable = fable;
    const row: HistoryRow = { v: 1, polledAt, measuredAt, identity, source: snap.source ?? null, drifted: input.drifted, windows };
    if (synthesized) row.measuredAtSynthesized = true;
    if (snap.noQuotaWindow) row.noQuotaWindow = true;
    return row;
  }

  private enqueue(accountId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(accountId) ?? Promise.resolve();
    const next = prev.then(fn).catch((err) => { // @silent-fallback-ok: history is observational; the failure is counted and shown as reduced coverage
      this.counters.ledgerWriteFailures++;
      void err;
    });
    this.chains.set(accountId, next);
    return next;
  }

  private async recordNow(accountId: string, row: HistoryRow): Promise<void> {
    const st = await this.ensureLoaded(accountId);
    st.lastSeen = { polledAt: row.polledAt, source: row.source };
    const last = st.tail ?? st.rows[st.rows.length - 1] ?? null;
    // Re-reading the same usage file adds nothing: same measuredAt, same state → skip.
    if (last && !row.outcome && !last.outcome && row.measuredAt === last.measuredAt && sameWindowState(last, row) && last.source === row.source) return;
    if (st.tail && bucketOf(st.tail.polledAt) === bucketOf(row.polledAt) && sameWindowState(st.tail, row)) {
      st.tail = row;
      return;
    }
    if (st.tail) await this.appendRow(accountId, st, st.tail);
    st.tail = row;
  }

  private async appendRow(accountId: string, st: AccountState, row: HistoryRow): Promise<void> {
    const file = this.fileFor(accountId)!;
    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.appendFile(file, JSON.stringify(row) + '\n');
    st.rows.push(row);
    if (st.rows.length > QUOTA_HISTORY.MAX_ROWS) {
      const excess = st.rows.length - QUOTA_HISTORY.MAX_ROWS;
      st.rows.splice(0, excess); // oldest first: keeps the current cycle intact
      st.droppedRows += excess;
      this.counters.droppedRows += excess;
      st.needsRewrite = true;
    }
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  private async ensureLoaded(accountId: string): Promise<AccountState> {
    let st = this.accounts.get(accountId);
    if (st?.loaded) return st;
    st = { rows: [], tail: null, loaded: false, droppedRows: 0, malformedRows: 0, needsRewrite: false, lastSeen: null };
    this.accounts.set(accountId, st);
    const file = this.fileFor(accountId)!;
    const retired = this.fileFor(accountId, this.retiredDir)!;
    // Re-enrolled: bring the retired history back.
    if (!fs.existsSync(file) && fs.existsSync(retired)) {
      try { await fs.promises.rename(retired, file); } catch { /* @silent-fallback-ok: a failed restore starts a fresh history; the retired copy ages out */ }
    }
    let text = '';
    try { text = await fs.promises.readFile(file, 'utf8'); } catch { /* @silent-fallback-ok: no file yet is an empty history */ }
    const rows: HistoryRow[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      if (Buffer.byteLength(line) > QUOTA_HISTORY.MAX_LINE_BYTES) { st.malformedRows++; continue; }
      try {
        const v = JSON.parse(line) as unknown;
        if (isHistoryRow(v)) rows.push(v); else st.malformedRows++;
      } catch { st.malformedRows++; }
    }
    this.counters.malformedRows += st.malformedRows;
    if (rows.length > QUOTA_HISTORY.MAX_ROWS) {
      const excess = rows.length - QUOTA_HISTORY.MAX_ROWS;
      rows.splice(0, excess);
      st.droppedRows += excess;
      this.counters.droppedRows += excess;
      st.needsRewrite = true;
    }
    st.rows = rows;
    st.loaded = true;
    return st;
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  /** This account's rows (including the in-memory tail), or null for a refused id. */
  async rows(accountId: string): Promise<HistoryRow[] | null> {
    if (!this.fileFor(accountId)) return null;
    await (this.chains.get(accountId) ?? Promise.resolve());
    const st = await this.ensureLoaded(accountId);
    return st.tail ? [...st.rows, st.tail] : [...st.rows];
  }

  lastSeen(accountId: string): { polledAt: string; source: string | null } | null {
    return this.accounts.get(accountId)?.lastSeen ?? null;
  }

  async coverage(accountId: string): Promise<AccountCoverage | null> {
    const rows = await this.rows(accountId);
    if (!rows) return null;
    const st = this.accounts.get(accountId)!;
    const firstOf = (pred: (r: HistoryRow) => boolean) => rows.find(pred)?.polledAt ?? null;
    return {
      rows: rows.length,
      fullResolutionSince: firstOf((r) => !r.resolution || r.resolution === 'full'),
      hourlySince: firstOf((r) => r.resolution === 'hourly'),
      cycleEndsKept: rows.filter((r) => r.resolution === 'cycle-end').length,
      droppedRows: st.droppedRows,
      malformedRows: st.malformedRows,
      historyCutAt: st.droppedRows > 0 ? (rows[0]?.polledAt ?? null) : null,
    };
  }

  stats(): LedgerCounters { return { ...this.counters }; }

  // ── Maintenance ────────────────────────────────────────────────────────────

  /** Write every tail whose bucket has closed (or every tail, when `force`). */
  async flush(force = false): Promise<void> {
    await Promise.all([...this.chains.values()]); // let queued records land first
    const nowBucket = Math.floor(this.now() / PACING.BUCKET_MS);
    const work: Promise<void>[] = [];
    for (const [id, st] of this.accounts) {
      if (!st.tail) continue;
      if (!force && bucketOf(st.tail.polledAt) >= nowBucket) continue;
      work.push(this.enqueue(id, async () => {
        if (!st.tail) return;
        if (!force && bucketOf(st.tail.polledAt) >= nowBucket) return;
        const t = st.tail;
        st.tail = null;
        await this.appendRow(id, st, t);
      }));
    }
    await Promise.all(work);
  }

  /** Apply the retention transform to every loaded file; rewrite atomically when it changed. */
  async compactAll(): Promise<void> {
    if (!this.opts.enabled()) return;
    const now = this.now();
    const work: Promise<void>[] = [];
    for (const id of await this.historyIds()) {
      work.push(this.enqueue(id, async () => {
        const st = await this.ensureLoaded(id);
        const next = compactRows(st.rows, now);
        if (next.length === st.rows.length && !st.needsRewrite && next.every((r, i) => r === st.rows[i])) return;
        await this.rewrite(id, next);
        st.rows = next;
        st.needsRewrite = false;
      }));
    }
    await Promise.all(work);
  }

  /** Temp file then rename (same folder, so atomic). */
  private async rewrite(accountId: string, rows: HistoryRow[]): Promise<void> {
    const file = this.fileFor(accountId)!;
    const tmp = path.join(this.dir, `.${accountId}.jsonl.${process.pid}.tmp`);
    try {
      await fs.promises.writeFile(tmp, rows.map((r) => JSON.stringify(r) + '\n').join(''));
      await fs.promises.rename(tmp, file);
    } catch (err) {
      try { if (fs.existsSync(tmp)) await SafeFsExecutor.safeUnlink(tmp, { operation: 'QuotaHistoryLedger.rewrite:cleanup-temp' }); } catch { /* @silent-fallback-ok: a stray temp file is harmless and replaced next hour */ }
      throw err;
    }
  }

  private async historyIds(): Promise<string[]> {
    const ids = new Set<string>(this.accounts.keys());
    try {
      for (const name of await fs.promises.readdir(this.dir)) {
        if (!name.endsWith('.jsonl')) continue;
        const id = name.slice(0, -'.jsonl'.length);
        if (this.fileFor(id)) ids.add(id);
      }
    } catch { /* @silent-fallback-ok: no folder yet means no history */ }
    return [...ids];
  }

  /** Move files of accounts no longer in the local pool to retired/; delete retired files past 35 days. */
  async sweepRetired(): Promise<{ retired: string[]; deleted: string[] }> {
    const retired: string[] = [];
    const deleted: string[] = [];
    if (!this.opts.enabled()) return { retired, deleted };
    const known = new Set(this.opts.pool.list().map((a) => a.id));
    for (const id of await this.historyIds()) {
      if (known.has(id)) continue;
      await this.enqueue(id, async () => {
        const st = this.accounts.get(id);
        if (st?.tail) { const t = st.tail; st.tail = null; await this.appendRow(id, st, t); }
        const from = this.fileFor(id)!;
        if (!fs.existsSync(from)) { this.accounts.delete(id); return; }
        await fs.promises.mkdir(this.retiredDir, { recursive: true });
        const to = this.fileFor(id, this.retiredDir)!;
        await fs.promises.rename(from, to);
        const t = new Date(this.now());
        await fs.promises.utimes(to, t, t); // the 35-day keep counts from retirement
        this.accounts.delete(id);
        retired.push(id);
      });
    }
    let names: string[] = [];
    try { names = await fs.promises.readdir(this.retiredDir); } catch { /* @silent-fallback-ok: no retired folder */ }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const full = this.fileFor(name.slice(0, -'.jsonl'.length), this.retiredDir);
      if (!full) continue;
      try {
        const st = await fs.promises.stat(full);
        if (this.now() - st.mtimeMs > QUOTA_HISTORY.RETIRED_KEEP_MS) {
          await SafeFsExecutor.safeUnlink(full, { operation: 'QuotaHistoryLedger.sweepRetired:expired' });
          deleted.push(name);
        }
      } catch { this.counters.ledgerWriteFailures++; }
    }
    return { retired, deleted };
  }

  /** Source of the hourly tick row's computed fields (accounts, stale reasons, verdicts). */
  setTickSource(source: (() => Promise<Record<string, unknown>>) | null): void { this.tickSource = source; }

  /** Write one tick row to logs/quota-pacing.jsonl. */
  async writeTick(): Promise<Record<string, unknown> | null> {
    if (!this.opts.enabled()) return null;
    let computed: Record<string, unknown> = {};
    try { computed = (await this.tickSource?.()) ?? {}; } catch { computed = { tickSourceFailed: true }; }
    const c = this.stats();
    const row = {
      ts: new Date(this.now()).toISOString(), kind: 'tick', machineId: this.opts.machineId,
      ...computed,
      ledgerWriteFailures: c.ledgerWriteFailures, malformedRows: c.malformedRows, droppedRows: c.droppedRows,
      unattributedReads: c.unattributedReads,
      healthy: c.ledgerWriteFailures === 0 && computed.tickSourceFailed !== true,
    };
    await fs.promises.mkdir(path.dirname(this.tickFile), { recursive: true });
    maybeRotateJsonlSegment(this.tickFile, { maxBytes: QUOTA_HISTORY.TICK_LOG_MAX_BYTES, keepSegments: 4 });
    await fs.promises.appendFile(this.tickFile, JSON.stringify(row) + '\n');
    return row;
  }

  /** One maintenance pass: flush closed buckets; hourly compaction + tick; daily retire sweep. */
  async maintain(): Promise<void> {
    if (!this.opts.enabled()) return;
    const now = this.now();
    await this.flush(false);
    const hour = Math.floor(now / HOUR_MS);
    if (this.lastHour === -1) this.lastHour = hour;
    if (hour !== this.lastHour) {
      this.lastHour = hour;
      await this.compactAll();
      await this.writeTick();
    }
    const day = Math.floor(now / (24 * HOUR_MS));
    if (this.lastDay === -1) this.lastDay = day;
    if (day !== this.lastDay) {
      this.lastDay = day;
      await this.sweepRetired();
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.maintain().catch(() => { this.counters.ledgerWriteFailures++; }); // @silent-fallback-ok: counted; retried next pass
    }, QUOTA_HISTORY.MAINTAIN_EVERY_MS);
    this.timer.unref?.();
  }

  /** Stop the timer and write every held tail (shutdown). */
  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    await this.flush(true);
  }
}

// ── Local summaries (what this machine serves at ?scope=local) ────────────────

export interface LocalPacingOptions {
  machineId: string;
  pollIntervalMs: number;
  now: number;
}

/** The effective read interval: the poll interval, or the backed-off interval while benched. */
export function readIntervalFor(account: SubscriptionAccount, pollIntervalMs: number, lastPolledAtMs: number | null): number {
  if (!isDeviceLimitBenched(account)) return pollIntervalMs;
  if (account.deviceLimitReadsStopped) return 30 * 24 * HOUR_MS;
  const next = Date.parse(account.deviceLimitNextReadAt ?? '');
  if (!Number.isFinite(next) || lastPolledAtMs === null) return Math.max(pollIntervalMs, HOUR_MS);
  return Math.max(pollIntervalMs, next - lastPolledAtMs);
}

/** Build this machine's per-login summaries from its own history. */
export async function buildLocalSummaries(ledger: QuotaHistoryLedger, pool: PoolLike, opts: LocalPacingOptions): Promise<{ summaries: LoginSummary[]; coverage: Record<string, AccountCoverage> }> {
  const summaries: LoginSummary[] = [];
  const coverage: Record<string, AccountCoverage> = {};
  for (const account of pool.list()) {
    if (!isQuotaPollSupportedAccount(account) || !ACCOUNT_ID_RE.test(account.id)) continue;
    const rows = (await ledger.rows(account.id)) ?? [];
    const cov = await ledger.coverage(account.id);
    if (cov) coverage[account.id] = cov;
    const lastPolled = rows.length ? parseMs(rows[rows.length - 1].polledAt) : null;
    const status = account.status as SlotStatus;
    summaries.push(summarizeLogin(rows, {
      accountId: account.id, provider: account.provider, framework: account.framework, machineId: opts.machineId,
      identity: identityKey(account.provider, account.email), status,
      drifted: account.identityDrifted === true, benched: isDeviceLimitBenched(account),
      readIntervalMs: readIntervalFor(account, opts.pollIntervalMs, lastPolled),
      historyCutAtMs: cov?.historyCutAt ? parseMs(cov.historyCutAt) : null,
    }, opts.now));
  }
  return { summaries, coverage };
}
