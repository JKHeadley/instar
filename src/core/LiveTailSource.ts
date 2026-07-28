/**
 * LiveTailSource — the HOLDER-side flush producer (spec §8 G3b). Tracks, per
 * active topic, what conversation content has already been streamed to the
 * standby, and emits the NEW suffix as a monotonic-sequence flush via the
 * live-tail transport. The standby's LiveTailBuffer appends each flush's content
 * contiguously (applies only lastAppliedSeq+1), so the source MUST send deltas,
 * not the full tail — this class owns that delta accounting.
 *
 * Two drivers:
 *   - cadence (liveTailPushRateMs): pushTick() flushes any topic with new content,
 *     keeping the standby's persisted copy fresh to within liveTailMaxStalenessMs.
 *   - handoff: flushTopic()/flushAll() force a flush and return the resulting per-
 *     topic sequence numbers so HandoffSentinel can build the manifest the incoming
 *     machine must echo.
 *
 * EVENT-LOOP DISCIPLINE (the 2026-06-05 Laptop-meltdown fix): building a topic's
 * content is the expensive step — the provider may serialize hundreds of history
 * entries. Doing that for EVERY known topic on EVERY tick blocked the server's
 * event loop for seconds at a stretch, which made our mesh RPC timestamps go
 * stale, which made the standby reject flushes, which caused hot retries — a
 * self-amplifying storm. Three guards now bound the work:
 *
 *   1. VERSION GATE — when the deps provide getTopicVersion (a cheap, monotonic
 *      per-topic message counter), a topic whose version is unchanged since its
 *      last successful flush is skipped WITHOUT building its content. Idle topics
 *      cost one Map lookup per tick instead of a full history serialization.
 *   2. FAILURE BACKOFF — a topic whose flush was rejected/unreachable is not
 *      retried every tick. Consecutive failures back off exponentially (base
 *      doubling, capped), so a rejecting peer (clock-skew 403s, auth break) is
 *      never hammered with full-tail resends at tick rate.
 *   3. CONTENT CAP — a single flush's content is capped (maxFlushBytes); an
 *      oversized delta/full-resend sends only the freshest suffix. The standby's
 *      buffer caps per-topic bytes anyway (LiveTailBuffer.maxBytesPerTopic), so
 *      an unbounded send is pure cost with no retention benefit.
 *
 * The handoff path passes { force: true }, which bypasses the version gate and
 * the backoff window (a handoff is a deliberate one-shot that must try NOW) —
 * but still sends nothing when content is genuinely unchanged.
 *
 * The content provider (getTopicContent) and the transport are injected, so this
 * is unit-testable without a network or a live message store, and so the same
 * producer works for any channel (Telegram, Slack) — the source is channel-
 * agnostic; only the content provider differs.
 */

export interface LiveTailSourceDeps {
  /** The holder's full current tail content for a topic (caller resolves it). */
  getTopicContent: (topic: string) => string;
  /** Topics with live conversation worth streaming to the standby. */
  activeTopics: () => string[];
  /** The wire — redacts + encrypts + posts to the standby (HttpLiveTailTransport). */
  transport: {
    broadcast: (flush: { topic: string; seq: number; content: string }) => Promise<boolean>;
  };
  /**
   * Cheap, monotonic per-topic content version (e.g. a message counter bumped on
   * every logged message). When provided, an unchanged version skips the topic
   * without calling getTopicContent — the event-loop guard that keeps idle
   * topics at O(1) per tick. Omitted → every tick builds every topic's content
   * (the pre-fix behavior; fine for tests and tiny installs).
   */
  getTopicVersion?: (topic: string) => number;
  /**
   * Cap on a single flush's content size, in UTF-16 chars (≈ bytes for our
   * ASCII-heavy logs; heavily non-ASCII content can be up to ~3× larger on the
   * wire — acceptable: the standby buffer enforces its own independent byte
   * cap, this is purely a sender-side cost bound). Default 256 KiB.
   */
  maxFlushBytes?: number;
  /** First-failure retry delay; doubles per consecutive failure. Default 5s. */
  failureBackoffBaseMs?: number;
  /** Backoff ceiling. Default 5 min. */
  failureBackoffMaxMs?: number;
  /**
   * Eternal Sentinel condition 4 ("No Unbounded Loops" / P19): the backoff
   * keeps retrying a failing topic forever (correct — the standby copy should
   * converge whenever the peer recovers), but a topic whose flushes have been
   * failing past staleSignalAfterMs must SAY SO once per episode instead of
   * going quietly stale. Wired to DegradationReporter in server.ts; omitted →
   * silent (tests / channels without a reporter).
   */
  reportStaleStandby?: (info: { topic: string; failingForMs: number; consecutiveFailures: number }) => void;
  /** Sustained-failure threshold for the one-per-episode stale signal. Default 30 min. */
  staleSignalAfterMs?: number;
  now?: () => number;
  logger?: (msg: string) => void;
}

export interface FlushOutcome {
  topic: string;
  /** The per-topic sequence of the flush that was sent (or the current high-water if none). */
  seq: number;
  /** Whether new content was actually flushed (false = nothing new). */
  flushed: boolean;
}

export interface FlushOpts {
  /**
   * Bypass the version gate and the failure-backoff window (handoff path — a
   * deliberate one-shot that must attempt NOW). Unchanged content still sends
   * nothing.
   */
  force?: boolean;
}

const DEFAULT_MAX_FLUSH_BYTES = 256 * 1024;
const DEFAULT_BACKOFF_BASE_MS = 5_000;
const DEFAULT_BACKOFF_MAX_MS = 300_000;
const DEFAULT_STALE_SIGNAL_AFTER_MS = 30 * 60_000;

export class LiveTailSource {
  private readonly d: LiveTailSourceDeps;
  /** Per-topic content already streamed (the prefix the standby has). */
  private streamed = new Map<string, string>();
  /** Per-topic monotonic sequence (matches the standby's applied seq). */
  private seq = new Map<string, number>();
  /** Per-topic provider version at the last successful flush / confirmed no-op. */
  private lastSeenVersion = new Map<string, number>();
  /** Per-topic consecutive broadcast failures (drives the backoff). */
  private failures = new Map<string, number>();
  /** Per-topic earliest next attempt (ms epoch) while backing off. */
  private nextAttemptAt = new Map<string, number>();
  /** Per-topic failure-episode start (ms epoch; absent = healthy). */
  private failingSince = new Map<string, number>();
  /** Episode-keyed one-shot latch for the stale-standby signal (value = failingSince it fired for). */
  private staleSignaledFor = new Map<string, number>();

  constructor(deps: LiveTailSourceDeps) {
    this.d = deps;
  }

  private log(m: string): void {
    this.d.logger?.(`[live-tail-source] ${m}`);
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** Current high-water sequence for a topic (for the handoff manifest). */
  currentSeq(topic: string): number {
    return this.seq.get(topic) ?? 0;
  }

  /**
   * Flush the NEW suffix of a topic's content (the delta since the last flush).
   * If the content shrank or diverged from what we streamed (e.g. a history
   * rewrite), we resend the whole content as a fresh delta. No new content → no
   * flush, no sequence bump (so duplicate ticks don't inflate the standby's seq).
   */
  async flushTopic(topic: string, opts?: FlushOpts): Promise<FlushOutcome> {
    const noFlush: FlushOutcome = { topic, seq: this.currentSeq(topic), flushed: false };
    const now = this.now();

    if (!opts?.force) {
      // Guard 2 — failure backoff: a topic mid-backoff is skipped outright.
      const retryAt = this.nextAttemptAt.get(topic);
      if (retryAt !== undefined && now < retryAt) return noFlush;

      // Guard 1 — version gate: unchanged version + no pending retry → skip
      // WITHOUT building the content. (A pending retry means content changed but
      // the send failed — the version is unchanged since that attempt, yet we
      // still owe the retry.)
      if (this.d.getTopicVersion && (this.failures.get(topic) ?? 0) === 0) {
        const v = this.d.getTopicVersion(topic);
        if (this.lastSeenVersion.get(topic) === v) return noFlush;
      }
    }

    const full = this.d.getTopicContent(topic) ?? '';
    const prior = this.streamed.get(topic) ?? '';
    const version = this.d.getTopicVersion?.(topic);

    const recordNoNewContent = (): FlushOutcome => {
      // Content is confirmed identical — record the version so the gate skips
      // this topic until it actually changes again.
      if (version !== undefined) this.lastSeenVersion.set(topic, version);
      return noFlush;
    };

    let delta: string;
    if (full === prior) {
      return recordNoNewContent();
    }
    if (full.startsWith(prior)) {
      delta = full.slice(prior.length);
    } else {
      // Divergence (history rewrite/compaction) — resend the full content.
      this.log(`topic ${topic} content diverged from streamed prefix — resending full tail`);
      delta = full;
    }
    if (delta.length === 0) {
      return recordNoNewContent();
    }

    // Guard 3 — content cap: keep the freshest suffix. The standby's buffer caps
    // per-topic bytes anyway; an oversized send is cost without retention.
    const maxBytes = this.d.maxFlushBytes ?? DEFAULT_MAX_FLUSH_BYTES;
    if (delta.length > maxBytes) {
      this.log(`topic ${topic} flush capped: ${delta.length} → ${maxBytes} chars (freshest suffix kept)`);
      delta = delta.slice(-maxBytes);
    }

    const nextSeq = this.currentSeq(topic) + 1;
    const ok = await this.d.transport.broadcast({ topic, seq: nextSeq, content: delta });
    if (!ok) {
      // The standby was unreachable — do NOT advance our streamed/seq state, so
      // a later attempt retries the same delta (the buffer dedups on seq anyway).
      // Back off exponentially so a persistently-rejecting peer is not hammered
      // at tick rate (the 403 retry-storm guard).
      const failures = (this.failures.get(topic) ?? 0) + 1;
      this.failures.set(topic, failures);
      const base = this.d.failureBackoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
      const cap = this.d.failureBackoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
      const backoff = Math.min(base * 2 ** (failures - 1), cap);
      this.nextAttemptAt.set(topic, this.now() + backoff);
      this.log(
        `flush of topic ${topic} seq ${nextSeq} not acknowledged — retry in ${Math.round(backoff / 1000)}s (failure #${failures})`,
      );

      // Eternal Sentinel condition 4: retrying forever is correct, but a topic
      // whose standby copy has been stale past the threshold says so ONCE per
      // episode (episode-keyed latch, same defensive shape as the supervisor's
      // SlowRetrySentinelEscalation — a fresh episode re-arms automatically).
      const episodeStart = this.failingSince.get(topic) ?? now;
      if (!this.failingSince.has(topic)) this.failingSince.set(topic, episodeStart);
      const failingForMs = this.now() - episodeStart;
      if (failingForMs >= (this.d.staleSignalAfterMs ?? DEFAULT_STALE_SIGNAL_AFTER_MS)
          && this.staleSignaledFor.get(topic) !== episodeStart) {
        this.staleSignaledFor.set(topic, episodeStart);
        this.log(`topic ${topic} standby copy STALE — flushes failing for ${Math.round(failingForMs / 60_000)}min (signaling once; retries continue)`);
        this.d.reportStaleStandby?.({ topic, failingForMs, consecutiveFailures: failures });
      }
      return { topic, seq: this.currentSeq(topic), flushed: false };
    }
    this.failures.delete(topic);
    this.nextAttemptAt.delete(topic);
    this.failingSince.delete(topic);
    this.staleSignaledFor.delete(topic);
    this.seq.set(topic, nextSeq);
    this.streamed.set(topic, full);
    if (version !== undefined) this.lastSeenVersion.set(topic, version);
    return { topic, seq: nextSeq, flushed: true };
  }

  /** Flush every active topic; returns each topic's outcome (used by the handoff). */
  async flushAll(opts?: FlushOpts): Promise<FlushOutcome[]> {
    const outcomes: FlushOutcome[] = [];
    for (const topic of this.d.activeTopics()) {
      outcomes.push(await this.flushTopic(topic, opts));
    }
    return outcomes;
  }

  /** The cadence driver — flush whatever has new content. Returns count actually flushed. */
  async pushTick(opts?: FlushOpts): Promise<number> {
    const outcomes = await this.flushAll(opts);
    return outcomes.filter((o) => o.flushed).length;
  }
}
