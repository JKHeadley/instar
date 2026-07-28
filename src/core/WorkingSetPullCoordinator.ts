/**
 * WorkingSetPullCoordinator — P2.2b of multi-machine coherence: the
 * orchestration layer that makes the working-set transfer FIRE — on a topic
 * move (the receiver's deliverMessage onAccepted seam), on demand (the
 * reflex route), and on a returning producer (the staggered pending-pull
 * drain).
 *
 * Spec: docs/specs/WORKING-SET-HANDOFF-SPEC.md §3.3 (trigger — receiver-side,
 * epoch-gated, single-flight), §3.4 (durable pending-pull + staggered drain).
 *
 * Discipline (all inherited-invariant applications):
 *  - Operation key (topic, epoch): at most one pull scheduled per key,
 *    deduped against a DURABLE recent-key window (restart-proof).
 *  - Skips: owner !== self (we are not the owner), owner === prevOwner
 *    (placing-confirm, no real move), prevOwner === self (nothing to fetch
 *    from ourselves).
 *  - Single-flight per topic; ownership is rechecked inside the puller
 *    before EVERY write (the stillCurrent seam).
 *  - Nomination is PLURAL + bounded: every machine the journal (own +
 *    replicas) shows as an artifact-producer for the topic, deduped, capped
 *    at 3, most-recent-first — NOT "the prior owner". Replicas NOMINATE
 *    only; each nominee's LIVE manifest is the authority.
 *  - Staggered drain (§3.4): at most `rearmConcurrency` (default 1)
 *    topic-pull in flight per returning peer — the EXO shape is ONE machine
 *    holding MANY topics' files; N simultaneous pulls would slam a box that
 *    just woke.
 *  - Load-aware: scheduling defers under host pressure; the pull is always
 *    async, NEVER in the message-delivery path.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { CoherenceJournalReader } from './CoherenceJournalReader.js';
import type { PendingPullLedger, PendingPullReason } from './PendingPullLedger.js';
import type { PullReport, WorkingSetPuller } from './WorkingSetPull.js';

export const DEFAULT_REARM_CONCURRENCY = 1;
export const DEFAULT_NOMINEE_CAP = 3;
/** Durable (topic,epoch) op-key window size — mirrors the journal's DEDUPE_WINDOW. */
export const OPKEY_WINDOW = 200;
/** Reflex route min interval per topic (rate limit; concurrent calls coalesce). */
export const DEFAULT_REFLEX_MIN_INTERVAL_MS = 30_000;

export interface CoordinatorDeps {
  /** Absolute path to the agent's `.instar/` directory. */
  stateDir: string;
  ownMachineId: string;
  /** Merged own+replica journal reads — NOMINATION ONLY (Signal vs Authority). */
  reader: CoherenceJournalReader;
  ledger: PendingPullLedger;
  /**
   * Build a puller for one nominee peer (resolves its URL + signed client),
   * or null when the peer is unknown/unreachable right now. topic+epoch are
   * provided so the wiring can close the puller's stillCurrent recheck over
   * the SCHEDULED epoch (§3.3 — ownership advanced → abort quietly).
   */
  makePuller: (nomineeMachineId: string, topic: number, epoch: number) => WorkingSetPuller | null;
  /** Live ownership read — the ONLY actuation authority (§3.3). */
  ownerOf: (topic: number) => { owner: string | null; epoch: number | null };
  /** Host-pressure signal (§3.3 load-aware defer). Default: never. */
  underPressure?: () => boolean;
  rearmConcurrency?: number;
  nomineeCap?: number;
  reflexMinIntervalMs?: number;
  now?: () => Date;
  logger?: (msg: string) => void;
}

export interface FetchOutcome {
  topic: number;
  scheduled: boolean;
  /** Why nothing was scheduled (dedupe/skip/pressure) — honest, counted. */
  skipReason?:
    | 'not-owner'
    | 'opkey-deduped'
    | 'no-producers'
    | 'in-flight-coalesced'
    | 'rate-limited'
    | 'pressure-deferred'
    | 'no-epoch';
  /** Per-nominee pull reports (when the pull ran). */
  reports?: { nominee: string; report: PullReport | null; error?: string }[];
  /** Journal-nominated producers that the cap excluded — named, not silent (§3.3). */
  cappedNominees?: string[];
}

interface OpKeyFileShape {
  version: 1;
  keys: string[];
}

export class WorkingSetPullCoordinator {
  private readonly d: CoordinatorDeps;
  private readonly opKeyFile: string;
  private opKeys: string[] | null = null;
  /** Single-flight per topic — concurrent triggers coalesce onto one promise. */
  private inFlight = new Map<number, Promise<FetchOutcome>>();
  /** Per-peer drain gate (staggered re-arm, §3.4). */
  private draining = new Set<string>();
  /** Reflex rate limit per topic. */
  private lastReflexAt = new Map<number, number>();

  constructor(deps: CoordinatorDeps) {
    this.d = deps;
    this.opKeyFile = path.join(deps.stateDir, 'state', 'coherence-journal', 'pull-opkeys.json');
  }

  // ── The move trigger (§3.3) — called from the onAccepted seam ────────────

  /**
   * A forwarded message landed and THIS machine is (about to be) the owner.
   * Fire-and-forget: never blocks message delivery. The epoch is read from
   * the live ownership store; prevOwner evidence comes from the journal's
   * placement history.
   */
  onTopicAccepted(topic: number): void {
    void this.trigger(topic, 'move').catch((e) => {
      this.d.logger?.(`trigger failed for topic ${topic}: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  /** The reflex (§3.3): POST /coherence/fetch-working-set — same pipeline, on demand. */
  async fetchWorkingSet(topic: number): Promise<FetchOutcome> {
    // A transfer-target kick can arrive before the target's ownership replica.
    // Do not consume the reflex window for that expected not-owner race; the
    // trigger below still rechecks ownership at the actual authority boundary.
    if (this.d.ownerOf(topic).owner !== this.d.ownMachineId) {
      return { topic, scheduled: false, skipReason: 'not-owner' };
    }
    const nowMs = (this.d.now?.() ?? new Date()).getTime();
    const last = this.lastReflexAt.get(topic) ?? 0;
    const inflight = this.inFlight.get(topic);
    if (inflight) return inflight; // coalesce into the single-flight pull
    if (nowMs - last < (this.d.reflexMinIntervalMs ?? DEFAULT_REFLEX_MIN_INTERVAL_MS)) {
      return { topic, scheduled: false, skipReason: 'rate-limited' };
    }
    this.lastReflexAt.set(topic, nowMs);
    // The reflex bypasses the (topic,epoch) op-key dedupe (an explicit ask
    // re-fetches even when the move already pulled) but keeps every other
    // gate — ownership, single-flight, nomination bounds.
    return this.trigger(topic, 'reflex');
  }

  // ── The returning-peer drain (§3.4) ───────────────────────────────────────

  /**
   * Called when the presence pull records a peer online (every pass — the
   * drain itself dedupes). Re-fires outstanding pending-pulls for that peer
   * as a STAGGERED drain: at most rearmConcurrency in flight, the rest
   * queued behind it most-recent-epoch-first.
   */
  onPeerRecorded(machineId: string): void {
    if (this.draining.has(machineId)) return; // a drain is already running
    void this.drainPeer(machineId).catch((e) => {
      this.d.logger?.(`drain failed for ${machineId}: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  private async drainPeer(machineId: string): Promise<void> {
    const pending = await this.d.ledger.pendingForPeer(machineId);
    if (!pending.length) return;
    this.draining.add(machineId);
    try {
      // Sequential (rearmConcurrency 1) most-recent-epoch-first — pendingForPeer
      // pre-sorts. A >1 setting would batch; the default stays single-file.
      for (const rec of pending) {
        // Live-source records re-arm only when the producer's run has stopped —
        // checked against the nominee's LIVE manifest by the pull itself (a
        // still-live run answers liveSource and the record stays).
        const { owner, epoch } = this.d.ownerOf(rec.topic);
        if (owner !== this.d.ownMachineId) {
          // We no longer own the topic — the current owner's own pull covers
          // truth; clear our stale record.
          await this.d.ledger.clear(rec.topic, rec.epoch, rec.nominee);
          continue;
        }
        if (epoch != null && epoch > rec.epoch) {
          await this.d.ledger.supersede(rec.topic, epoch);
          continue;
        }
        await this.pullFromNominee(rec.topic, rec.epoch ?? 0, rec.nominee);
      }
    } finally {
      this.draining.delete(machineId);
    }
  }

  // ── The shared pipeline ────────────────────────────────────────────────────

  private async trigger(topic: number, source: 'move' | 'reflex'): Promise<FetchOutcome> {
    const existing = this.inFlight.get(topic);
    if (existing) return existing; // single-flight per topic (§3.3)

    const { owner, epoch } = this.d.ownerOf(topic);
    if (owner !== this.d.ownMachineId) return { topic, scheduled: false, skipReason: 'not-owner' };
    if (epoch == null) return { topic, scheduled: false, skipReason: 'no-epoch' };

    if (source === 'move') {
      // Durable (topic,epoch) op-key dedupe — restart-proof (§3.3).
      const key = `${topic}:${epoch}`;
      if (this.hasOpKey(key)) return { topic, scheduled: false, skipReason: 'opkey-deduped' };
      // Skip placing-confirms + self-moves via journal placement evidence.
      const prevOwner = this.prevOwnerOf(topic, epoch);
      if (prevOwner === this.d.ownMachineId) {
        this.recordOpKey(key);
        return { topic, scheduled: false, skipReason: 'no-producers' };
      }
      if (this.d.underPressure?.()) {
        // Deferred, not dropped: file a pending-pull per nominee below would
        // need nomination; the cheap honest defer is to leave the op-key
        // unrecorded so the next accept (or the reflex) re-triggers.
        return { topic, scheduled: false, skipReason: 'pressure-deferred' };
      }
      this.recordOpKey(key);
    }

    const run = this.runPull(topic, epoch);
    this.inFlight.set(topic, run);
    try {
      return await run;
    } finally {
      this.inFlight.delete(topic);
    }
  }

  private async runPull(topic: number, epoch: number): Promise<FetchOutcome> {
    const { nominees, capped } = this.nominate(topic);
    if (!nominees.length) {
      return { topic, scheduled: false, skipReason: 'no-producers', ...(capped.length ? { cappedNominees: capped } : {}) };
    }
    const reports: { nominee: string; report: PullReport | null; error?: string }[] = [];
    for (const nominee of nominees) {
      const r = await this.pullFromNominee(topic, epoch, nominee);
      reports.push(r);
    }
    return { topic, scheduled: true, reports, ...(capped.length ? { cappedNominees: capped } : {}) };
  }

  private async pullFromNominee(
    topic: number,
    epoch: number,
    nominee: string,
  ): Promise<{ nominee: string; report: PullReport | null; error?: string }> {
    const puller = this.d.makePuller(nominee, topic, epoch);
    if (!puller) {
      await this.d.ledger.file_({ topic, epoch, nominee, reason: 'peer-unreachable' });
      await this.d.ledger.recordAttempt(topic, epoch, nominee);
      return { nominee, report: null, error: 'peer unreachable' };
    }
    try {
      const report = await puller.pullTopic(topic);
      if (report.needsPendingPull) {
        // liveSource / busyExhausted / transport — durable record, re-fired
        // on reappearance or run-stopped. busy does NOT consume an attempt.
        const reason: PendingPullReason = report.files.some((f) => f.outcome === 'liveSourceDeferred')
          ? 'live-source'
          : report.files.some((f) => f.outcome === 'busyExhausted')
            ? 'busy-exhausted'
            : 'peer-unreachable';
        await this.d.ledger.file_({ topic, epoch, nominee, reason });
        if (reason === 'peer-unreachable') {
          await this.d.ledger.recordAttempt(topic, epoch, nominee); // genuine failure only
        }
      } else {
        await this.d.ledger.clear(topic, epoch, nominee);
      }
      return { nominee, report };
    } catch (e) {
      await this.d.ledger.file_({ topic, epoch, nominee, reason: 'peer-unreachable' });
      await this.d.ledger.recordAttempt(topic, epoch, nominee);
      return { nominee, report: null, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── Nomination (§3.3 — plural, bounded, journal-evidenced) ────────────────

  /**
   * Every machine the journal (own + replicas) shows as an autonomous-run
   * producer for the topic, excluding self, deduped, most-recent-first,
   * capped. Replicas NOMINATE only — the nominee's live manifest is the
   * authority when the pull runs.
   */
  nominate(topic: number): { nominees: string[]; capped: string[] } {
    const cap = this.d.nomineeCap ?? DEFAULT_NOMINEE_CAP;
    let entries;
    try {
      entries = this.d.reader.query({ kind: 'autonomous-run', topic, limit: 100 }).entries;
    } catch (e) {
      this.d.logger?.(`nomination read failed for topic ${topic}: ${e instanceof Error ? e.message : String(e)}`);
      return { nominees: [], capped: [] };
    }
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const e of entries) {
      // newest-first already (reader merge order)
      if (e.machine === this.d.ownMachineId || seen.has(e.machine)) continue;
      seen.add(e.machine);
      ordered.push(e.machine);
    }
    return { nominees: ordered.slice(0, cap), capped: ordered.slice(cap) };
  }

  /** Previous owner from the journal's placement history (evidence, not authority). */
  private prevOwnerOf(topic: number, epoch: number): string | null {
    try {
      const entries = this.d.reader.query({ kind: 'topic-placement', topic, limit: 20 }).entries;
      for (const e of entries) {
        const data = e.data as { epoch?: number; prevOwner?: string };
        if (data.epoch === epoch && typeof data.prevOwner === 'string') return data.prevOwner;
      }
    } catch { /* @silent-fallback-ok: missing placement evidence means no prevOwner skip — the pull proceeds and the manifest decides (WORKING-SET-HANDOFF-SPEC §3.3) */
    }
    return null;
  }

  // ── Durable (topic,epoch) op-key window (§3.3 — restart-proof) ────────────

  private loadOpKeys(): string[] {
    if (this.opKeys) return this.opKeys;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.opKeyFile, 'utf-8')) as OpKeyFileShape;
      this.opKeys = Array.isArray(parsed?.keys) ? parsed.keys.filter((k) => typeof k === 'string') : [];
    } catch { /* @silent-fallback-ok: an absent/corrupt op-key window only weakens dedupe for one pull (re-pull is idempotent via skippedExisting) — never a failure (WORKING-SET-HANDOFF-SPEC §3.3) */
      this.opKeys = [];
    }
    return this.opKeys;
  }

  private hasOpKey(key: string): boolean {
    return this.loadOpKeys().includes(key);
  }

  private recordOpKey(key: string): void {
    const keys = this.loadOpKeys();
    keys.push(key);
    while (keys.length > OPKEY_WINDOW) keys.shift();
    try {
      fs.mkdirSync(path.dirname(this.opKeyFile), { recursive: true });
      const tmp = `${this.opKeyFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, keys } satisfies OpKeyFileShape));
      fs.renameSync(tmp, this.opKeyFile);
    } catch (e) { /* @silent-fallback-ok: a failed op-key persist only weakens dedupe across a restart (re-pull is idempotent); logged, never thrown (WORKING-SET-HANDOFF-SPEC §3.3) */
      this.d.logger?.(`op-key persist failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── The slow tick (the server calls this every ~10 min) ───────────────────

  /**
   * TTL sweep + the run-stopped re-arm (§3.4): live-source records re-fire on
   * a cadence — the pull itself is the live-ness check (a still-live run
   * answers `liveSource` again and the record simply stays, attempt-free).
   * Bounded: only existing live-source records for topics we still own.
   */
  async sweep(): Promise<void> {
    await this.d.ledger.sweepExpired();
    const all = await this.d.ledger.all();
    for (const rec of all) {
      if (rec.reason !== 'live-source') continue;
      const { owner, epoch } = this.d.ownerOf(rec.topic);
      if (owner !== this.d.ownMachineId) {
        await this.d.ledger.clear(rec.topic, rec.epoch, rec.nominee);
        continue;
      }
      if (epoch != null && epoch > rec.epoch) {
        await this.d.ledger.supersede(rec.topic, epoch);
        continue;
      }
      await this.pullFromNominee(rec.topic, rec.epoch, rec.nominee);
    }
  }
}
