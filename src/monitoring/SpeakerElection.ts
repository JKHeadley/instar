/**
 * SpeakerElection — the WS3 "one voice" gate (MULTI-MACHINE-SEAMLESSNESS-SPEC).
 *
 * Decides whether THIS machine speaks for a topic's sentinel-class emissions
 * (PresenceProxy standby notices, PromiseBeacon heartbeats). The invariant is
 * exactly-one-speaks in BOTH directions:
 *
 *   ≤1 — only the topic's owner machine speaks; a non-owner stays silent
 *        (kills the F18/F23 double-voice family).
 *   ≥1 — "unknown owner" NEVER maps to pool-wide silence: the gate fails
 *        toward speech-with-dedup via the lease-holder, then a deterministic
 *        lowest-machineId tiebreak (kills the silent-agent dual the round-1
 *        adversarial review proved was worse than double-voice).
 *
 * Lease-stability dwell: while the lease epoch is advancing/contested, the
 * verdict is DEFER (the caller re-arms) rather than a speak decision on a
 * transient lease read — and a chosen speaker identity is HELD for a dwell
 * window so a mid-flap flip cannot hand the microphone back and forth.
 * Deferral is bounded: once instability persists past the dwell window, the
 * deterministic tiebreak speaks (fail toward speech, never unbounded silence).
 *
 * Signal-vs-authority: this gate constrains only WHO SPEAKS a duplicate-prone
 * notice — never recovery actions, never message content, never user-initiated
 * flows. It is deterministic over replicated state, fails open to "speak"
 * whenever it cannot decide, and is dark behind multiMachine.seamlessness
 * (ws3OneVoice). Flag off, no machine id, or single-machine pool → verdict is
 * always "speak" with zero behavior delta (spec invariant 6).
 */

export interface SpeakerElectionDeps {
  /** Dark flag: multiMachine.seamlessness.ws3OneVoice (read live per decision). */
  enabled: () => boolean;
  /** This machine's pool id; absent → legacy behavior (always speak). */
  currentMachineId?: string;
  /** Online pool machine ids INCLUDING self. Length < 2 → single-machine no-op. */
  poolMachineIds: () => string[];
  /**
   * The topic's current owner from local replicated placement (never a mesh
   * call — hot path). null = unknown/unowned.
   */
  resolveTopicOwner: (topicId: number) => string | null;
  /** The current lease-holder's machine id (null = no/unknown holder). */
  leaseHolderId: () => string | null;
  /** Is the lease epoch stable (not mid-flap/contested)? */
  leaseStable: () => boolean;
  /** Dwell window ms for both defer-bounding and speaker-identity hold. */
  dwellMs?: number;
  /** Observability hook (P7): every verdict is reported, never silent. */
  onVerdict?: (topicId: number, verdict: SpeakerVerdict) => void;
  now?: () => number;
}

export interface SpeakerVerdict {
  speak: boolean;
  /** When true the caller should re-arm and re-ask after a short backoff —
   *  the election could not safely decide yet (lease mid-flap). */
  defer: boolean;
  reason:
    | 'legacy-disabled'
    | 'legacy-no-machine-id'
    | 'single-machine'
    | 'owner-self'
    | 'owner-other'
    | 'owner-stamp-self'
    | 'owner-stamp-other'
    | 'lease-holder-fallback'
    | 'tiebreak-lowest-id'
    | 'tiebreak-lost'
    | 'lease-unstable-defer'
    | 'dwell-hold';
}

const DEFAULT_DWELL_MS = 60_000;

interface DwellEntry {
  verdict: SpeakerVerdict;
  at: number;
}

export class SpeakerElection {
  private readonly deps: SpeakerElectionDeps;
  /** Per-topic held verdicts (speaker-identity dwell). */
  private readonly held = new Map<number, DwellEntry>();
  /** Per-topic first-seen instability timestamps (defer bounding). */
  private readonly unstableSince = new Map<number, number>();

  constructor(deps: SpeakerElectionDeps) {
    this.deps = deps;
  }

  /**
   * Decide whether this machine speaks for `topicId`.
   * `stampedOwner` is the durable fallback (e.g. a commitment's ownerMachineId)
   * used when live placement has no owner for the topic.
   */
  decide(topicId: number, stampedOwner?: string | null): SpeakerVerdict {
    const v = this.decideInner(topicId, stampedOwner ?? null);
    try { this.deps.onVerdict?.(topicId, v); } catch { /* observability never gates */ }
    return v;
  }

  private decideInner(topicId: number, stampedOwner: string | null): SpeakerVerdict {
    const now = this.deps.now?.() ?? Date.now();
    const dwellMs = this.deps.dwellMs ?? DEFAULT_DWELL_MS;

    // Legacy / no-op guards FIRST — none of the election machinery is entered.
    if (!this.deps.enabled()) return { speak: true, defer: false, reason: 'legacy-disabled' };
    const self = this.deps.currentMachineId;
    if (!self) return { speak: true, defer: false, reason: 'legacy-no-machine-id' };
    const pool = this.deps.poolMachineIds();
    if (pool.length < 2) return { speak: true, defer: false, reason: 'single-machine' };

    // Speaker-identity dwell: a recent decisive verdict is HELD so a lease flap
    // between two emissions cannot alternate the voice. Decisive = speak/silent
    // chosen by election (not legacy/no-op shapes, which never reach here).
    const heldEntry = this.held.get(topicId);
    if (heldEntry && now - heldEntry.at < dwellMs) {
      return { ...heldEntry.verdict, reason: 'dwell-hold' };
    }

    // 1) Live placement owner wins.
    const liveOwner = this.deps.resolveTopicOwner(topicId);
    if (liveOwner) {
      this.unstableSince.delete(topicId);
      return this.hold(topicId, now, liveOwner === self
        ? { speak: true, defer: false, reason: 'owner-self' }
        : { speak: false, defer: false, reason: 'owner-other' });
    }

    // 2) Durable stamp fallback (a commitment's recorded owner).
    if (stampedOwner) {
      this.unstableSince.delete(topicId);
      return this.hold(topicId, now, stampedOwner === self
        ? { speak: true, defer: false, reason: 'owner-stamp-self' }
        : { speak: false, defer: false, reason: 'owner-stamp-other' });
    }

    // 3) Owner unknown → fail toward speech-with-dedup. While the lease is
    // mid-flap, DEFER (bounded) instead of deciding on a transient read.
    if (!this.deps.leaseStable()) {
      const since = this.unstableSince.get(topicId) ?? now;
      this.unstableSince.set(topicId, since);
      if (now - since < dwellMs) {
        return { speak: false, defer: true, reason: 'lease-unstable-defer' };
      }
      // Instability outlived the dwell bound → deterministic tiebreak speaks.
      this.unstableSince.delete(topicId);
      return this.hold(topicId, now, this.tiebreak(self, pool));
    }
    this.unstableSince.delete(topicId);

    // 4) Stable lease, unknown owner → the lease-holder speaks. The ≥1 half of
    // the invariant holds because every machine runs this same deterministic
    // election over replicated inputs: exactly the holder reaches speak here.
    const holder = this.deps.leaseHolderId();
    if (holder && pool.includes(holder)) {
      return this.hold(topicId, now, holder === self
        ? { speak: true, defer: false, reason: 'lease-holder-fallback' }
        : { speak: false, defer: false, reason: 'tiebreak-lost' });
    }
    // No holder, or the holder is not among the ONLINE machines (holder dark —
    // a "stable" lease pointing at a machine that can't speak): deterministic
    // lowest-online-id tiebreak keeps ≥1 true instead of pool-wide silence.
    return this.hold(topicId, now, this.tiebreak(self, pool));
  }

  private tiebreak(self: string, pool: string[]): SpeakerVerdict {
    const lowest = [...pool].sort()[0];
    return lowest === self
      ? { speak: true, defer: false, reason: 'tiebreak-lowest-id' }
      : { speak: false, defer: false, reason: 'tiebreak-lost' };
  }

  private hold(topicId: number, now: number, v: SpeakerVerdict): SpeakerVerdict {
    this.held.set(topicId, { verdict: v, at: now });
    // Bounded memory: drop entries past the dwell window opportunistically.
    if (this.held.size > 512) {
      const dwellMs = this.deps.dwellMs ?? DEFAULT_DWELL_MS;
      for (const [k, e] of this.held) {
        if (now - e.at >= dwellMs) this.held.delete(k);
      }
    }
    return v;
  }
}
