/**
 * StandDownRegistry — the machine-local ENFORCEMENT RECORD for duplicate-session
 * stand-downs (spec: docs/specs/duplicate-session-standdown.md).
 *
 * WHAT A STAND-DOWN IS. When one conversation has live sessions on two machines,
 * exactly one voice may continue. The losing copy is not killed (round-4 review
 * rejected the terminate primitive: symmetric split-brain lets BOTH machines kill
 * their own copy, and a mid-tool-call kill destroys in-flight work). Instead it is
 * told to STOP STARTING new tool calls and STOP EMITTING user-visible output,
 * allowed to finish the step it holds, and then closed by the bounded
 * drained-close rule.
 *
 * NAMING HONESTY (the load-bearing caveat). This registry is an ENFORCEMENT CACHE
 * of verdicts whose AUTHORITY lives elsewhere — the replicated ownership records
 * and the duplicate reconciler's evidence ladder. It NEVER decides who owns a
 * conversation. `reverify()` keeps it a mirror with bounded staleness: an entry may
 * exist only while the ownership record names a DIFFERENT machine as owner AND
 * that owner holds a live session for the topic. Either leg failing (with
 * hysteresis) releases the entry. This is Signal vs Authority applied to state:
 * the registry holds no independent judgement.
 *
 * THE MARKER FILE. `state/standdown-active.json` lists the live muzzled session
 * names. The PreToolUse hook runs in a DIFFERENT process on EVERY tool call, so
 * the steady-state cost must be one stat + one small read, never an HTTP call.
 * The marker is rewritten write-temp+rename on every transition (a torn read must
 * be impossible), regenerated at every boot INCLUDING the corrupt-file boot (an
 * empty registry produces an EMPTY marker, never a stale one), and refreshed
 * periodically while entries exist — deletion between transitions was otherwise a
 * single point of silent bypass.
 *
 * EPISODES AND LATCHES (P19). An episode is `(sessionName, topicId,
 * ownershipEpoch)`. Its latch OUTLIVES its entry: a `released` or `expired`
 * episode blocks re-registration under the same key, so the producers' unchanged
 * verdicts cannot re-mint an episode the system already adjudicated. Re-admission
 * requires a STRICTLY NEWER ownershipEpoch (genuine new evidence) or an operator
 * ack. The latch cannot become a silent enforcement hole: N consecutive
 * latch-blocked attempts raise the episode's attention item.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Lifecycle states. `closed`/`released` are pruned from the live map on
 *  transition (history lives in the JSONL); `expired` is NOT — both enforcement
 *  halves persist past expiry, so the entry must remain consultable. */
export type StandDownState = 'standing-down' | 'drained' | 'closed' | 'expired' | 'released';

/** Why an entry left the live map — carried into the audit row. */
export type StandDownTransition =
  | 'registered'
  | 'drained'
  | 'closed'
  | 'expired'
  | 'released'
  | 'blocked-call'
  | 'refused-send'
  | 'latch-blocked'
  | 'notice-sent'
  | 'canary-hit'
  | 'degraded-boot';

export interface StandDownEntry {
  /** The tmux session name — the identity key. `INSTAR_SESSION_NAME` is the env
   *  var the hook resolves, and there is no "sessionId" in session env. */
  sessionName: string;
  /** The conversation this copy was serving. */
  topicId: number;
  /** The machine the ownership record names as owner (shape-clamped). */
  ownerMachineId: string;
  /** The ownership epoch the verdict rested on. Re-admission after a latch
   *  requires a STRICTLY NEWER value. */
  ownershipEpoch: number;
  reason: string;
  issuedAt: number;
  /** TTL deadline. RESUMES across re-registrations within one episode — it is
   *  never reset, or a producer re-confirming every tick would hold a session
   *  muzzled forever. */
  expiresAt: number;
  state: StandDownState;
  episodeId: string;
  /** dryRun entries log would-block/would-refuse verdicts and block NOTHING. */
  dryRun: boolean;
  /** Consecutive corroborated drain observations (needs `drainConfirmTicks`). */
  drainConfirmations: number;
  /** Consecutive FAILED re-verify legs (release needs the hysteresis count). */
  failedVerifyLegs: number;
  /** ONE notice per EPISODE **per channel**, not per registration. Two distinct
   *  audiences use this: the tmux line injected into the muzzled session, and
   *  the user-facing standby line. A shared budget meant whichever fired first
   *  permanently silenced the other, so a divert could leave the user with no
   *  line at all — which is precisely the silence this design exists to avoid. */
  noticeSent: Partial<Record<'session' | 'user', boolean>>;
  /** Counters for the coalesced audit + the episode's terminal row. */
  blockedCalls: number;
  refusedSends: number;
  /** Epoch ms of the drain boundary — tool calls completed after this do not
   *  count as pre-existing work. */
  drainBoundaryAt: number;
  /** Epoch ms of the last drain OBSERVATION. The drain window runs from here,
   *  not from `drainBoundaryAt`: measured from a fixed boundary, "the transcript
   *  grew" is monotonic and a session that went quiet an hour ago still reads as
   *  active forever. Starts at the drain boundary. */
  lastDrainObservedAt: number;
  /** Epoch ms of the last authoritative evaluate call for this session. Backs
   *  the impossible-state canary's ONLY reachable leg: a live ENFORCING entry
   *  whose session is completing tool calls while making NO evaluate calls is
   *  the signature of a lifted or bypassed marker file — which nothing else can
   *  see (the server never learns about a call the hook short-circuited). */
  lastEvaluateAt: number | null;
}

/** The persistent per-episode latch. Outlives the entry it braked. */
export interface StandDownLatch {
  episodeId: string;
  sessionName: string;
  topicId: number;
  ownershipEpoch: number;
  /** Terminal disposition that armed the latch. */
  disposition: 'released' | 'expired';
  latchedAt: number;
  /** Consecutive re-registration attempts refused by this latch. At
   *  `latchBlockedAttentionThreshold` the episode's attention item fires, so a
   *  released-then-latched LIVE duplicate is never invisible. */
  blockedAttempts: number;
  attentionRaised: boolean;
}

export interface StandDownRegistryConfig {
  /** TTL for a normal (drain-provable) framework. */
  standDownTtlMinutes: number;
  /** Shorter TTL where the drain predicate cannot be resolved (non-claude
   *  frameworks): the entry routes to the TTL/attention path BY DESIGN. */
  unprovableFrameworkTtlMinutes: number;
  /** Corroborated drain observations required before `drained`. */
  drainConfirmTicks: number;
  /** Consecutive failed re-verify legs before release (a single dark-peer tick
   *  must not flap the muzzle). */
  releaseHysteresisTicks: number;
  /** Latch-blocked attempts before the episode's attention item fires. */
  latchBlockedAttentionThreshold: number;
  /** Closed episodes per topic per 24h before the churn attention item fires. */
  closedEpisodeChurnThreshold: number;
  /** Distinct EXPIRED episodes in the health window before `health().due`. Every
   *  sibling threshold here is config-reachable; this one read as tunable and was
   *  hardcoded. */
  expiredEpisodeHealthThreshold: number;
}

export const DEFAULT_STANDDOWN_CONFIG: StandDownRegistryConfig = {
  standDownTtlMinutes: 60,
  unprovableFrameworkTtlMinutes: 15,
  drainConfirmTicks: 2,
  releaseHysteresisTicks: 2,
  latchBlockedAttentionThreshold: 5,
  closedEpisodeChurnThreshold: 3,
  expiredEpisodeHealthThreshold: 2,
};

/** Named refusal reasons — never a bare false. */
export type StandDownRegisterRefusal =
  | 'feature-disabled'
  | 'already-registered'
  | 'episode-latched'
  | 'malformed'
  | 'self-is-owner';

export interface RegisterRequest {
  sessionName: string;
  topicId: number;
  ownerMachineId: string;
  ownershipEpoch: number;
  reason: string;
  dryRun: boolean;
  /** True when the session's framework cannot prove drain (non-claude): the
   *  entry gets the shorter TTL and routes to the attention path by design. */
  drainUnprovable?: boolean;
}

export type RegisterResult =
  | { ok: true; entry: StandDownEntry; created: boolean }
  | { ok: false; refusal: StandDownRegisterRefusal; latch?: StandDownLatch };

/** Shape written to disk. Versioned so a future migration is not a guess. */
interface StandDownFileState {
  version: 1;
  updatedAt: string;
  entries: StandDownEntry[];
  latches: StandDownLatch[];
  /** Rolling record of closed episodes per topic, for the churn canary. */
  closedEpisodes: Array<{ topicId: number; episodeId: string; at: number }>;
  expiredEpisodes?: Array<{ topicId: number; episodeId: string; at: number; dryRun: boolean }>;
  canaryHits?: Array<{ topicId: number; sessionName: string; at: number; detail: string }>;
}

/** Machine ids land verbatim in the hook's block message and the world-readable
 *  audit; they originate from the peer-influenced mesh ownership registry. Clamp
 *  shape and length HERE rather than trusting the registry. */
const MACHINE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Session names are interpolated into a marker file the hook string-matches. */
const SESSION_NAME_PATTERN = /^[A-Za-z0-9_.:@-]{1,200}$/;

export interface StandDownRegistryDeps {
  /** The agent's `.instar` directory (i.e. `config.stateDir`) — `state/` and
   *  `logs/` hang off it. NOT the agent home: the resolved marker path is
   *  `<agentHome>/.instar/state/standdown-active.json`, and any consumer that
   *  drops the `.instar` segment reads a path nothing writes. */
  stateDir: string;
  now?: () => number;
  /** Structured audit sink. The registry never writes user-facing text. */
  audit?: (row: Record<string, unknown>) => void;
  log?: (msg: string) => void;
}

export class StandDownRegistry {
  #entries = new Map<string, StandDownEntry>();
  #latches = new Map<string, StandDownLatch>();
  #closedEpisodes: Array<{ topicId: number; episodeId: string; at: number }> = [];
  /** Distinct EXPIRED episodes (a muzzled session that never drained) and canary
   *  hits, both bounded to the health window. These are the standdown-health
   *  triggers: expiry means the cooperative primitive did not converge, and a
   *  canary hit means enforcement was silently lifted. */
  #expiredEpisodes: Array<{ topicId: number; episodeId: string; at: number; dryRun: boolean }> = [];
  #canaryHits: Array<{ topicId: number; sessionName: string; at: number; detail: string }> = [];
  readonly #deps: Required<Pick<StandDownRegistryDeps, 'stateDir'>> & StandDownRegistryDeps;
  readonly #now: () => number;
  #cfg: StandDownRegistryConfig;
  /** True when the durable file was unreadable at boot. Surfaced on GET
   *  /standdown as a degraded-mode row and raised ONCE as an attention item:
   *  minutes of un-enforced stand-downs must be VISIBLE, never silent. */
  #degradedBoot = false;
  #degradedBootReason: string | null = null;

  constructor(deps: StandDownRegistryDeps, cfg: Partial<StandDownRegistryConfig> = {}) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
    this.#cfg = { ...DEFAULT_STANDDOWN_CONFIG, ...cfg };
    this.#load();
    // Regenerate the marker from the (possibly empty) registry at EVERY boot,
    // including the corrupt-file boot — a stale marker left behind by a crashed
    // predecessor would otherwise muzzle sessions no entry justifies.
    this.#writeMarker();
  }

  get config(): StandDownRegistryConfig { return this.#cfg; }
  setConfig(cfg: Partial<StandDownRegistryConfig>): void { this.#cfg = { ...this.#cfg, ...cfg }; }

  get degradedBoot(): { degraded: boolean; reason: string | null } {
    return { degraded: this.#degradedBoot, reason: this.#degradedBootReason };
  }

  get statePath(): string { return path.join(this.#deps.stateDir, 'state', 'standdown.json'); }
  get markerPath(): string { return path.join(this.#deps.stateDir, 'state', 'standdown-active.json'); }

  /** Deterministic episode identity. Same (session, topic, epoch) ⇒ same id, so
   *  a latch written before a restart still matches the episode after it. */
  static episodeId(sessionName: string, topicId: number, ownershipEpoch: number): string {
    return `${sessionName}::${topicId}::${ownershipEpoch}`;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /** Live entries (everything currently in the map, including `expired`). */
  list(): StandDownEntry[] { return [...this.#entries.values()]; }
  latches(): StandDownLatch[] { return [...this.#latches.values()]; }

  /** The enforcement read for the PreToolUse evaluate route. */
  getBySession(sessionName: string): StandDownEntry | null {
    return this.#entries.get(sessionName) ?? null;
  }

  /**
   * The enforcement read for the outbound funnels. Topic-keyed BY DESIGN: an
   * entry exists only on the LOSING machine, so the winner's sends — on its own
   * machine — never see one.
   */
  getByTopic(topicId: number): StandDownEntry | null {
    for (const e of this.#entries.values()) {
      if (e.topicId === topicId && (e.state === 'standing-down' || e.state === 'drained' || e.state === 'expired')) return e;
    }
    return null;
  }

  /** Is this session muzzled RIGHT NOW (enforcing, not dry-run)? */
  isEnforcing(entry: StandDownEntry | null): boolean {
    if (!entry) return false;
    if (entry.dryRun) return false;
    return entry.state === 'standing-down' || entry.state === 'drained' || entry.state === 'expired';
  }

  /** Closed episodes for a topic inside the churn window. */
  closedEpisodeCount(topicId: number, windowMs = 86_400_000): number {
    const cutoff = this.#now() - windowMs;
    return this.#closedEpisodes.filter((c) => c.topicId === topicId && c.at >= cutoff).length;
  }

  /**
   * Record an impossible-state canary hit: a live ENFORCING entry whose session
   * completed tool calls while making ZERO evaluate calls in the window. That is
   * the signature of a lifted, deleted, or bypassed marker file — a hole nothing
   * else can see, because the server never hears about a call the hook
   * short-circuited.
   *
   * The INVERSE leg the spec also names (a hook-side block with no server-side
   * entry) is structurally IMPOSSIBLE in this build and is deliberately NOT
   * implemented: the hook holds no verdict of its own — it asks the server on
   * every non-allowlisted call and obeys the answer — so a hook block without a
   * server entry cannot occur. A check that is true by construction is exactly
   * the kind of reassuring no-op the spec's own round-1 review struck out.
   */
  recordCanaryHit(sessionName: string, detail: string): void {
    const e = this.#entries.get(sessionName);
    this.#canaryHits.push({ topicId: e?.topicId ?? -1, sessionName, at: this.#now(), detail });
    this.#trimHealthWindows();
    this.#persist();
    this.#audit({ transition: 'canary-hit', sessionName, topicId: e?.topicId, detail });
  }

  /**
   * The standdown-health summary. `due` is true when the feature is behaving in
   * a way a human should look at: more than the configured number of DISTINCT
   * episodes expired in the window (the cooperative primitive is not
   * converging), or ANY canary hit (enforcement was silently lifted).
   *
   * dryRun expirations are EXCLUDED. In dryRun nothing is blocked, so a busy
   * session reaching TTL is the expected state, not a signal — paging the
   * operator with an enforcement-shaped alarm about an observe-only mode is
   * precisely the noise that gets alarms ignored.
   */
  health(windowMs = 7 * 86_400_000): {
    due: boolean; expiredEpisodes: number; canaryHits: number;
    liveEntries: number; latches: number; degradedBoot: boolean;
  } {
    const cutoff = this.#now() - windowMs;
    const expired = this.#expiredEpisodes.filter((e) => e.at >= cutoff && !e.dryRun);
    const canary = this.#canaryHits.filter((c) => c.at >= cutoff);
    return {
      due: expired.length > this.#cfg.expiredEpisodeHealthThreshold || canary.length > 0,
      expiredEpisodes: expired.length,
      canaryHits: canary.length,
      liveEntries: this.#entries.size,
      latches: this.#latches.size,
      degradedBoot: this.#degradedBoot,
    };
  }

  #trimHealthWindows(): void {
    const cutoff = this.#now() - 7 * 86_400_000;
    this.#expiredEpisodes = this.#expiredEpisodes.filter((e) => e.at >= cutoff);
    this.#canaryHits = this.#canaryHits.filter((c) => c.at >= cutoff);
  }

  // ── Registration ─────────────────────────────────────────────────────────

  /**
   * Register a stand-down. Refuses — with a NAMED reason — rather than guessing.
   * Idempotent inside an episode: a producer re-confirming its verdict updates
   * the existing entry and does NOT reset the TTL.
   */
  register(req: RegisterRequest, actualLocalMachineId: string | null): RegisterResult {
    if (!SESSION_NAME_PATTERN.test(req.sessionName)) return { ok: false, refusal: 'malformed' };
    if (!MACHINE_ID_PATTERN.test(req.ownerMachineId)) return { ok: false, refusal: 'malformed' };
    if (!Number.isFinite(req.topicId) || !Number.isFinite(req.ownershipEpoch)) return { ok: false, refusal: 'malformed' };
    // A machine the record names as owner never muzzles its OWN copy: a symmetric
    // episode would require both records wrong at once.
    if (actualLocalMachineId && req.ownerMachineId === actualLocalMachineId) {
      return { ok: false, refusal: 'self-is-owner' };
    }

    const episodeId = StandDownRegistry.episodeId(req.sessionName, req.topicId, req.ownershipEpoch);
    const now = this.#now();

    const existing = this.#entries.get(req.sessionName);
    if (existing && existing.episodeId === episodeId
      && (existing.state === 'standing-down' || existing.state === 'drained')) {
      // Idempotent re-confirm — TTL RESUMES, never resets.
      existing.reason = req.reason;
      this.#persist();
      return { ok: true, entry: existing, created: false };
    }

    // The admission latch. A released/expired episode cannot be re-minted by the
    // producers' unchanged verdicts; only a strictly newer epoch (or an operator
    // ack, which clears the latch) re-admits.
    const latch = this.#latches.get(episodeId);
    if (latch) {
      latch.blockedAttempts += 1;
      this.#persist();
      this.#audit({ transition: 'latch-blocked', episodeId, sessionName: req.sessionName, topicId: req.topicId, blockedAttempts: latch.blockedAttempts });
      return { ok: false, refusal: 'episode-latched', latch };
    }
    // A latch under an OLDER epoch for the same (session, topic) must not block a
    // genuinely re-adjudicated duplicate — that is what "strictly newer epoch"
    // buys. Nothing to do: the episodeId differs, so the lookup above missed.

    if (existing && existing.state !== 'closed' && existing.state !== 'released') {
      // A different episode already muzzles this session — one entry per session.
      return { ok: false, refusal: 'already-registered' };
    }

    const ttlMin = req.drainUnprovable ? this.#cfg.unprovableFrameworkTtlMinutes : this.#cfg.standDownTtlMinutes;
    const entry: StandDownEntry = {
      sessionName: req.sessionName,
      topicId: req.topicId,
      ownerMachineId: req.ownerMachineId,
      ownershipEpoch: req.ownershipEpoch,
      reason: req.reason,
      issuedAt: now,
      expiresAt: now + ttlMin * 60_000,
      state: 'standing-down',
      episodeId,
      dryRun: req.dryRun,
      drainConfirmations: 0,
      failedVerifyLegs: 0,
      noticeSent: {},
      blockedCalls: 0,
      refusedSends: 0,
      drainBoundaryAt: now,
      lastDrainObservedAt: now,
      lastEvaluateAt: null,
    };
    this.#entries.set(req.sessionName, entry);
    this.#persist();
    this.#audit({ transition: 'registered', episodeId, sessionName: req.sessionName, topicId: req.topicId, ownerMachineId: req.ownerMachineId, dryRun: req.dryRun, expiresAt: entry.expiresAt });
    return { ok: true, entry, created: true };
  }

  // ── Transitions ──────────────────────────────────────────────────────────

  /** Record a corroborated drain observation. Returns true once `drained`. */
  observeDrain(sessionName: string, drained: boolean, observedAt?: number): boolean {
    const e = this.#entries.get(sessionName);
    if (!e || (e.state !== 'standing-down' && e.state !== 'drained')) return false;
    // Advance the window regardless of the verdict: the NEXT observation asks
    // "did anything happen since I last looked", which is only meaningful if
    // "last looked" moves.
    e.lastDrainObservedAt = observedAt ?? this.#now();
    if (!drained) {
      // Uncertainty is NOT evidence — an unconfirmed tick resets the streak AND
      // DEMOTES an already-drained entry. `drained` authorizes the three-reason
      // keep-guard bypass, so leaving it latched meant one pair of quiet windows
      // permanently authorized a close: a session that resumed work would be
      // closed the moment an unrelated guard stopped vetoing. P20 says verify the
      // STATE, not its symbol — and a state that can only ever be entered is a
      // symbol.
      const wasDrained = e.state === 'drained';
      const changed = e.drainConfirmations !== 0 || wasDrained;
      e.drainConfirmations = 0;
      if (wasDrained) {
        e.state = 'standing-down';
        // A demotion is a state CHANGE and every other one emits a row; leaving
        // it silent would make "how often did the predicate promote-then-demote"
        // — precisely the flip evidence the operator needs — unanswerable.
        this.#audit({ transition: 'drain-demoted', episodeId: e.episodeId, sessionName, topicId: e.topicId });
      }
      if (changed) this.#persist();
      return false;
    }
    e.drainConfirmations += 1;
    if (e.state !== 'drained' && e.drainConfirmations >= this.#cfg.drainConfirmTicks) {
      e.state = 'drained';
      this.#persist();
      this.#audit({ transition: 'drained', episodeId: e.episodeId, sessionName, topicId: e.topicId });
      return true;
    }
    this.#persist();
    return e.state === 'drained';
  }

  /** Terminal: the drained session was closed by the drained-close rule. */
  markClosed(sessionName: string): void {
    const e = this.#entries.get(sessionName);
    if (!e) return;
    this.#closedEpisodes.push({ topicId: e.topicId, episodeId: e.episodeId, at: this.#now() });
    // Keep the churn window bounded.
    const cutoff = this.#now() - 7 * 86_400_000;
    this.#closedEpisodes = this.#closedEpisodes.filter((c) => c.at >= cutoff);
    this.#audit({ transition: 'closed', episodeId: e.episodeId, sessionName, topicId: e.topicId, blockedCalls: e.blockedCalls, refusedSends: e.refusedSends });
    // A CLEAN close ends the episode correctly and arms NO latch — a later
    // genuine duplicate on the same key must be admissible.
    this.#entries.delete(sessionName);
    this.#persist();
  }

  /**
   * The entry's SESSION vanished (closed by another path, or absent while it
   * restarts). Remove the entry without recording a closed episode: nothing was
   * retired by the stand-down, and counting it inflated the churn evidence
   * toward an attention item about retirements that never happened. Arms no
   * latch — a future genuine duplicate on the same key stays admissible.
   */
  dropVanished(sessionName: string): void {
    const e = this.#entries.get(sessionName);
    if (!e) return;
    this.#audit({ transition: 'released', episodeId: e.episodeId, sessionName, topicId: e.topicId, why: 'session-vanished' });
    this.#entries.delete(sessionName);
    this.#persist();
  }

  /**
   * Release — the muzzle is lifted and the session resumes. Arms the episode
   * latch so the producers' unchanged verdicts cannot immediately re-mint it.
   */
  release(sessionName: string, why: string, opts?: { armLatch?: boolean }): void {
    const e = this.#entries.get(sessionName);
    if (!e) return;
    // The latch is the P19 brake against an unchanged verdict re-minting an
    // adjudicated episode — it belongs on a release that ADJUDICATED something.
    // A release caused by an UNRESOLVABLE read adjudicated nothing, so arming
    // the latch there would let one transient null permanently disable a
    // legitimate muzzle, which is a stronger consequence than the two-legged
    // reverify path it is supposed to mirror.
    if (opts?.armLatch !== false) this.#armLatch(e, 'released');
    this.#audit({ transition: 'released', episodeId: e.episodeId, sessionName, topicId: e.topicId, why });
    this.#entries.delete(sessionName);
    this.#persist();
  }

  /**
   * TTL expiry. BOTH enforcement halves PERSIST — the entry stays in the live map
   * and stays consulted. Expiry changes exactly two things: the attention item
   * fires once, and the drain clock stops being consulted. A session free to
   * mutate files and spawn work while unable to explain itself to anyone is not
   * quiescence but unaccountable autonomy; a frozen session awaiting the human is
   * the honest terminal state.
   */
  expire(sessionName: string): StandDownEntry | null {
    const e = this.#entries.get(sessionName);
    if (!e || e.state === 'expired') return null;
    e.state = 'expired';
    this.#expiredEpisodes.push({ topicId: e.topicId, episodeId: e.episodeId, at: this.#now(), dryRun: e.dryRun });
    this.#trimHealthWindows();
    this.#armLatch(e, 'expired');
    this.#persist();
    this.#audit({ transition: 'expired', episodeId: e.episodeId, sessionName, topicId: e.topicId, dryRun: e.dryRun });
    return e;
  }

  /** Operator ack of an expired episode: clears the latch and the entry. */
  operatorRelease(sessionName: string): boolean {
    const e = this.#entries.get(sessionName);
    if (e) {
      this.#latches.delete(e.episodeId);
      this.#entries.delete(e.sessionName);
      this.#audit({ transition: 'released', episodeId: e.episodeId, sessionName, topicId: e.topicId, why: 'operator-ack' });
      this.#persist();
      return true;
    }
    return false;
  }

  /** Count a blocked tool call (coalesced at the audit sink, counted here). */
  countBlockedCall(sessionName: string): StandDownEntry | null {
    const e = this.#entries.get(sessionName);
    if (!e) return null;
    e.blockedCalls += 1;
    e.lastEvaluateAt = this.#now();
    this.#persistThrottled();
    return e;
  }

  /** Count a refused outbound send. */
  countRefusedSend(topicId: number): StandDownEntry | null {
    const e = this.getByTopic(topicId);
    if (!e) return null;
    e.refusedSends += 1;
    this.#persistThrottled();
    return e;
  }

  /** ONE injected notice per EPISODE. Returns true if the caller should send it. */
  /** Non-consuming read: has this channel's per-episode notice already been
   *  claimed? Callers that send BEFORE claiming (so a failed send does not burn
   *  the budget) must read this first, or "claim on success" is a send loop. */
  hasNotice(sessionName: string, channel: 'session' | 'user'): boolean {
    const e = this.#entries.get(sessionName);
    if (!e) return false;
    if (typeof e.noticeSent !== 'object' || e.noticeSent === null) return false;
    return e.noticeSent[channel] === true;
  }

  claimNotice(sessionName: string, channel: 'session' | 'user' = 'session'): boolean {
    const e = this.#entries.get(sessionName);
    if (!e) return false;
    // Tolerate a record persisted by an older build, where this was a boolean.
    if (typeof e.noticeSent !== 'object' || e.noticeSent === null) e.noticeSent = {};
    if (e.noticeSent[channel]) return false;
    // A cooperative model complying with a dryRun notice would silently enforce a
    // mode sold as observe-only.
    if (e.dryRun) return false;
    e.noticeSent[channel] = true;
    this.#persist();
    this.#audit({ transition: 'notice-sent', episodeId: e.episodeId, sessionName, topicId: e.topicId, channel });
    return true;
  }

  /**
   * The cadence re-verify — the AGREEMENT INVARIANT. An entry may exist only
   * while the record names a DIFFERENT machine as owner AND that owner holds a
   * live session. `ok:false` counts a failed leg; release fires only after the
   * hysteresis count, so one dark-peer tick cannot flap the muzzle.
   */
  reverify(sessionName: string, ok: boolean, why: string): 'held' | 'released' {
    const e = this.#entries.get(sessionName);
    if (!e) return 'held';
    if (ok) {
      if (e.failedVerifyLegs !== 0) { e.failedVerifyLegs = 0; this.#persist(); }
      return 'held';
    }
    e.failedVerifyLegs += 1;
    if (e.failedVerifyLegs >= this.#cfg.releaseHysteresisTicks) {
      this.release(sessionName, why);
      return 'released';
    }
    this.#persist();
    return 'held';
  }

  /** Prune latches whose epoch is superseded, or that are older than 30 days. */
  pruneLatches(currentEpochByTopic: Map<number, number>): number {
    const cutoff = this.#now() - 30 * 86_400_000;
    let pruned = 0;
    for (const [id, l] of [...this.#latches.entries()]) {
      const currentEpoch = currentEpochByTopic.get(l.topicId);
      const superseded = currentEpoch != null && currentEpoch > l.ownershipEpoch;
      if (superseded || l.latchedAt < cutoff) { this.#latches.delete(id); pruned++; }
    }
    if (pruned > 0) this.#persist();
    return pruned;
  }

  /** Latches whose blocked-attempt count crossed the attention threshold and
   *  have not yet raised. Marks them raised so the item fires once. */
  claimLatchAttention(): StandDownLatch[] {
    const due = [...this.#latches.values()].filter(
      (l) => !l.attentionRaised && l.blockedAttempts >= this.#cfg.latchBlockedAttentionThreshold,
    );
    if (due.length > 0) { for (const l of due) l.attentionRaised = true; this.#persist(); }
    return due;
  }

  /** Refresh the marker file — called on the reaper cadence while entries exist,
   *  so a deleted or corrupted marker cannot silently lift the muzzle until the
   *  next transition. */
  refreshMarker(): void { this.#writeMarker(); }

  // ── Internals ────────────────────────────────────────────────────────────

  #armLatch(e: StandDownEntry, disposition: 'released' | 'expired'): void {
    const existing = this.#latches.get(e.episodeId);
    if (existing) { existing.disposition = disposition; return; }
    this.#latches.set(e.episodeId, {
      episodeId: e.episodeId,
      sessionName: e.sessionName,
      topicId: e.topicId,
      ownershipEpoch: e.ownershipEpoch,
      disposition,
      latchedAt: this.#now(),
      blockedAttempts: 0,
      attentionRaised: false,
    });
  }

  #load(): void {
    try {
      if (!fs.existsSync(this.statePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf-8')) as StandDownFileState;
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) throw new Error('malformed');
      for (const e of raw.entries) {
        if (e && typeof e.sessionName === 'string' && SESSION_NAME_PATTERN.test(e.sessionName)) {
          this.#entries.set(e.sessionName, e);
        }
      }
      for (const l of raw.latches ?? []) if (l && typeof l.episodeId === 'string') this.#latches.set(l.episodeId, l);
      this.#closedEpisodes = Array.isArray(raw.closedEpisodes) ? raw.closedEpisodes : [];
      this.#expiredEpisodes = Array.isArray(raw.expiredEpisodes) ? raw.expiredEpisodes : [];
      this.#canaryHits = Array.isArray(raw.canaryHits) ? raw.canaryHits : [];
    } catch (err) {
      // A corrupt durable file starts the registry EMPTY with a loud log. The
      // producers re-derive their verdicts over the following ticks (minutes —
      // the dwell must re-accumulate across distinct snapshot generations). This
      // IS a known fail-open window; it is surfaced rather than hidden.
      this.#entries.clear();
      this.#latches.clear();
      this.#closedEpisodes = [];
      this.#expiredEpisodes = [];
      this.#canaryHits = [];
      this.#degradedBoot = true;
      this.#degradedBootReason = err instanceof Error ? err.message : String(err);
      this.#deps.log?.(`[standdown] durable registry unreadable at boot — starting EMPTY (degraded, un-enforced until producers re-derive): ${this.#degradedBootReason}`);
      this.#audit({ transition: 'degraded-boot', reason: this.#degradedBootReason });
    }
  }

  #lastPersistAt = 0;

  /** Counter-only updates (blocked calls, refused sends) must not fsync per tool
   *  call on a model retry-looping blocked calls. */
  #persistThrottled(): void {
    const now = this.#now();
    if (now - this.#lastPersistAt < 5_000) return;
    this.#persist();
  }

  #persist(): void {
    this.#lastPersistAt = this.#now();
    try {
      const dir = path.dirname(this.statePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const state: StandDownFileState = {
        version: 1,
        updatedAt: new Date(this.#now()).toISOString(),
        entries: [...this.#entries.values()],
        latches: [...this.#latches.values()],
        closedEpisodes: this.#closedEpisodes,
        expiredEpisodes: this.#expiredEpisodes,
        canaryHits: this.#canaryHits,
      };
      const tmp = `${this.statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
      fs.renameSync(tmp, this.statePath);
    } catch (err) {
      this.#deps.log?.(`[standdown] persist failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.#writeMarker();
  }

  /**
   * The hook's fast path. Written write-temp+rename because it is read from OTHER
   * processes on every tool call — a torn read must be impossible. dryRun entries
   * ARE listed: the soak must exercise the marker path so the per-call cost is
   * measured rather than asserted (the hook resolves dryRun from the server).
   */
  #writeMarker(): void {
    try {
      const dir = path.dirname(this.markerPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const sessions = [...this.#entries.values()]
        .filter((e) => e.state === 'standing-down' || e.state === 'drained' || e.state === 'expired')
        .map((e) => e.sessionName);
      const tmp = `${this.markerPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ updatedAt: new Date(this.#now()).toISOString(), sessions }), 'utf-8');
      fs.renameSync(tmp, this.markerPath);
    } catch (err) {
      this.#deps.log?.(`[standdown] marker write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #audit(row: Record<string, unknown>): void {
    try {
      this.#deps.audit?.({ ts: new Date(this.#now()).toISOString(), ...row });
    } catch (err) {
      // Observability never endangers the observed — but a SILENT catch here hid
      // a real defect (the sink was dereferenced in its temporal dead zone, so
      // the degraded-boot row could never land). Swallow the failure, not the
      // knowledge of it.
      this.#deps.log?.(`[standdown] audit sink failed for ${String(row.transition)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
