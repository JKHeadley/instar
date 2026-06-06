/**
 * PendingPullLedger — P2.2 of multi-machine coherence: the durable record of
 * working-set pulls that could not complete because the producer was
 * offline / unreachable / revoked / mid-run. The EXO case, solved: the
 * request survives restarts and re-fires the moment the peer returns.
 *
 * Spec: docs/specs/WORKING-SET-HANDOFF-SPEC.md §3.4.
 *
 * SINGLE-WRITER DISCIPLINE (the topic-flood-#3 lesson, applied at birth):
 * SIX mutators can overlap on one tick (onAccepted scheduler, reappearance
 * re-arm, run-stopped re-arm, attempt/breaker update, reflex route, TTL
 * sweep). ALL mutations route through ONE serialized `mutate(fn)` funnel —
 * an in-process async queue, so read-modify-write never interleaves — with
 * temp-file + atomic-rename persistence.
 *
 * PARSE-FAILURE POSTURE (the flood's second root): a corrupt/unparseable
 * ledger is NEVER read as "no pending pulls" — the file is quarantined
 * aside (`.corrupt-<ts>`), ONE notice fires through the injected
 * `onCorrupt` seam ("pending-pull ledger unreadable — stranded-recovery
 * records may be lost"), and a fresh ledger starts.
 *
 * Store path: `state/coherence-journal/pending-pulls.json` — registered in
 * the State-Coherence Registry (machine-local; the records describe THIS
 * machine's outstanding fetches).
 */

import fs from 'node:fs';
import path from 'node:path';

export const PENDING_PULLS_FILENAME = 'pending-pulls.json';
export const DEFAULT_PENDING_PULL_TTL_DAYS = 7;
/** Per-record attempt cap — the (peer,topic,epoch) breaker (§3.4). */
export const DEFAULT_ATTEMPT_CAP = 6;

export type PendingPullReason =
  | 'peer-offline'
  | 'peer-unreachable'
  | 'peer-revoked'
  | 'live-source'
  | 'busy-exhausted';

export interface PendingPullRecord {
  topic: number;
  epoch: number;
  nominee: string;
  reason: PendingPullReason;
  createdAt: string;
  attempts: number;
  lastAttemptAt: string | null;
}

export interface PendingPullLedgerConfig {
  /** Absolute path to the agent's `.instar/` directory. */
  stateDir: string;
  ttlDays?: number;
  attemptCap?: number;
  now?: () => Date;
  /**
   * Fired ONCE per corrupt-quarantine episode (agent-health lane upstream).
   * Never throws into the ledger.
   */
  onCorrupt?: (quarantinedPath: string) => void;
  /**
   * Fired once per record on TTL expiry — "topic T's working set on
   * <machine> was never recovered" (§3.4). Never throws into the ledger.
   */
  onExpired?: (record: PendingPullRecord) => void;
  logger?: (msg: string) => void;
}

interface LedgerFileShape {
  version: 1;
  records: PendingPullRecord[];
}

function recordKey(r: { topic: number; epoch: number; nominee: string }): string {
  return `${r.topic}:${r.epoch}:${r.nominee}`;
}

export class PendingPullLedger {
  private readonly file: string;
  private readonly ttlMs: number;
  private readonly attemptCap: number;
  private readonly now: () => Date;
  private readonly onCorrupt?: (p: string) => void;
  private readonly onExpired?: (r: PendingPullRecord) => void;
  private readonly logger: (msg: string) => void;

  /** The serialized mutate() funnel — read-modify-write never interleaves. */
  private queue: Promise<unknown> = Promise.resolve();
  /** In-memory truth between mutations (loaded once, kept current). */
  private records: PendingPullRecord[] | null = null;
  private corruptNotified = false;

  constructor(config: PendingPullLedgerConfig) {
    this.file = path.join(config.stateDir, 'state', 'coherence-journal', PENDING_PULLS_FILENAME);
    this.ttlMs = (config.ttlDays ?? DEFAULT_PENDING_PULL_TTL_DAYS) * 24 * 60 * 60 * 1000;
    this.attemptCap = config.attemptCap ?? DEFAULT_ATTEMPT_CAP;
    this.now = config.now ?? (() => new Date());
    this.onCorrupt = config.onCorrupt;
    this.onExpired = config.onExpired;
    this.logger = config.logger ?? (() => {});
  }

  // ---- public API (every mutation rides the funnel) ------------------------

  /**
   * File (or refresh) a pending pull. Idempotent on (topic, epoch, nominee):
   * an existing record keeps its createdAt/attempts; only `reason` refreshes.
   */
  async file_(rec: { topic: number; epoch: number; nominee: string; reason: PendingPullReason }): Promise<void> {
    await this.mutate((records) => {
      const key = recordKey(rec);
      const existing = records.find((r) => recordKey(r) === key);
      if (existing) {
        existing.reason = rec.reason;
        return records;
      }
      records.push({
        ...rec,
        createdAt: this.now().toISOString(),
        attempts: 0,
        lastAttemptAt: null,
      });
      return records;
    });
  }

  /**
   * Record a GENUINE failed attempt (offline / unreachable / refused /
   * verify-failed). `busy` responses MUST NOT come through here — busy is
   * retry-without-penalty (§3.2); a throttled drain must never exhaust the
   * very records it exists to recover.
   */
  async recordAttempt(topic: number, epoch: number, nominee: string): Promise<void> {
    await this.mutate((records) => {
      const r = records.find((x) => x.topic === topic && x.epoch === epoch && x.nominee === nominee);
      if (r) {
        r.attempts += 1;
        r.lastAttemptAt = this.now().toISOString();
      }
      return records;
    });
  }

  /** A completed pull clears its record. */
  async clear(topic: number, epoch: number, nominee: string): Promise<void> {
    await this.mutate((records) =>
      records.filter((r) => !(r.topic === topic && r.epoch === epoch && r.nominee === nominee)),
    );
  }

  /**
   * Supersession (§3.4): a newer epoch for the topic clears ALL records for
   * that topic with `epoch < newEpoch`, across all nominees — a partial clear
   * must never strand a sibling record.
   */
  async supersede(topic: number, newEpoch: number): Promise<void> {
    await this.mutate((records) =>
      records.filter((r) => !(r.topic === topic && r.epoch < newEpoch)),
    );
  }

  /**
   * TTL sweep: expire records older than ttlDays — each surfaced ONCE via
   * onExpired ("never recovered"), then removed. Run on a slow cadence by the
   * caller (it is one of the six mutators, so it rides the funnel too).
   * Returns the expired records.
   */
  async sweepExpired(): Promise<PendingPullRecord[]> {
    const expired: PendingPullRecord[] = [];
    await this.mutate((records) => {
      const nowMs = this.now().getTime();
      const kept: PendingPullRecord[] = [];
      for (const r of records) {
        const age = nowMs - new Date(r.createdAt).getTime();
        if (age > this.ttlMs) expired.push(r);
        else kept.push(r);
      }
      for (const r of expired) {
        try {
          this.onExpired?.(r);
        } catch { /* @silent-fallback-ok: an expiry-notice consumer failure must never block the sweep itself (WORKING-SET-HANDOFF-SPEC §3.4) */
        }
      }
      return kept;
    });
    return expired;
  }

  /**
   * The records eligible to re-fire for a returning peer — the staggered
   * drain reads this (most-recent-epoch-first; the drain itself enforces
   * rearmConcurrency). Records at/over the attempt cap are excluded (the
   * breaker; a NEW epoch files a NEW record, so an old exhausted breaker
   * never suppresses a fresh, warranted pull).
   */
  async pendingForPeer(nominee: string): Promise<PendingPullRecord[]> {
    const records = await this.read();
    return records
      .filter((r) => r.nominee === nominee && r.attempts < this.attemptCap)
      .sort((a, b) => b.epoch - a.epoch);
  }

  /** All records for a topic (the run-stopped re-arm + reflex route read this). */
  async pendingForTopic(topic: number): Promise<PendingPullRecord[]> {
    const records = await this.read();
    return records.filter((r) => r.topic === topic && r.attempts < this.attemptCap);
  }

  /** Every record, including breaker-exhausted ones (observability). */
  async all(): Promise<PendingPullRecord[]> {
    return [...(await this.read())];
  }

  // ---- the funnel -----------------------------------------------------------

  /**
   * Serialize a read-modify-write. The fn receives the current records array
   * (mutable) and returns the next one; persistence is temp-file + atomic
   * rename. Errors persist nothing and propagate to THIS caller only — the
   * queue itself never wedges.
   */
  private mutate(
    fn: (records: PendingPullRecord[]) => PendingPullRecord[],
  ): Promise<PendingPullRecord[]> {
    const run = this.queue.then(async () => {
      const before = await this.readUnqueued();
      const next = fn(before);
      this.persist(next);
      this.records = next;
      return next;
    });
    // The queue continues even when one mutation throws (error isolated to caller).
    this.queue = run.catch(() => {});
    return run;
  }

  private async read(): Promise<PendingPullRecord[]> {
    // Reads ride the funnel too — a read mid-mutation would see torn state.
    const run = this.queue.then(() => this.readUnqueued());
    this.queue = run.catch(() => {});
    return run;
  }

  /** Load from memory or disk. Corrupt disk → quarantine + notice + fresh. */
  private readUnqueued(): PendingPullRecord[] {
    if (this.records) return this.records;
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf-8');
    } catch { /* @silent-fallback-ok: ledger absent = genuinely empty (first boot) — distinct from corrupt, which quarantines below (WORKING-SET-HANDOFF-SPEC §3.4) */
      this.records = [];
      return this.records;
    }
    try {
      const parsed = JSON.parse(raw) as LedgerFileShape;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.records)) {
        throw new Error('shape mismatch');
      }
      this.records = parsed.records.filter(
        (r) =>
          typeof r?.topic === 'number' &&
          typeof r?.epoch === 'number' &&
          typeof r?.nominee === 'string' &&
          typeof r?.attempts === 'number',
      );
      return this.records;
    } catch {
      // NEVER read corrupt as empty-silently: quarantine + one notice + fresh.
      this.quarantineCorrupt();
      this.records = [];
      return this.records;
    }
  }

  private quarantineCorrupt(): void {
    const quarantined = `${this.file}.corrupt-${this.now().getTime()}`;
    try {
      fs.renameSync(this.file, quarantined);
    } catch { /* @silent-fallback-ok: quarantine rename can lose a race with another process; the notice below still fires once (WORKING-SET-HANDOFF-SPEC §3.4) */
    }
    this.logger(`pending-pull ledger unreadable — quarantined to ${path.basename(quarantined)}`);
    if (!this.corruptNotified) {
      this.corruptNotified = true;
      try {
        this.onCorrupt?.(quarantined);
      } catch { /* @silent-fallback-ok: a corrupt-notice consumer failure must never block ledger recovery (WORKING-SET-HANDOFF-SPEC §3.4) */
      }
    }
  }

  private persist(records: PendingPullRecord[]): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    const body: LedgerFileShape = { version: 1, records };
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
