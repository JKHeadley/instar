/**
 * TopicProfileTransferCarrier — the §5.3 transfer-follow carrier
 * (TOPIC-PROFILE-SPEC §5.3, "pull-at-ACQUIRE — a named prerequisite sub-task").
 *
 * A Topic Profile is STICKY OPERATOR INTENT and must follow the topic across a
 * session-pool move. Verified on target: `POST /pool/transfer` carries no
 * payload and has no receive-side hook, and topics also change machines
 * through paths that never run the planner (hard failover, quota-aware
 * placement, lease movement). So the carriage hook lives at the
 * **ownership-ACQUIRE chokepoint**: when THIS machine acquires a topic, it
 * pulls the topic's profile entry from the previous owner over the existing
 * Ed25519 machine-auth channel (the `topic-profile-pull` MeshRpc verb) —
 * covering planner transfers, failovers, and placement moves with ONE
 * mechanism.
 *
 * Spec discipline implemented here:
 *  - **Batch + latency bounds** (§5.3 round-5 scalability): acquires arriving
 *    within the batching window coalesce into ONE pull per previous-owner
 *    peer carrying all topics acquired from it; the durable retry is keyed
 *    per (peer, batch) with backoff — never N independent per-topic retries.
 *    Defaults-with-disclosure notices aggregate into one summary per landing.
 *  - **Fully async**: `onTopicAcquired` is fire-and-forget — the spawn NEVER
 *    waits (the strong form of the §5.3 ~1-2s budget); reconcile-on-pull-
 *    landing handles late arrival.
 *  - **Unreachable previous owner**: the pull is filed DURABLY
 *    (`state/topic-profile-pending-pulls.json`) before the first attempt, so
 *    a crash/restart never loses it; while it is pending, resolution keeps
 *    using the LOCAL entry (`hasPendingPull` is the staleness signal for the
 *    resolution layer's disclosure).
 *  - **Late pull never clobbers a fresher local operator write** (§5.3
 *    rounds 5-8, event-ordered and clock-free): a local operator (or
 *    token-trust HTTP) write DURABLY AMENDS the pending-pull record itself —
 *    removes that topic from the (peer, batch) retry entry — via
 *    `onLocalWriteDurable`, which the write surface calls ONLY after the
 *    triggering mutate's flush has durably landed (`store.mutate` resolves
 *    only then, so "after await mutate" IS the contract; a flush-refused
 *    write throws and cancels nothing). The amendment survives restarts
 *    exactly as well as the pull it cancels. The apply path re-reads the
 *    durable record at landing time, so a write racing an in-flight pull
 *    cancels the REPLACE too. System-attributed writes NEVER cancel.
 *  - **updatedAt backstop** (clock-skew-aware, for pulls landing with no
 *    recorded local write event): local newer wins, ties favor local, and
 *    the pulled entry's updatedAt is clamped to ≤ the pull-receipt time for
 *    the comparison (a future-dated pulled entry is treated as older,
 *    audited). System-attributed local writes never supersede via the
 *    backstop (§5.3 round-6 — the breaker must not shed a transferred pin
 *    through a side door).
 *  - **Newly-pending supersedes older pending** for the same topic (rapid
 *    A→B→C→B re-transfers can't leave two pulls racing).
 *  - **protocol-unsupported ≠ unreachable**: a peer answering `no-handler`
 *    (its instar predates the verb) PARKS the record until
 *    `peerSupportsPull` reports support — no backoff spin against a
 *    permanent 404.
 *  - **Absent on the previous owner clears nothing** — the local entry stays
 *    (a failover-then-transfer-back must not wipe a still-valid pin).
 *  - **Receiving-machine revalidation is MANDATORY**: every landing goes
 *    through `store.replaceEntry(..., { revalidate })` (§10.2 closed-enum +
 *    framework-compat clamp; dropped fields disclosed). Provenance travels
 *    verbatim but the audit tags the landing `origin:'transfer:<machineId>'`
 *    — peer-asserted, never a locally-verified principal.
 *
 * The serve side (`createTopicProfilePullHandler`) is the pool-layer handler
 * the dispatcher registers for the `topic-profile-pull` verb: it serves this
 * machine's OWN entries (current + dry-run shadow — `previous` stays local,
 * undo means "back to what this machine had").
 */

import fs from 'node:fs';
import path from 'node:path';
import type { IntelligenceFramework } from './intelligenceProviderFactory.js';
import type {
  IntendedProfileShadow,
  TopicProfile,
  TopicProfileEntry,
  TopicProfileStore,
} from './TopicProfileStore.js';

// ── wire shapes (the `topic-profile-pull` verb payloads) ────────────────────

export interface TopicProfilePullEntry {
  topicKey: string;
  /** False when the previous owner has NO entry — the receiver clears nothing. */
  present: boolean;
  current: TopicProfile | null;
  /** The §14 dry-run shadow travels verbatim (revalidated on receipt). */
  intendedProfile: IntendedProfileShadow | null;
}

export type TopicProfilePullResponse =
  | { ok: true; entries: TopicProfilePullEntry[] }
  | { ok: false; reason: string };

/** Upper bound on topics served per pull (a mass failover stays one request). */
export const MAX_TOPICS_PER_PULL = 500;

/**
 * The serve-side handler for the `topic-profile-pull` MeshRpc verb — pool
 * layer registers it on the dispatcher. Stateless; reads the authoritative
 * in-memory cache (O(topics)). Absent entries answer `present:false` so the
 * receiver can distinguish "no entry" (clear nothing) from a null profile.
 */
export function createTopicProfilePullHandler(deps: {
  store: Pick<TopicProfileStore, 'get'>;
  maxTopicsPerPull?: number;
}): (cmd: { type: 'topic-profile-pull'; topics: unknown }) => TopicProfilePullResponse {
  const cap = deps.maxTopicsPerPull ?? MAX_TOPICS_PER_PULL;
  return (cmd) => {
    if (!Array.isArray(cmd.topics) || cmd.topics.some((t) => typeof t !== 'string')) {
      return { ok: false, reason: 'malformed-topics' };
    }
    if (cmd.topics.length > cap) {
      return { ok: false, reason: 'too-many-topics' };
    }
    const entries: TopicProfilePullEntry[] = (cmd.topics as string[]).map((topicKey) => {
      const entry: TopicProfileEntry | null = deps.store.get(topicKey);
      if (!entry || (entry.current === null && entry.intendedProfile === null)) {
        return { topicKey, present: false, current: null, intendedProfile: null };
      }
      return {
        topicKey,
        present: true,
        current: entry.current ? { ...entry.current } : null,
        intendedProfile: entry.intendedProfile ? { ...entry.intendedProfile } : null,
      };
    });
    return { ok: true, entries };
  };
}

// ── acquire side ─────────────────────────────────────────────────────────────

/** Outcome of one transport attempt — the wiring maps MeshRpcClient results. */
export type SendPullOutcome =
  | { kind: 'ok'; entries: TopicProfilePullEntry[] }
  /** The peer's instar predates the verb (dispatcher `no-handler`) — PARK. */
  | { kind: 'protocol-unsupported' }
  | { kind: 'unreachable'; detail?: string };

/** Origin of a local profile write, for the §5.3 cancel-marker rules. */
export type LocalWriteOrigin = 'operator' | 'http' | 'system';

interface PendingPullRecord {
  episodeId: string;
  peer: string;
  topics: string[];
  attempts: number;
  /** Epoch ms — due when <= now. 0 = due immediately. */
  nextRetryAt: number;
  /** Parked until the peer's protocolVersion handshake reports support. */
  parkedForProtocol: boolean;
  createdAt: string;
}

interface PendingPullsFileShape {
  version: 1;
  pulls: PendingPullRecord[];
}

export interface TopicProfileTransferCarrierDeps {
  /** Absolute path to the agent's `.instar/` directory (ledger location). */
  stateDir: string;
  selfMachineId: string;
  store: TopicProfileStore;
  /** Default framework — the §10.2 fallback the arriving model validates against. */
  effectiveFramework: () => IntelligenceFramework;
  /** Live ownership read — the ONLY actuation authority at apply time. */
  ownerOf: (topicKey: string) => { owner: string | null };
  /**
   * Previous-owner evidence (journal placement history) for acquires whose
   * hook could not name the previous owner. Null = unknown → nothing to pull.
   */
  prevOwnerOf?: (topicKey: string) => string | null;
  /** ONE batched transport attempt. May throw (treated as unreachable). */
  sendPull: (peerMachineId: string, topics: string[]) => Promise<SendPullOutcome>;
  /**
   * §5.3 rolling-update skew: does the pool's protocolVersion handshake
   * report the peer supports the pull verb? Undefined = unknown → attempt
   * (the `no-handler` answer parks the record anyway).
   */
  peerSupportsPull?: (peerMachineId: string) => boolean | undefined;
  /** Structured audit sink (every transition; never message content). */
  audit?: (event: Record<string, unknown>) => void;
  /**
   * Aggregated user-facing disclosure per landing batch ("N topics moved
   * from <machine>; …" + per-field revalidation fallbacks). One summary per
   * (peer, landing) — never per topic (§5.3 round-5).
   */
  notify?: (text: string) => void;
  now?: () => Date;
  /** Acquire-coalescing window (ms). Default 250. */
  batchWindowMs?: number;
  /** Retry backoff start (ms). Default 30s. */
  retryBackoffStartMs?: number;
  /** Retry backoff cap (ms). Default 30min. */
  retryBackoffMaxMs?: number;
  /** Pending-record TTL (ms) — expired records drop with an audit. Default 7d. */
  pendingTtlMs?: number;
  logger?: (msg: string) => void;
}

const DEFAULT_BATCH_WINDOW_MS = 250;
const DEFAULT_RETRY_BACKOFF_START_MS = 30_000;
const DEFAULT_RETRY_BACKOFF_MAX_MS = 30 * 60_000;
const DEFAULT_PENDING_TTL_MS = 7 * 24 * 60 * 60_000;

export class TopicProfileTransferCarrier {
  private readonly d: TopicProfileTransferCarrierDeps;
  private readonly ledgerFile: string;

  /** Staged acquires per previous-owner peer, awaiting the batch window. */
  private staged = new Map<string, Set<string>>();
  private batchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Single-flight per peer (attempts never overlap per peer). */
  private inFlight = new Map<string, Promise<void>>();
  private episodeSeq = 0;
  /** Durable ledger cache (loaded lazily, kept in sync with every write). */
  private pulls: PendingPullRecord[] | null = null;

  constructor(deps: TopicProfileTransferCarrierDeps) {
    this.d = deps;
    this.ledgerFile = path.join(deps.stateDir, 'state', 'topic-profile-pending-pulls.json');
  }

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  // ── the ACQUIRE hook (fire-and-forget, never blocks a spawn) ──────────────

  /**
   * THIS machine acquired ownership of a topic. Stages a pull from the
   * previous owner; acquires within the batch window coalesce into ONE pull
   * per peer (§5.3 batch bound). Fire-and-forget: returns immediately.
   */
  onTopicAcquired(topicKey: number | string, prevOwnerMachineId?: string | null): void {
    const key = String(topicKey);
    let prev = prevOwnerMachineId;
    if (prev === undefined) {
      try {
        prev = this.d.prevOwnerOf?.(key) ?? null;
      } catch (e) {
        // @silent-fallback-ok: audited (kind:'prev-owner-lookup-failed') —
        // the ACQUIRE hook is fire-and-forget and must never block a spawn
        // (§5.3); with no resolvable previous owner there is nothing to pull
        // from, and the local entry (if any) remains authoritative.
        this.d.audit?.({ kind: 'prev-owner-lookup-failed', topic: key, error: e instanceof Error ? e.message : String(e) });
        prev = null;
      }
    }
    if (!prev || prev === this.d.selfMachineId) return; // nothing to pull / self-move

    let set = this.staged.get(prev);
    if (!set) {
      set = new Set();
      this.staged.set(prev, set);
    }
    set.add(key);

    if (!this.batchTimers.has(prev)) {
      const peer = prev;
      const t = setTimeout(() => {
        this.batchTimers.delete(peer);
        void this.flushStagedPeer(peer).catch((e) => {
          this.d.logger?.(`topic-profile pull flush failed for ${peer}: ${e instanceof Error ? e.message : String(e)}`);
        });
      }, this.d.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS);
      t.unref?.();
      this.batchTimers.set(peer, t);
    }
  }

  /** Force-drain every staged batch now (tests + shutdown). */
  async flushStaged(): Promise<void> {
    const peers = [...this.staged.keys()];
    for (const peer of peers) {
      const t = this.batchTimers.get(peer);
      if (t) {
        clearTimeout(t);
        this.batchTimers.delete(peer);
      }
      await this.flushStagedPeer(peer);
    }
  }

  private async flushStagedPeer(peer: string): Promise<void> {
    const set = this.staged.get(peer);
    this.staged.delete(peer);
    if (!set || set.size === 0) return;
    const topics = [...set];

    // File the durable record FIRST (a crash between filing and the attempt
    // re-fires on the next tick), superseding any older pending pull for
    // these topics (§5.3 — two pulls must never race for one topic).
    const episodeId = `${peer}:${this.now().getTime()}:${++this.episodeSeq}`;
    this.amendLedger((pulls) => {
      for (const rec of pulls) {
        const before = rec.topics.length;
        rec.topics = rec.topics.filter((t) => !set.has(t));
        if (rec.topics.length !== before) {
          this.d.audit?.({
            kind: 'pull-superseded-by-newer-pull',
            oldEpisode: rec.episodeId,
            newEpisode: episodeId,
            removed: before - rec.topics.length,
          });
        }
      }
      const next = pulls.filter((r) => r.topics.length > 0);
      next.push({
        episodeId,
        peer,
        topics,
        attempts: 0,
        nextRetryAt: 0,
        parkedForProtocol: false,
        createdAt: this.now().toISOString(),
      });
      return next;
    });
    this.d.audit?.({ kind: 'pull-filed', episodeId, peer, topicCount: topics.length });

    await this.attemptPeer(peer);
  }

  // ── the §5.3 cancel marker (local write supersedes the pending REPLACE) ───

  /**
   * A LOCAL profile write for `topicKey` has DURABLY landed (the caller
   * invokes this only after `store.mutate(...)` resolved — `mutate` resolves
   * only after its flush is durable, so a flush-refused write throws first
   * and cancels nothing). Operator and token-trust HTTP writes durably amend
   * every pending-pull record to drop the topic — the pending REPLACE is
   * CANCELLED, event-ordered and clock-free. System-attributed writes never
   * cancel (§5.3 round-6 — the breaker can't shed a transferred pin).
   */
  onLocalWriteDurable(topicKey: number | string, origin: LocalWriteOrigin): void {
    if (origin === 'system') return;
    const key = String(topicKey);

    // Staged (not yet filed) acquires for this topic are dropped too.
    for (const [peer, set] of this.staged) {
      if (set.delete(key) && set.size === 0) this.staged.delete(peer);
    }

    const cancelledFrom: string[] = [];
    this.amendLedger((pulls) => {
      for (const rec of pulls) {
        if (rec.topics.includes(key)) {
          rec.topics = rec.topics.filter((t) => t !== key);
          cancelledFrom.push(rec.episodeId);
        }
      }
      return pulls.filter((r) => r.topics.length > 0);
    });
    for (const episodeId of cancelledFrom) {
      this.d.audit?.({ kind: 'pull-superseded-by-local-write', topic: key, origin, episodeId });
    }
  }

  // ── retry drain (tick / peer-online) ──────────────────────────────────────

  /** Is a pull pending for this topic? (Resolution's staleness signal, §5.3.) */
  hasPendingPull(topicKey: number | string): boolean {
    const key = String(topicKey);
    if ([...this.staged.values()].some((s) => s.has(key))) return true;
    return this.loadLedger().some((r) => r.topics.includes(key));
  }

  /** Observability: the durable pending records (copies). */
  pending(): PendingPullRecord[] {
    return this.loadLedger().map((r) => ({ ...r, topics: [...r.topics] }));
  }

  /**
   * Slow tick (the server calls this every ~60s): TTL-sweep, then attempt
   * every due record (backoff respected; parked records re-checked against
   * the protocol handshake).
   */
  async tick(): Promise<void> {
    const nowMs = this.now().getTime();
    const ttl = this.d.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    const expired: PendingPullRecord[] = [];
    this.amendLedger((pulls) =>
      pulls.filter((r) => {
        const created = Date.parse(r.createdAt);
        if (Number.isFinite(created) && nowMs - created > ttl) {
          expired.push(r);
          return false;
        }
        return true;
      }),
    );
    for (const r of expired) {
      this.d.audit?.({ kind: 'pull-expired', episodeId: r.episodeId, peer: r.peer, topicCount: r.topics.length });
    }

    const duePeers = new Set(
      this.loadLedger()
        .filter((r) => (r.parkedForProtocol ? this.d.peerSupportsPull?.(r.peer) === true : r.nextRetryAt <= nowMs))
        .map((r) => r.peer),
    );
    for (const peer of duePeers) await this.attemptPeer(peer);
  }

  /** A peer came back online — drain its pending pulls now (backoff bypassed). */
  async onPeerOnline(machineId: string): Promise<void> {
    const has = this.loadLedger().some((r) => r.peer === machineId);
    if (!has) return;
    this.amendLedger((pulls) => {
      for (const r of pulls) {
        if (r.peer === machineId && !r.parkedForProtocol) r.nextRetryAt = 0;
      }
      return pulls;
    });
    await this.attemptPeer(machineId);
  }

  // ── attempt + apply ────────────────────────────────────────────────────────

  private attemptPeer(peer: string): Promise<void> {
    const existing = this.inFlight.get(peer);
    if (existing) return existing; // single-flight per peer
    const run = this.attemptPeerInner(peer).finally(() => {
      this.inFlight.delete(peer);
    });
    this.inFlight.set(peer, run);
    return run;
  }

  private async attemptPeerInner(peer: string): Promise<void> {
    const nowMs = this.now().getTime();
    const records = this.loadLedger().filter((r) => r.peer === peer);
    for (const rec of records) {
      if (rec.parkedForProtocol) {
        if (this.d.peerSupportsPull?.(peer) !== true) continue; // still parked
        this.amendLedger((pulls) => {
          const live = pulls.find((p) => p.episodeId === rec.episodeId);
          if (live) live.parkedForProtocol = false;
          return pulls;
        });
      } else if (rec.nextRetryAt > nowMs) {
        continue; // not due
      }

      // Pre-attempt handshake check: a known-unsupported peer parks without
      // burning a transport round-trip (§5.3 rolling-update skew).
      if (this.d.peerSupportsPull?.(peer) === false) {
        this.park(rec.episodeId, peer);
        continue;
      }

      let outcome: SendPullOutcome;
      try {
        // Re-read the live record — a local write may have amended it while
        // we were iterating.
        const live = this.loadLedger().find((p) => p.episodeId === rec.episodeId);
        if (!live || live.topics.length === 0) continue;
        outcome = await this.d.sendPull(peer, [...live.topics]);
      } catch (e) {
        outcome = { kind: 'unreachable', detail: e instanceof Error ? e.message : String(e) };
      }

      if (outcome.kind === 'protocol-unsupported') {
        this.park(rec.episodeId, peer);
        continue;
      }
      if (outcome.kind === 'unreachable') {
        const startMs = this.d.retryBackoffStartMs ?? DEFAULT_RETRY_BACKOFF_START_MS;
        const maxMs = this.d.retryBackoffMaxMs ?? DEFAULT_RETRY_BACKOFF_MAX_MS;
        let attempts = 0;
        this.amendLedger((pulls) => {
          const live = pulls.find((p) => p.episodeId === rec.episodeId);
          if (live) {
            live.attempts += 1;
            attempts = live.attempts;
            live.nextRetryAt = this.now().getTime() + Math.min(maxMs, startMs * 2 ** (live.attempts - 1));
          }
          return pulls;
        });
        this.d.audit?.({ kind: 'pull-unreachable', episodeId: rec.episodeId, peer, attempts, detail: outcome.detail });
        continue;
      }

      await this.applyLanding(rec.episodeId, peer, outcome.entries);
    }
  }

  private park(episodeId: string, peer: string): void {
    this.amendLedger((pulls) => {
      const live = pulls.find((p) => p.episodeId === episodeId);
      if (live) live.parkedForProtocol = true;
      return pulls;
    });
    this.d.audit?.({ kind: 'pull-parked-protocol-unsupported', episodeId, peer });
  }

  /**
   * A pull landed. Per topic: the durable record is re-read (a local write
   * that amended it mid-flight cancels that topic's REPLACE), ownership is
   * re-checked (actuation authority), the updatedAt backstop runs, then the
   * §10.2-revalidated wholesale REPLACE applies. Disclosures aggregate into
   * ONE summary per landing.
   */
  private async applyLanding(episodeId: string, peer: string, entries: TopicProfilePullEntry[]): Promise<void> {
    const live = this.loadLedger().find((p) => p.episodeId === episodeId);
    const liveTopics = new Set(live?.topics ?? []);
    const receiptIso = this.now().toISOString();

    let applied = 0;
    const disclosures: string[] = [];

    for (const entry of entries) {
      const key = entry.topicKey;
      if (!liveTopics.has(key)) {
        // Cancelled by a local write (the durable amendment) or superseded by
        // a newer pull while this one was in flight — the REPLACE is dropped.
        this.d.audit?.({ kind: 'pull-landing-cancelled', topic: key, episodeId, peer });
        continue;
      }

      // Ownership recheck — we may no longer own the topic (re-transferred
      // while the pull was pending); the current owner's own pull covers truth.
      let owner: string | null = null;
      try {
        owner = this.d.ownerOf(key).owner;
      } catch {
        // @silent-fallback-ok: the ownership RE-check is a best-effort guard
        // against landing onto a re-transferred topic; a reader error means
        // owner-UNKNOWN, which must not be treated as not-owner (that would
        // drop a valid pull) — every landing outcome below is audited.
        owner = null;
      }
      if (owner !== null && owner !== this.d.selfMachineId) {
        this.d.audit?.({ kind: 'pull-skipped-not-owner', topic: key, episodeId, owner });
        liveTopics.delete(key); // resolved — deliberately skipped, never retried
        continue;
      }

      if (!entry.present) {
        // Absent on the previous owner clears NOTHING — the local entry stays
        // (a failover-then-transfer-back must not wipe a still-valid pin).
        this.d.audit?.({ kind: 'pull-absent-on-previous-owner', topic: key, episodeId, peer });
        liveTopics.delete(key); // resolved
        continue;
      }

      // updatedAt backstop (clock-free cancel is primary; this catches pulls
      // landing with no recorded local write event): local newer wins, ties
      // favor local — and a pulled updatedAt clamped above the pull-receipt
      // time (future-dated: forged or skew-ahead) is treated as OLDER than
      // any local entry, audited (§5.3 round-6 — a peer-asserted timestamp
      // must never outrank a genuinely fresher local pin). System-attributed
      // local writes never supersede via the backstop.
      const localCurrent = this.d.store.resolve(key);
      const arrivingUpdatedAt = typeof entry.current?.updatedAt === 'string' ? entry.current.updatedAt : null;
      if (localCurrent && arrivingUpdatedAt && !localCurrent.updatedBy.startsWith('system:')) {
        const futureDated = arrivingUpdatedAt > receiptIso;
        if (futureDated) {
          this.d.audit?.({ kind: 'pull-updatedat-clamped', topic: key, episodeId, peer });
        }
        if (futureDated || localCurrent.updatedAt >= arrivingUpdatedAt) {
          this.d.audit?.({
            kind: 'pull-superseded-by-local-write',
            topic: key,
            origin: 'updatedAt-backstop',
            episodeId,
          });
          liveTopics.delete(key); // resolved — local wins
          continue;
        }
      }

      // §10.2 MANDATORY receiving-machine revalidation, then wholesale REPLACE.
      try {
        const result = await this.d.store.replaceEntry(
          key,
          { current: entry.current, intendedProfile: entry.intendedProfile },
          { revalidate: { fallbackFramework: this.d.effectiveFramework() } },
        );
        applied += 1;
        this.d.audit?.({
          kind: 'pull-applied',
          topic: key,
          episodeId,
          origin: `transfer:${peer}`,
          delta: result.delta,
          droppedFieldCount: result.droppedFields.length,
        });
        for (const dropped of result.droppedFields) {
          disclosures.push(
            `topic ${key}: the transferred ${dropped.field} didn't validate on this machine (${dropped.reason}) — using the default`,
          );
        }
      } catch (e) {
        // FlushRefusedError etc. — the topic STAYS in the record (it remains
        // in liveTopics); the next tick retries the pull (REPLACE is
        // idempotent). Back the episode off so a wedged disk doesn't spin.
        this.d.logger?.(`topic-profile REPLACE failed for ${key}: ${e instanceof Error ? e.message : String(e)}`);
        this.amendLedger((pulls) => {
          const liveRec = pulls.find((p) => p.episodeId === episodeId);
          if (liveRec) {
            const startMs = this.d.retryBackoffStartMs ?? DEFAULT_RETRY_BACKOFF_START_MS;
            liveRec.nextRetryAt = this.now().getTime() + startMs;
          }
          return pulls;
        });
        continue;
      }

      liveTopics.delete(key); // resolved — applied
    }

    // Resolve the episode: topics remaining in liveTopics are ONLY the
    // flush-failed ones (everything applied/skipped was deleted above) —
    // they stay in the record for retry; the rest leave it.
    this.amendLedger((pulls) => {
      const liveRec = pulls.find((p) => p.episodeId === episodeId);
      if (liveRec) liveRec.topics = liveRec.topics.filter((t) => liveTopics.has(t));
      return pulls.filter((r) => r.topics.length > 0);
    });

    if (applied > 0 || disclosures.length > 0) {
      const lines = [`${applied} topic profile${applied === 1 ? '' : 's'} arrived from ${peer}.`, ...disclosures];
      this.d.notify?.(lines.join('\n'));
    }
  }

  // ── durable ledger (atomic tmp+rename, restart-proof) ─────────────────────

  private loadLedger(): PendingPullRecord[] {
    if (this.pulls) return this.pulls;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.ledgerFile, 'utf-8')) as Partial<PendingPullsFileShape>;
      this.pulls = Array.isArray(parsed?.pulls)
        ? parsed.pulls.filter(
            (r): r is PendingPullRecord =>
              !!r &&
              typeof r === 'object' &&
              typeof r.episodeId === 'string' &&
              typeof r.peer === 'string' &&
              Array.isArray(r.topics) &&
              r.topics.every((t) => typeof t === 'string'),
          )
        : [];
    } catch {
      /* @silent-fallback-ok: an absent/corrupt pending-pull ledger only loses queued retries for moves that already disclosed "pins reconcile when reachable" — the reflex (next acquire or onPeerOnline) re-files; never a boot failure (TOPIC-PROFILE-SPEC §5.3) */
      this.pulls = [];
    }
    return this.pulls;
  }

  /** Apply a mutation to the ledger and persist it durably (tmp+rename). */
  private amendLedger(fn: (pulls: PendingPullRecord[]) => PendingPullRecord[]): void {
    const next = fn(this.loadLedger());
    this.pulls = next;
    try {
      fs.mkdirSync(path.dirname(this.ledgerFile), { recursive: true });
      const tmp = `${this.ledgerFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, pulls: next } satisfies PendingPullsFileShape, null, 2));
      fs.renameSync(tmp, this.ledgerFile);
    } catch (e) {
      /* @silent-fallback-ok: a failed ledger persist keeps the in-memory amendment authoritative for this process; the durable copy self-heals at the next successful amend — logged, never thrown into the acquire/write path (TOPIC-PROFILE-SPEC §5.3) */
      this.d.logger?.(`pending-pull ledger persist failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
