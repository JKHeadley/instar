/**
 * OwnerDarkLadder — Layer A's `other-dark` arm (ownership-gated-spawn-and-
 * judgment-within-floors spec §3.3): what happens to a conversation whose
 * owning machine is temporarily dark, instead of the legacy bootleg local
 * spawn (the 2026-07-10 incident) or silence.
 *
 * The ladder's rungs:
 *  1. HOLD — lives in the inbound queue's hold-for-stability policy (upstream
 *     of this module; trails the queue by one rollout stage by that spec's own
 *     design). Not re-implemented here.
 *  2. CLAIM-THEN-SPAWN — the stale-owner-release evidence bar + single CAS
 *     funnel (StaleOwnerReleaseEngine). INERT while that engine is dryRun —
 *     this module only records that the rung was consulted (G3 honesty:
 *     a dark dependency is disclosed, never silently assumed).
 *  3. QUEUE + HONEST NOTICE — durable-queue custody where live; where dark,
 *     the deterministic floor is the state-accurate resend notice (FD9),
 *     delivered on the deterministic G1 path (`telegram.sendToTopic`) with a
 *     DECLARED exception to speaker election (election rule 1 is
 *     owner-liveness-blind and would structurally silence the notice).
 *
 * Increment 1 posture: dryRun-gated with the SpawnAdmission seam — every
 * decision is journaled (would-notice), nothing sends until enforce mode,
 * which itself requires durable custody (§3.1 item 6).
 *
 * Notice guards (all deterministic):
 *  - final owner-liveness re-check immediately before the send (a
 *    just-recovered owner answering normally suppresses the notice);
 *  - topic-scoped suppression (a recent identical notice visible in the
 *    topic's send history — episode dedupe is machine-scoped, so under
 *    split-brain two front doors could otherwise each notice);
 *  - ONE notice per (topic, outage-episode);
 *  - per-topic cooldown (default 30 min).
 */

import type { BoundedJsonlAudit } from './BoundedJsonlAudit.js';

/** FD9 — the two state-accurate notice wordings (the shipping text). */
export const OWNER_DARK_NOTICE_QUEUE_DARK =
  "That conversation's machine is temporarily unreachable (it may be restarting). " +
  "I can't safely answer from here, and I'm not holding your message — please resend " +
  'in a few minutes, or send it to my Lifeline topic if it\'s urgent.';
export const OWNER_DARK_NOTICE_QUEUE_LIVE =
  "That conversation's machine is temporarily unreachable (it may be restarting). " +
  'Your message is saved and will be answered automatically when it returns.';

export type LadderMode = 'dry-run' | 'enforce';

export type LadderAction =
  | 'would-notice'
  | 'noticed'
  | 'queue-custody-noticed'
  | 'suppressed-owner-recovered'
  | 'suppressed-episode-dedupe'
  | 'suppressed-cooldown'
  | 'suppressed-topic-history'
  | 'notice-send-failed';

export interface OwnerDarkLadderConfigView {
  /** Silence ceiling (§3.3): episode first held/refused message → answer or notice. */
  maxUserSilenceMs: number;
  /** Per-topic cooldown between notices. */
  noticeCooldownMs: number;
}

export interface OwnerDarkLadderDeps {
  /** Live owner-liveness input (heartbeat view) — the pre-send re-check. */
  isMachineAlive: (machineId: string) => boolean;
  /**
   * The deterministic G1 send path (`telegram.sendToTopic` — never the LLM
   * tone gate). Returns true when the platform accepted the send.
   */
  sendNotice: (topicId: number, text: string) => Promise<boolean>;
  /**
   * Topic-scoped suppression: does the topic's recent send history already
   * show an owner-dark notice (from ANY machine)? Split-brain guard.
   */
  topicHistoryHasRecentNotice: (topicId: number) => Promise<boolean> | boolean;
  /** logs/owner-dark-ladder.jsonl (shared with the SpawnAdmission error arm). */
  journal: BoundedJsonlAudit;
  log: (msg: string) => void;
  now?: () => number;
}

interface OutageEpisode {
  episodeId: string;
  ownerMachineId: string;
  openedAt: number;
  /** First held/refused message per topic — the silence-ceiling clock (§3.3). */
  firstRefusalByTopic: Map<number, number>;
  /** Topics already noticed this episode (ONE notice per topic-episode). */
  noticedTopics: Set<number>;
}

export interface OwnerDarkLadderStatus {
  openEpisodes: Array<{
    episodeId: string;
    ownerMachineId: string;
    openedAt: string;
    topicsRefused: number;
    topicsNoticed: number;
  }>;
  counters: Record<string, number>;
  config: OwnerDarkLadderConfigView;
}

export class OwnerDarkLadder {
  private readonly deps: OwnerDarkLadderDeps;
  private readonly cfg: OwnerDarkLadderConfigView;
  private readonly nowFn: () => number;
  /** One open episode per owner machine. */
  private episodes = new Map<string, OutageEpisode>();
  /** Per-topic cooldown across episodes (machine-scoped). */
  private lastNoticeAtByTopic = new Map<number, number>();
  private counters: Record<string, number> = {
    encounters: 0,
    wouldNotice: 0,
    noticed: 0,
    queueCustodyNoticed: 0,
    suppressedOwnerRecovered: 0,
    suppressedEpisodeDedupe: 0,
    suppressedCooldown: 0,
    suppressedTopicHistory: 0,
    sendFailed: 0,
    episodesClosed: 0,
  };

  constructor(cfg: Partial<OwnerDarkLadderConfigView> | undefined, deps: OwnerDarkLadderDeps) {
    this.cfg = {
      maxUserSilenceMs: cfg?.maxUserSilenceMs ?? 600_000,
      noticeCooldownMs: cfg?.noticeCooldownMs ?? 1_800_000,
    };
    this.deps = deps;
    this.nowFn = deps.now ?? (() => Date.now());
  }

  /**
   * The `other-dark` arm entry point — called by the SpawnAdmission wiring
   * when the seam's row (c) fires (dry-run: journal-only; enforce: rung 3).
   * `custodyLive` = the durable inbound queue holds this message (queue-live
   * wording); false = the honest resend wording.
   */
  async handleOwnerDark(input: {
    sessionKey: string;
    topicId: number | null;
    ownerMachineId: string;
    mode: LadderMode;
    custodyLive: boolean;
  }): Promise<{ episodeId: string; action: LadderAction }> {
    const now = this.nowFn();
    this.counters.encounters++;
    const ep = this.openOrGetEpisode(input.ownerMachineId, now);
    if (input.topicId !== null && !ep.firstRefusalByTopic.has(input.topicId)) {
      ep.firstRefusalByTopic.set(input.topicId, now);
    }

    const journalBase = {
      ts: new Date(now).toISOString(),
      kind: 'owner-dark-encounter',
      episodeId: ep.episodeId,
      ownerMachineId: input.ownerMachineId,
      sessionKey: input.sessionKey,
      topicId: input.topicId,
      mode: input.mode,
      custodyLive: input.custodyLive,
      // G3 honesty: rung 2 (claim) rides the stale-owner-release engine's own
      // rollout — this ladder never claims; it only records the consult.
      rung2: 'stale-owner-release-owns-claims',
    };

    if (input.topicId === null) {
      this.deps.journal.append({ ...journalBase, action: 'no-topic-no-notice' });
      return { episodeId: ep.episodeId, action: input.mode === 'enforce' ? 'noticed' : 'would-notice' };
    }
    const topicId = input.topicId;

    // ONE notice per (topic, outage-episode).
    if (ep.noticedTopics.has(topicId)) {
      this.counters.suppressedEpisodeDedupe++;
      this.deps.journal.append({ ...journalBase, action: 'suppressed-episode-dedupe' });
      return { episodeId: ep.episodeId, action: 'suppressed-episode-dedupe' };
    }
    // Per-topic cooldown (30 min default).
    const lastAt = this.lastNoticeAtByTopic.get(topicId);
    if (lastAt !== undefined && now - lastAt < this.cfg.noticeCooldownMs) {
      this.counters.suppressedCooldown++;
      this.deps.journal.append({ ...journalBase, action: 'suppressed-cooldown' });
      return { episodeId: ep.episodeId, action: 'suppressed-cooldown' };
    }

    if (input.mode !== 'enforce') {
      // Increment-1 posture: journal the would-notice, send nothing.
      ep.noticedTopics.add(topicId);
      this.counters.wouldNotice++;
      this.deps.journal.append({ ...journalBase, action: 'would-notice' });
      return { episodeId: ep.episodeId, action: 'would-notice' };
    }

    // ── Enforce mode: the rung-3 notice floor ──
    // Final owner-liveness re-check immediately before the send.
    let ownerAlive = false;
    try {
      ownerAlive = this.deps.isMachineAlive(input.ownerMachineId);
    } catch {
      ownerAlive = false;
    }
    if (ownerAlive) {
      this.counters.suppressedOwnerRecovered++;
      this.deps.journal.append({ ...journalBase, action: 'suppressed-owner-recovered' });
      this.ownerRecovered(input.ownerMachineId);
      return { episodeId: ep.episodeId, action: 'suppressed-owner-recovered' };
    }
    // Topic-scoped suppression (split-brain: another front door may have noticed).
    try {
      if (await this.deps.topicHistoryHasRecentNotice(topicId)) {
        this.counters.suppressedTopicHistory++;
        ep.noticedTopics.add(topicId);
        this.deps.journal.append({ ...journalBase, action: 'suppressed-topic-history' });
        return { episodeId: ep.episodeId, action: 'suppressed-topic-history' };
      }
    } catch {
      /* @silent-fallback-ok: history unreadable → fall through to the send (the dedupe layers above still bound it). */
    }

    const text = input.custodyLive ? OWNER_DARK_NOTICE_QUEUE_LIVE : OWNER_DARK_NOTICE_QUEUE_DARK;
    let sent = false;
    try {
      sent = await this.deps.sendNotice(topicId, text);
    } catch (err) {
      this.deps.log(`[OwnerDarkLadder] notice send threw: ${(err as Error).message}`);
    }
    if (!sent) {
      this.counters.sendFailed++;
      this.deps.journal.append({ ...journalBase, action: 'notice-send-failed' });
      return { episodeId: ep.episodeId, action: 'notice-send-failed' };
    }
    ep.noticedTopics.add(topicId);
    this.lastNoticeAtByTopic.set(topicId, now);
    const action: LadderAction = input.custodyLive ? 'queue-custody-noticed' : 'noticed';
    this.counters[input.custodyLive ? 'queueCustodyNoticed' : 'noticed']++;
    this.deps.journal.append({ ...journalBase, action, silenceMsAtNotice: now - (ep.firstRefusalByTopic.get(topicId) ?? now) });
    return { episodeId: ep.episodeId, action };
  }

  /** Owner recovery closes the episode (§3.3 — episode-scoped dedupe resets). */
  ownerRecovered(ownerMachineId: string): void {
    const ep = this.episodes.get(ownerMachineId);
    if (!ep) return;
    this.episodes.delete(ownerMachineId);
    this.counters.episodesClosed++;
    this.deps.journal.append({
      ts: new Date(this.nowFn()).toISOString(),
      kind: 'owner-dark-episode-closed',
      episodeId: ep.episodeId,
      ownerMachineId,
      durationMs: this.nowFn() - ep.openedAt,
      topicsRefused: ep.firstRefusalByTopic.size,
      topicsNoticed: ep.noticedTopics.size,
    });
  }

  /** Sweep: close episodes whose owner is alive again (rides any caller's tick). */
  sweepRecovered(): void {
    for (const machineId of [...this.episodes.keys()]) {
      try {
        if (this.deps.isMachineAlive(machineId)) this.ownerRecovered(machineId);
      } catch {
        /* @silent-fallback-ok: liveness unreadable → keep the episode open (safe direction). */
      }
    }
  }

  status(): OwnerDarkLadderStatus {
    return {
      openEpisodes: [...this.episodes.values()].map((ep) => ({
        episodeId: ep.episodeId,
        ownerMachineId: ep.ownerMachineId,
        openedAt: new Date(ep.openedAt).toISOString(),
        topicsRefused: ep.firstRefusalByTopic.size,
        topicsNoticed: ep.noticedTopics.size,
      })),
      counters: { ...this.counters },
      config: { ...this.cfg },
    };
  }

  private openOrGetEpisode(ownerMachineId: string, now: number): OutageEpisode {
    let ep = this.episodes.get(ownerMachineId);
    if (ep) return ep;
    ep = {
      episodeId: `dark-${ownerMachineId.slice(0, 8)}-${now.toString(36)}`,
      ownerMachineId,
      openedAt: now,
      firstRefusalByTopic: new Map(),
      noticedTopics: new Set(),
    };
    this.episodes.set(ownerMachineId, ep);
    this.deps.journal.append({
      ts: new Date(now).toISOString(),
      kind: 'owner-dark-episode-opened',
      episodeId: ep.episodeId,
      ownerMachineId,
    });
    return ep;
  }
}
