/**
 * The Anchor and ledger backfill lane (context-budget-layered-summaries §6.1,
 * decision 9, §12 "Backfill daily cap", §14, §15; Phase 1 slice S7).
 *
 * Existing topics are rebuilt from TopicMemory only: U lists the topic's
 * sender rows (bounded pages), then `AnchorLedger.backfillTopic` keeps the
 * Anchor, binds history and re-derives the ledger, writing operator-bound
 * history entries as `backfilled-unconfirmed`. No model call is made here:
 * the entries come from the refs and referent stubs the extractor already
 * wrote, inside its own budgeted calls.
 *
 * The lane:
 *  - runs on the topic's OWNER only (`isOwner`: a single machine is trivially
 *    the owner; with pool placement live, the ownership record must name this
 *    machine). `false` and `unknown` both skip, counted apart;
 *  - takes topics in recency order (TopicMemory's last activity, newest
 *    first), a topic already in progress first so it finishes;
 *  - starts at most `BACKFILL_DAILY_TOPIC_CAP` topics per UTC day (a topic
 *    resumed on a later day counts on that day);
 *  - is resumable: a durable per-topic record (`in-progress | done | failed`,
 *    attempts, the history bound taken at the first attempt) and the day's
 *    counter live in one small file, so a restart neither redoes a finished
 *    topic nor skips one that was cut off;
 *  - runs in the background (a timer, a few topics per tick, a yield between
 *    U pages), never on a reply's path and never blocking a phase; it sends
 *    nothing and asks nothing (the confirmation waits for the next reply in a
 *    topic the user has written in since).
 *
 * Behind `contextBudget.enabled` (the layers) and its own switch,
 * `contextBudget.backfill.enabled` (default off), read on every tick.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';

/** The feature id the maturation ladder reads (src/data/feature-ladders.json). */
export const BACKFILL_FEATURE_ID = 'contextBudget.backfill';
/** §12 Defaults: 20 topics per day, topic-recency order. */
export const BACKFILL_DAILY_TOPIC_CAP = 20;
/** Topics worked per tick (each a bounded amount of file work). */
export const BACKFILL_TOPICS_PER_TICK = 2;
/** U pages (of REFRESH_ROWS rows each) listed per topic per tick; the rest resumes next tick. */
export const BACKFILL_U_PAGES_PER_TICK = 5;
/** A topic that fails (throws) this many times is parked as `failed` and reported once. */
export const BACKFILL_MAX_ATTEMPTS = 3;
/**
 * A topic still listing U after this many ticks is parked as `failed`
 * (`stalled`) and reported once, so it can never hold the lane's slots for
 * ever. basis: 40 ticks × 5 pages × 200 rows = 40,000 rows, far beyond any
 * topic's history; a listing that has not finished by then is stuck.
 */
export const BACKFILL_MAX_TICKS_PER_TOPIC = 40;
/** The lane's tick. */
export const BACKFILL_TICK_MS = 10 * 60_000;

export type BackfillTopicStatus = 'in-progress' | 'done' | 'failed';

export interface BackfillTopicRecord {
  status: BackfillTopicStatus;
  /** Failed (thrown) attempts. */
  attempts: number;
  /** Ticks that worked this topic (a resume is a tick, not a failure). */
  ticks?: number;
  firstAt: number;
  lastAt: number;
  doneAt?: number;
  /** The topic's latest message id at the first attempt: messages up to it are history. */
  historyThroughMessageId: number | null;
  /** `lane`: rebuilt here; `replicated`: the Anchor record already carried a backfill (a former owner did it). */
  source?: 'lane' | 'replicated';
  result?: { anchor: string; entries: number; backfilledUnconfirmed: number };
  lastError?: string;
}

interface StateFile {
  version: 1;
  day: string;
  /** Topics started (counted against the cap) on `day`. */
  startedToday: number[];
  topics: Record<string, BackfillTopicRecord>;
}

export interface BackfillLaneCounters {
  ticks: number;
  skippedOff: number;
  skippedShed: number;
  skippedNotOwner: number;
  skippedOwnerUnknown: number;
  capReached: number;
  pagesListed: number;
  topicsDone: number;
  topicsResumed: number;
  topicsReplicated: number;
  failures: number;
  persistFailed: number;
  stateUnreadable: number;
}

export interface BackfillLaneDeps {
  /** `contextBudget.backfill.enabled`, read live. */
  enabled(): boolean;
  /** TopicMemory's topics with their last activity (recency order is re-applied here). */
  topics(): Array<{ topicId: number; lastActivity: string }>;
  /** Does this machine own the topic? `unknown` never reads as yes. */
  isOwner(topicId: number): boolean | 'unknown';
  /** The topic's latest message id in TopicMemory (null when it has none). */
  latestMessageId(topicId: number): number | null;
  userCorpus: { refresh(topicId: number): { complete: boolean }; backfilling(topicId: number): boolean };
  ledger: {
    backfillTopic(topicId: number, o: { historyThroughMessageId: number | null }):
      | { ran: false; reason: string }
      | { ran: true; anchor: string; entries: number; backfilledUnconfirmed: number };
  };
  /** True when the topic's (replicated) Anchor record already carries a backfill. */
  alreadyBackfilled?(topicId: number): boolean;
  /** Quota pressure: skip the tick. */
  shouldShed?(): boolean;
  /** One degradation per failed topic, and on an unreadable or unwritable state file. */
  onDegraded?(e: { kind: 'topic-failed' | 'topic-stalled' | 'state-unreadable' | 'persist-failed'; topicId?: number; reason: string }): void;
  /**
   * featureEvidence rows for the ladder: `fired` per topic finished WITH ledger
   * entries, `outcome` per topic finished with the Anchor only (no refs in its
   * history), `error` per failed attempt.
   */
  onEvidence?(kind: 'fired' | 'outcome' | 'error', reason: string, context: Record<string, string | number | boolean | null>): void;
  file: string;
  now?: () => number;
  dailyCap?: number;
  perTick?: number;
  pagesPerTick?: number;
  /** A yield between units of work (default setImmediate). */
  yieldFn?: () => Promise<void>;
}

/**
 * The owner rule the lane runs under (§14: "a single machine is trivially the
 * owner"; in a pool, the ownership record must name this machine; never "the
 * lease holder"). Pool placement not live ⇒ this machine owns every topic only
 * when it is the agent's only machine; otherwise `unknown`.
 * Live ⇒ the record's owner must be this machine; no record, no registry, no
 * mesh identity or a throwing read ⇒ `unknown`, which the lane never reads as yes.
 */
export function topicOwnerCheck(o: {
  poolPlacementLive: () => boolean;
  /** More than one machine in this agent's pool (`unknown` when it cannot be read). */
  multiMachine: () => boolean | 'unknown';
  /** The ACTIVE ownership record's owner (§14: "with the record active"); anything else ⇒ null. */
  ownerOf: ((topicKey: string) => string | null | undefined) | null;
  selfId: () => string | null | undefined;
}): (topicId: number) => boolean | 'unknown' {
  return (topicId) => {
    if (!o.poolPlacementLive()) {
      // Only a single machine owns every topic; a machine of a pool whose placement is dark cannot tell.
      let many: boolean | 'unknown' = 'unknown';
      try { many = o.multiMachine(); } catch { many = 'unknown'; /* @silent-fallback-ok — an unanswerable machine count is never a yes */ }
      return many === false ? true : 'unknown';
    }
    const self = o.selfId();
    if (!o.ownerOf || !self) return 'unknown';
    let owner: string | null | undefined;
    try { owner = o.ownerOf(String(topicId)); } catch { return 'unknown'; /* @silent-fallback-ok — an unreadable ownership record is never a yes */ }
    return owner === null || owner === undefined ? 'unknown' : owner === self;
  };
}

export function backfillStateFile(stateDir: string): string {
  return path.join(stateDir, 'server-data', 'context-budget-backfill.json');
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export class BackfillLane {
  readonly counters: BackfillLaneCounters = {
    ticks: 0, skippedOff: 0, skippedShed: 0, skippedNotOwner: 0, skippedOwnerUnknown: 0, capReached: 0,
    pagesListed: 0, topicsDone: 0, topicsResumed: 0, topicsReplicated: 0, failures: 0, persistFailed: 0, stateUnreadable: 0,
  };
  private state: StateFile | null = null;
  private running = false;
  private lastTickAt: number | null = null;
  private lastResult: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly d: BackfillLaneDeps) {}

  private now(): number { return (this.d.now ?? Date.now)(); }
  private get cap(): number { return this.d.dailyCap ?? BACKFILL_DAILY_TOPIC_CAP; }
  private yieldNow(): Promise<void> { return this.d.yieldFn ? this.d.yieldFn() : new Promise((r) => setImmediate(r)); }

  private load(): StateFile {
    if (this.state) return this.state;
    let s: StateFile | null = null;
    try {
      if (fs.existsSync(this.d.file)) {
        const raw = JSON.parse(fs.readFileSync(this.d.file, 'utf-8')) as Partial<StateFile>;
        if (raw && raw.version === 1 && typeof raw.day === 'string' && Array.isArray(raw.startedToday) && raw.topics && typeof raw.topics === 'object') s = raw as StateFile;
        else throw new Error('unrecognised shape');
      }
    } catch (err) {
      // A redo is safe (every step is idempotent), so an unreadable file restarts the lane's bookkeeping, loudly.
      this.counters.stateUnreadable++;
      this.d.onDegraded?.({ kind: 'state-unreadable', reason: err instanceof Error ? err.message : String(err) });
    }
    this.state = s ?? { version: 1, day: dayOf(this.now()), startedToday: [], topics: {} };
    return this.state;
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.d.file), { recursive: true });
      SafeFsExecutor.atomicWriteJsonSync(this.d.file, this.state, { operation: 'BackfillLane.persist', mode: 0o600 });
    } catch (err) {
      this.counters.persistFailed++;
      if (this.counters.persistFailed === 1) this.d.onDegraded?.({ kind: 'persist-failed', reason: err instanceof Error ? err.message : String(err) });
    }
  }

  /** One pass. Never throws. */
  async tick(): Promise<{ ran: boolean; reason?: string; worked: number[] }> {
    if (this.running) return { ran: false, reason: 'already-running', worked: [] };
    this.running = true;
    this.counters.ticks++;
    this.lastTickAt = this.now();
    const worked: number[] = [];
    try {
      let on = false;
      try { on = this.d.enabled(); } catch { on = false; /* @silent-fallback-ok — an unreadable switch reads as off */ }
      if (!on) { this.counters.skippedOff++; this.lastResult = 'switch-off'; return { ran: false, reason: 'switch-off', worked }; }
      if (this.d.shouldShed?.()) { this.counters.skippedShed++; this.lastResult = 'shed'; return { ran: false, reason: 'shed', worked }; }
      const s = this.load();
      const today = dayOf(this.now());
      if (s.day !== today) { s.day = today; s.startedToday = []; this.persist(); }

      // Recency order (newest first); a topic already in progress first, so it finishes.
      const listed = [...this.d.topics()]
        .filter((t) => Number.isSafeInteger(t.topicId))
        .sort((a, b) => (Date.parse(b.lastActivity) || 0) - (Date.parse(a.lastActivity) || 0));
      const open = listed.filter((t) => { const r = s.topics[String(t.topicId)]; return !r || r.status === 'in-progress'; });
      const order = [...open.filter((t) => s.topics[String(t.topicId)]?.status === 'in-progress'), ...open.filter((t) => !s.topics[String(t.topicId)])];

      for (const t of order) {
        if (worked.length >= (this.d.perTick ?? BACKFILL_TOPICS_PER_TICK)) break;
        const key = String(t.topicId);
        let owner: boolean | 'unknown' = 'unknown';
        try { owner = this.d.isOwner(t.topicId); } catch { owner = 'unknown'; /* @silent-fallback-ok — an unanswerable owner check is never a yes */ }
        if (owner === 'unknown') { this.counters.skippedOwnerUnknown++; continue; }
        if (!owner) { this.counters.skippedNotOwner++; continue; }
        if (!s.topics[key] && this.d.alreadyBackfilled?.(t.topicId)) {
          // A former owner rebuilt it (the Anchor record replicated): nothing to redo, no cap spent.
          s.topics[key] = { status: 'done', attempts: 0, firstAt: this.now(), lastAt: this.now(), doneAt: this.now(), historyThroughMessageId: null, source: 'replicated' };
          this.counters.topicsReplicated++;
          this.persist();
          continue;
        }
        const counted = s.startedToday.includes(t.topicId);
        if (!counted && s.startedToday.length >= this.cap) { this.counters.capReached++; this.lastResult = 'cap-reached'; break; }
        if (!counted) s.startedToday.push(t.topicId);
        const prev = s.topics[key];
        if (prev) this.counters.topicsResumed++;
        const rec: BackfillTopicRecord = prev ?? { status: 'in-progress', attempts: 0, firstAt: this.now(), lastAt: this.now(), historyThroughMessageId: null };
        if (!prev) {
          let latest: number | null = null;
          try { latest = this.d.latestMessageId(t.topicId); } catch { latest = null; /* @silent-fallback-ok — no bound means the live pass binds history instead */ }
          rec.historyThroughMessageId = latest;
        }
        rec.ticks = (rec.ticks ?? 0) + 1;
        rec.lastAt = this.now();
        s.topics[key] = rec;
        this.persist();
        worked.push(t.topicId);
        await this.workTopic(t.topicId, rec);
        this.persist();
        await this.yieldNow();
      }
      if (this.lastResult !== 'cap-reached' || worked.length > 0) this.lastResult = worked.length > 0 ? `worked ${worked.length}` : 'nothing-to-do';
      return { ran: true, worked };
    } catch (err) {
      // @silent-fallback-ok — a background lane; counted, reported through the next tick's record, never on a reply's path
      this.counters.failures++;
      this.lastResult = `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
      return { ran: false, reason: 'error', worked };
    } finally {
      this.running = false;
    }
  }

  private async workTopic(topicId: number, rec: BackfillTopicRecord): Promise<void> {
    try {
      // U first: the Anchor and every binding read its labels.
      const pages = this.d.pagesPerTick ?? BACKFILL_U_PAGES_PER_TICK;
      for (let i = 0; i < pages; i++) {
        const r = this.d.userCorpus.refresh(topicId);
        this.counters.pagesListed++;
        if (r.complete && !this.d.userCorpus.backfilling(topicId)) break;
        await this.yieldNow();
      }
      if (this.d.userCorpus.backfilling(topicId)) {
        rec.status = 'in-progress';
        if ((rec.ticks ?? 0) >= BACKFILL_MAX_TICKS_PER_TOPIC) {
          rec.status = 'failed';
          rec.lastError = `stalled: U still listing after ${rec.ticks} ticks`;
          this.counters.failures++;
          this.d.onDegraded?.({ kind: 'topic-stalled', topicId, reason: rec.lastError });
        }
        return;
      }
      const res = this.d.ledger.backfillTopic(topicId, { historyThroughMessageId: rec.historyThroughMessageId });
      if (!res.ran) { rec.status = 'in-progress'; rec.lastError = res.reason; return; }
      // No Anchor record means its write failed: retried, never recorded done.
      if (res.anchor === 'not-yet-evaluated') throw new Error('anchor record not written');
      rec.status = 'done';
      rec.doneAt = this.now();
      rec.source = 'lane';
      rec.result = { anchor: res.anchor, entries: res.entries, backfilledUnconfirmed: res.backfilledUnconfirmed };
      delete rec.lastError;
      this.counters.topicsDone++;
      if (res.entries > 0) this.d.onEvidence?.('fired', 'topic backfilled', { topicId, ...rec.result });
      else this.d.onEvidence?.('outcome', 'topic backfilled with the Anchor only (no refs in its history)', { topicId, ...rec.result });
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      rec.lastError = reason;
      rec.attempts++;
      this.counters.failures++;
      this.d.onEvidence?.('error', 'topic backfill attempt failed', { topicId, attempts: rec.attempts });
      if (rec.attempts >= BACKFILL_MAX_ATTEMPTS) {
        rec.status = 'failed';
        this.d.onDegraded?.({ kind: 'topic-failed', topicId, reason });
      } else rec.status = 'in-progress';
    }
  }

  /** Start the background timer (first tick after `firstMs`). */
  start(o: { firstMs?: number; everyMs?: number } = {}): void {
    if (this.timer) return;
    this.firstTimer = setTimeout(() => { void this.tick(); }, o.firstMs ?? 120_000);
    this.firstTimer.unref?.();
    this.timer = setInterval(() => { void this.tick(); }, o.everyMs ?? BACKFILL_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.timer = null; this.firstTimer = null;
  }

  status() {
    const s = this.load();
    const recs = Object.values(s.topics);
    let enabled = false;
    try { enabled = this.d.enabled(); } catch { enabled = false; /* @silent-fallback-ok — status reads the switch as off */ }
    const today = dayOf(this.now());
    const startedToday = s.day === today ? s.startedToday.length : 0;
    return {
      wired: true as const,
      enabled,
      dailyCap: this.cap,
      day: today,
      startedToday,
      capReachedToday: startedToday >= this.cap,
      topics: {
        done: recs.filter((r) => r.status === 'done').length,
        inProgress: recs.filter((r) => r.status === 'in-progress').length,
        failed: recs.filter((r) => r.status === 'failed').length,
      },
      lastTickAt: this.lastTickAt,
      lastResult: this.lastResult,
      counters: { ...this.counters },
    };
  }

  /** One topic's durable record (tests, the route). */
  topicRecord(topicId: number): BackfillTopicRecord | null { return this.load().topics[String(topicId)] ?? null; }
}
