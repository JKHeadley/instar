/**
 * SenderRejectionNoticer (silent-loss-refusal-conservation §2.C — the
 * deterministic, UNIFIED loss notice on the refusing path).
 *
 * When the router yields a first-class `rejected` outcome for a USER-originated
 * message (the owner re-validated the sender and refused), the ingress machine
 * must TELL the user — the parent principle "A Refusal Stays a Refusal" demands
 * every rejection be conserved through a notice, never left to a log line the
 * operator might miss. This helper is the single funnel BOTH the live consumer
 * (Telegram / Slack) and the queue-drain loss path route through, keyed on ONE
 * canonical cause (`sender-deauthorized`), so the two paths can never emit two
 * differently-worded notices.
 *
 * Properties (all injected → unit-testable, deterministic on a fake clock):
 *   - Neutral FIXED wording, no topology leak, no resend invitation (§2.C).
 *   - Durable per-messageId dedupe (the ledger `markRejected` marker seam) so a
 *     replay produces ONE notice; a secondary in-memory 30-min (topic,cause) window.
 *   - Cross-topic ceiling: >3 distinct topics for one (peer,cause) in a window →
 *     suppress per-topic notices, emit ONE aggregated hub alert (deduped).
 *   - Flapping-proof decay: per-(peer,cause) re-notice cadence decays 30m→2h→6h on
 *     time-since-first-observed, and only resets after a SUSTAINED clear window.
 *   - Sender-side divergence signal: local-resolves + remote-rejects → ONE deduped
 *     advisory coherence alert (feeds G1; never auto-remediation).
 *
 * Fire-and-forget: the send seams swallow their own errors; a notice failure
 * never throws into the router/drain.
 */

/** The canonical cause the live path and the drain path unify on. */
export const SENDER_DEAUTHORIZED_CAUSE = 'sender-deauthorized' as const;

/** The neutral fixed template (§2.C) — no architecture, no "registry out of sync",
 *  no resend invitation, no multi-machine topology. */
export const SENDER_DEAUTHORIZED_NOTICE =
  "I got your message but couldn't confirm you as an approved sender, so it wasn't delivered. " +
  "I've logged the details so this can be diagnosed.";

export const CROSS_TOPIC_CEILING = 3;
export const NOTICE_WINDOW_MS = 30 * 60 * 1000; // 30-min secondary window
/** Flapping-proof re-notice decay steps (time-since-first-observed). */
export const DECAY_STEPS_MS = [30 * 60 * 1000, 2 * 60 * 60 * 1000, 6 * 60 * 60 * 1000] as const;
/** Sustained-clear window before the decay step resets (≥ the longest step). */
export const SUSTAINED_CLEAR_MS = DECAY_STEPS_MS[DECAY_STEPS_MS.length - 1];

export interface SenderRejectionEvent {
  /** 'telegram' → topicId is a numeric topic; 'slack' → slackKey routes in-thread. */
  adapter: 'telegram' | 'slack';
  topicId?: number;
  slackKey?: string;
  /** The rejected message's id — the durable dedupe key. */
  messageId: string;
  /** The rejected sender's platform uid (for the divergence probe). */
  senderUid?: number;
  /** Peer that decided the rejection (for the (peer,cause) ceiling/decay). */
  peer?: string;
}

export interface SenderRejectionNoticerDeps {
  /** Send the neutral notice to a Telegram topic (fire-and-forget). */
  sendTelegram: (topicId: number, text: string) => void;
  /** Send the neutral notice in a Slack thread (fire-and-forget). Optional. */
  sendSlack?: (slackKey: string, text: string) => void;
  /** Raise ONE aggregated alert to the operator hub (ceiling breach + divergence). */
  alertHub: (title: string, body: string) => void;
  /**
   * Durable per-messageId dedupe marker (the ledger `markRejected` seam). Returns
   * true iff THIS call first-marked the message rejected (so fire the notice);
   * false → already marked (a replay) → skip. When absent, dedupe falls back to
   * the in-memory window only.
   */
  markRejectedDurable?: (messageId: string) => boolean;
  /** Ingress-side registry probe for the divergence signal: does the rejected uid
   *  resolve on OUR (cached) registry? local-resolves + remote-rejects = divergence. */
  resolvesLocally?: (uid: number) => boolean;
  now?: () => number;
}

interface CauseState {
  /** First time this (peer,cause) was observed (drives the decay step). */
  firstObservedAt: number;
  /** Last time we emitted a per-topic notice for this (peer,cause). */
  lastNoticeAt: number;
  /** Distinct topics seen within the rolling window. */
  topics: Map<number | string, number>; // topicKey → lastSeenAt
  /** Whether the aggregated ceiling alert has already fired this episode. */
  ceilingAlerted: boolean;
  /** Last time ANY rejection was observed (drives sustained-clear reset). */
  lastObservedAt: number;
}

export class SenderRejectionNoticer {
  private readonly d: SenderRejectionNoticerDeps;
  private readonly now: () => number;
  /** Per-(peer,cause) episode state (machine-local, in-memory; re-arms on lease flip). */
  private readonly causeState = new Map<string, CauseState>();
  /** In-memory secondary dedupe: (topic|cause) → lastNoticeAt (30-min window). */
  private readonly topicWindow = new Map<string, number>();
  /** Divergence-alert dedupe: peer → lastAlertAt. */
  private readonly divergenceAlerted = new Map<string, number>();

  constructor(deps: SenderRejectionNoticerDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Handle a first-class `rejected` outcome. Idempotent per messageId (durable);
   * enforces the cross-topic ceiling + flapping decay; raises the divergence
   * signal. Never throws.
   */
  onRejected(evt: SenderRejectionEvent): void {
    try {
      this.onRejectedInner(evt);
    } catch {
      /* fire-and-forget: a notice fault must never propagate into routing */
    }
  }

  private onRejectedInner(evt: SenderRejectionEvent): void {
    const nowMs = this.now();
    const cause = SENDER_DEAUTHORIZED_CAUSE;
    const peer = evt.peer ?? 'unknown';
    const topicKey = evt.adapter === 'telegram' ? (evt.topicId ?? 'tg?') : (evt.slackKey ?? 'slack?');

    // Durable per-messageId dedupe (the ledger marker). A replay of the SAME
    // rejected message must produce ZERO additional notices.
    if (this.d.markRejectedDurable && !this.d.markRejectedDurable(evt.messageId)) {
      return; // already noticed for this message (durable) → nothing more to do.
    }

    // Divergence signal (advisory, feeds G1) — probe our OWN registry.
    if (evt.senderUid != null && this.d.resolvesLocally) {
      try {
        if (this.d.resolvesLocally(evt.senderUid)) {
          const last = this.divergenceAlerted.get(peer) ?? -Infinity;
          if (nowMs - last >= NOTICE_WINDOW_MS) {
            this.divergenceAlerted.set(peer, nowMs);
            this.d.alertHub(
              'Sender-registry divergence',
              `A sender resolves on THIS machine but was rejected by "${peer}" — the peer's user registry may be degenerate or a deauthorization is still replicating. Advisory only (feeds the coherence audit); no auto-remediation.`,
            );
          }
        }
      } catch { /* @silent-fallback-ok: divergence probe is best-effort — an advisory coherence signal only, never gates the notice */ }
    }

    // (peer,cause) episode bookkeeping (cross-topic ceiling + flapping decay).
    const causeKey = `${peer}|${cause}`;
    let st = this.causeState.get(causeKey);
    if (st) {
      // Sustained-clear reset: if the cause has been silent ≥ the longest decay
      // step, this is a fresh episode — re-arm the fast cadence.
      if (nowMs - st.lastObservedAt >= SUSTAINED_CLEAR_MS) {
        st = undefined;
        this.causeState.delete(causeKey);
      }
    }
    if (!st) {
      st = { firstObservedAt: nowMs, lastNoticeAt: -Infinity, topics: new Map(), ceilingAlerted: false, lastObservedAt: nowMs };
      this.causeState.set(causeKey, st);
    }
    st.lastObservedAt = nowMs;

    // Prune + record the distinct topic within the rolling window.
    for (const [k, seen] of st.topics) {
      if (nowMs - seen > NOTICE_WINDOW_MS) st.topics.delete(k);
    }
    st.topics.set(topicKey, nowMs);

    // Cross-topic ceiling: >3 distinct topics for one (peer,cause) → suppress
    // per-topic notices, emit ONE aggregated hub alert.
    if (st.topics.size > CROSS_TOPIC_CEILING) {
      if (!st.ceilingAlerted) {
        st.ceilingAlerted = true;
        this.d.alertHub(
          'Sender rejections across many topics',
          `"${peer}" is rejecting senders across ${st.topics.size} topics (cause: ${cause}). Per-topic notices are suppressed to avoid a flood; check the peer's user registry health.`,
        );
      }
      return; // ceiling breached — no per-topic notice.
    }

    // Flapping-proof decay cadence (time-since-first-observed). A short recovery
    // does NOT re-arm the fast cadence (only the sustained-clear reset above does).
    const ageMs = nowMs - st.firstObservedAt;
    let step = DECAY_STEPS_MS[0];
    if (ageMs >= DECAY_STEPS_MS[1]) step = DECAY_STEPS_MS[2];
    else if (ageMs >= DECAY_STEPS_MS[0]) step = DECAY_STEPS_MS[1];

    // Secondary in-memory (topic,cause) window bound.
    const windowKey = `${topicKey}|${cause}`;
    const lastForTopic = this.topicWindow.get(windowKey) ?? -Infinity;
    // Emit unless within the current decay step for this (peer,cause) AND within
    // the secondary (topic,cause) window.
    if (nowMs - st.lastNoticeAt < step && nowMs - lastForTopic < NOTICE_WINDOW_MS) {
      return;
    }

    st.lastNoticeAt = nowMs;
    this.topicWindow.set(windowKey, nowMs);
    this.emit(evt);
  }

  private emit(evt: SenderRejectionEvent): void {
    if (evt.adapter === 'telegram' && evt.topicId != null) {
      this.d.sendTelegram(evt.topicId, SENDER_DEAUTHORIZED_NOTICE);
    } else if (evt.adapter === 'slack' && evt.slackKey && this.d.sendSlack) {
      this.d.sendSlack(evt.slackKey, SENDER_DEAUTHORIZED_NOTICE);
    }
  }
}
