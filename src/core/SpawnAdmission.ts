/**
 * SpawnAdmission — the binding-verdict seam at every session-creating callsite
 * for a conversation-bound topic (ownership-gated-spawn-and-judgment-within-floors
 * spec §3.1, Layer A; the runtime arm of the Ownership-Gated Side Effects standard).
 *
 * The 2026-07-10 incident in one line: the router computed the right verdict
 * ("owner dark → queue") and the inbound handler's fall-through spawned locally
 * anyway, 6ms later — the verdict was advice, and the code that creates sessions
 * never asked. This seam makes the verdict BINDING: every uninstrumented
 * session-creating callsite (Telegram cold-spawn/respawn, Slack inbound/recovery
 * spawn) consults `admit()` before creating a session.
 *
 * Deterministic floor — the admission table (§3.1, rows lettered):
 *   (a) `self`        → spawn (today's behavior).
 *   (b) `other-alive` → forward; never a local spawn.
 *   (c) `other-dark`  → NEVER spawn locally — the owner-dark ladder (§3.3).
 *   (d) `unowned`     → spawn only as the claimed owner (the router's
 *                       placeAndClaim already does the claim; the seam makes its
 *                       result binding by consuming the router verdict).
 *   (e) `error`       → spawn locally (reachability wins over a broken store),
 *                       BOUNDED: once-per-topic-per-episode journal row + ONE
 *                       deduped attention item + a windowed breaker.
 *
 * Enforcement invariant (§3.1 item 6, round-4): with the durable inbound queue
 * dark, this seam CANNOT block a spawn outside dryRun — rows (c) and the
 * queued-suppression are enforceable only where durable custody exists.
 * `effectiveMode()` encodes that structurally: `enforce` requires
 * enabled && !dryRun && durableCustodyLive(). Everywhere else the seam observes.
 *
 * Single-machine installs / pool 'dark': `admit()` short-circuits to allow —
 * byte-identical behavior, zero writes, zero regression (§3.1 item 5).
 *
 * Error-arm breaker bounds are CODE CONSTANTS, not config (§3.1 row e — the
 * self-action-backpressure precedent): tunable only by PR.
 *
 * Signal vs. Authority: this is a deterministic floor in the documented
 * exemption class (enumerable-domain invariant — one owner per conversation —
 * plus a safety guard on an action with irreversible external side effects).
 * It consumes the router's already-computed verdict rather than adding a new
 * brittle detector with authority; every ambiguous arm fails toward
 * reachability, loudly and boundedly.
 */

export type OwnershipKind = 'self' | 'other-alive' | 'other-dark' | 'unowned' | 'error';

export interface OwnershipResolution {
  kind: OwnershipKind;
  owner: string | null;
  epoch: number;
  /** Present only for kind 'error' — the resolution failure, message-only. */
  error?: string;
}

/**
 * Error-arm breaker bounds (§3.1 row e / FD11) — CODE CONSTANTS, never config.
 * A safety bound in config is a safety bound an emergency edit can silently
 * remove (the 2026-06-05 load-shed lesson); these change only by reviewed PR.
 */
export const ERROR_ARM_CONSTANTS = {
  /** Breaker trips on K consecutive resolution errors. */
  CONSECUTIVE_TRIP: 5,
  /** …OR a windowed rate: ≥ N errors in the window, regardless of interleaved successes. */
  WINDOWED_TRIP_COUNT: 8,
  WINDOWED_TRIP_WINDOW_MS: 600_000,
  /** An episode closes only after J consecutive clean resolutions (hysteresis). */
  HYSTERESIS_CLEAN_CLOSES: 10,
  /** ≥ N episodes per machine per 24h escalates the attention item to HIGH. */
  EPISODES_HIGH_THRESHOLD: 3,
  EPISODES_WINDOW_MS: 86_400_000,
} as const;

export type AdmissionMode = 'off' | 'dry-run' | 'enforce';

export type AdmissionRow =
  | 'self'
  | 'other-alive'
  | 'other-dark'
  | 'unowned'
  | 'error'
  | 'short-circuit'
  | 'router-queued-suppress'
  | 'router-consumed';

/** What the caller must do when `allow` is false (enforce mode only). */
export type RefusalAction = 'forward' | 'owner-dark-ladder' | 'rung3-notice';

export interface AdmissionDecision {
  /** May the caller create a local session NOW. Always true outside enforce mode. */
  allow: boolean;
  mode: AdmissionMode;
  row: AdmissionRow;
  /** Dry-run observability: enforcement WOULD have refused this spawn. */
  wouldBlock: boolean;
  /** Present when allow === false — the deterministic refusal path. */
  refusalAction?: RefusalAction;
  reason: string;
  ownership?: OwnershipResolution;
  /** The router verdict action consumed via the TOCTOU guard, when one was supplied. */
  consumedRouterVerdict?: string;
}

export interface AdmitInput {
  /** The conversation session key (Telegram: String(topicId); Slack: routing key). */
  sessionKey: string;
  /** Which session-creating callsite is asking — journaled for provenance. */
  callsite:
    | 'telegram-cold-spawn'
    | 'telegram-respawn-context-exhausted'
    | 'telegram-respawn-dead'
    | 'slack-inbound-spawn'
    | 'slack-recovery-spawn';
  /**
   * TOCTOU guard (§3.1 item 2): when the router already produced a verdict for
   * this message, the seam CONSUMES it rather than re-resolving — the admission
   * decision and the routing decision cannot disagree mid-dispatch.
   */
  routerVerdict?: { messageId: string; action: string; acked: boolean };
}

export interface SpawnAdmissionFlag {
  enabled: boolean;
  dryRun: boolean;
}

export interface SpawnAdmissionDeps {
  /** Mesh self machine id; null/undefined = pool not wired (single machine). */
  selfMachineId: () => string | null | undefined;
  /** Session-pool rollout stage; 'dark' = the pool is off → short-circuit. */
  poolStage: () => string;
  /**
   * Raw ownership read over the IN-MEMORY/CACHED registry view — never a
   * synchronous durable read on the inbound path (§3.1 item 1). May throw;
   * resolveOwnershipSafe wraps it.
   */
  readOwnership: (sessionKey: string) => { owner: string | null; epoch: number; status: string | null } | null;
  /** The pool's existing liveness input (heartbeat-fresh view). */
  isMachineAlive: (machineId: string) => boolean;
  /** Durable inbound-queue custody live on this machine (enforcement precondition). */
  durableCustodyLive: () => boolean;
  /** Appender for logs/owner-dark-ladder.jsonl (scrubbed, metadata-only rows). */
  journal: (row: Record<string, unknown>) => void;
  /** Deduped attention raise (dedupe key supplied by the seam). */
  raiseAttention: (item: { id: string; title: string; body: string; priority: 'high' | 'medium' }) => void;
  /** Deterministic-verdict provenance row (JudgmentProvenanceLog), wired at boot. */
  provenance?: (row: {
    component: string;
    decisionPoint: string;
    context: Record<string, unknown>;
    optionsPresented: string[];
    decision: string;
    reason: string;
    floor: string;
    fallbackRung: 'deterministic';
  }) => void;
  log: (msg: string) => void;
  now?: () => number;
}

/**
 * resolveOwnershipSafe — the non-throwing tri-state wrapper over the ownership
 * registry (§3.1 item 1). Closes the §2.1 ambiguity: callers today cannot
 * distinguish owner-dark vs unowned vs error (registry reads THROW into the
 * handler's fail-open catch). Reads the cached view only.
 */
export function resolveOwnershipSafe(
  sessionKey: string,
  deps: Pick<SpawnAdmissionDeps, 'selfMachineId' | 'readOwnership' | 'isMachineAlive'>,
): OwnershipResolution {
  try {
    const self = deps.selfMachineId();
    const rec = deps.readOwnership(sessionKey);
    if (!rec || !rec.owner) return { kind: 'unowned', owner: null, epoch: rec?.epoch ?? 0 };
    if (self && rec.owner === self) return { kind: 'self', owner: rec.owner, epoch: rec.epoch };
    let alive = false;
    try {
      alive = deps.isMachineAlive(rec.owner);
    } catch (err) {
      return {
        kind: 'error',
        owner: rec.owner,
        epoch: rec.epoch,
        error: `liveness-read-failed: ${(err as Error)?.message ?? String(err)}`,
      };
    }
    return { kind: alive ? 'other-alive' : 'other-dark', owner: rec.owner, epoch: rec.epoch };
  } catch (err) {
    return {
      kind: 'error',
      owner: null,
      epoch: 0,
      error: `registry-read-failed: ${(err as Error)?.message ?? String(err)}`,
    };
  }
}

interface ErrorEpisodeState {
  open: boolean;
  openedAt: number | null;
  episodeId: string | null;
  consecutiveErrors: number;
  consecutiveClean: number;
  /** Timestamps of recent errors for the windowed-rate trip. */
  recentErrorsAt: number[];
  /** Topics that already produced their once-per-episode journal row. */
  journaledTopics: Set<string>;
  /** Episode open-timestamps within the 24h window (HIGH escalation input). */
  episodeOpensAt: number[];
  /** Breaker open = arm (e) degrades to the rung-3 notice floor (enforce only). */
  breakerOpen: boolean;
}

export interface SpawnAdmissionStatus {
  mode: AdmissionMode;
  enforceBlockedBy: 'flag-disabled' | 'dry-run' | 'durable-custody-dark' | null;
  errorEpisode: {
    open: boolean;
    openedAt: string | null;
    episodeId: string | null;
    breakerOpen: boolean;
    consecutiveErrors: number;
    consecutiveClean: number;
    episodesIn24h: number;
  };
  counters: {
    admitted: number;
    wouldBlock: number;
    refused: number;
    errorArmSpawns: number;
    shortCircuits: number;
    routerVerdictsConsumed: number;
  };
}

export class SpawnAdmission {
  private readonly deps: SpawnAdmissionDeps;
  private flag: SpawnAdmissionFlag;
  private readonly nowFn: () => number;
  private episode: ErrorEpisodeState = {
    open: false,
    openedAt: null,
    episodeId: null,
    consecutiveErrors: 0,
    consecutiveClean: 0,
    recentErrorsAt: [],
    journaledTopics: new Set(),
    episodeOpensAt: [],
    breakerOpen: false,
  };
  private counters = {
    admitted: 0,
    wouldBlock: 0,
    refused: 0,
    errorArmSpawns: 0,
    shortCircuits: 0,
    routerVerdictsConsumed: 0,
  };

  constructor(flag: SpawnAdmissionFlag, deps: SpawnAdmissionDeps) {
    this.flag = flag;
    this.deps = deps;
    this.nowFn = deps.now ?? (() => Date.now());
  }

  /** Boot-read flag, but hot-updatable for tests and config reload paths. */
  setFlag(flag: SpawnAdmissionFlag): void {
    this.flag = flag;
  }

  /**
   * §3.1 item 6 (round-4 admission-table invariant): `enforce` REQUIRES durable
   * custody — with the inbound queue dark this seam cannot block a spawn
   * outside dryRun, so notice-only refusal can never be wired on the fleet by
   * accident.
   */
  effectiveMode(): AdmissionMode {
    if (!this.flag.enabled) return 'off';
    if (this.flag.dryRun) return 'dry-run';
    return this.deps.durableCustodyLive() ? 'enforce' : 'dry-run';
  }

  /**
   * The reconciler + closeout FREEZE while a registry-error episode is open
   * (§3.1 row e — same fault domain; the error arm must not be exploitable to
   * both mint and "heal" duplicates).
   */
  isErrorEpisodeOpen(): boolean {
    return this.episode.open;
  }

  admit(input: AdmitInput): AdmissionDecision {
    const mode = this.effectiveMode();

    // Row: single-machine / pool-dark / flag-off short-circuit — byte-identical,
    // zero writes (§3.1 item 5).
    if (mode === 'off' || this.deps.poolStage() === 'dark' || !this.deps.selfMachineId()) {
      this.counters.shortCircuits++;
      return {
        allow: true,
        mode,
        row: 'short-circuit',
        wouldBlock: false,
        reason: mode === 'off' ? 'flag-disabled' : 'single-machine-or-pool-dark',
      };
    }

    // TOCTOU guard (§3.1 item 2): consume the router's verdict for this message
    // instead of re-resolving. `queued`/`placement-blocked` suppress local spawn
    // INDEPENDENTLY of `acked` (§3.1 item 4).
    if (input.routerVerdict) {
      this.counters.routerVerdictsConsumed++;
      const action = input.routerVerdict.action;
      if (action === 'queued' || action === 'placement-blocked') {
        return this.decide(input, mode, {
          row: 'router-queued-suppress',
          refusalAction: 'rung3-notice',
          reason: `router-verdict=${action} (acked=${input.routerVerdict.acked}) suppresses local spawn independently of acked`,
          consumedRouterVerdict: action,
        });
      }
      // Any other consumed verdict fell through the handler by design
      // (handled-locally / spawned-self / rejected-already-returned) — allow.
      this.counters.admitted++;
      return {
        allow: true,
        mode,
        row: 'router-consumed',
        wouldBlock: false,
        reason: `router-verdict=${action} fell through to local dispatch by design`,
        consumedRouterVerdict: action,
      };
    }

    const ownership = resolveOwnershipSafe(input.sessionKey, this.deps);
    switch (ownership.kind) {
      case 'self':
        this.recordCleanResolution();
        this.counters.admitted++;
        return { allow: true, mode, row: 'self', wouldBlock: false, reason: 'this machine owns the conversation', ownership };
      case 'unowned':
        // Row (d): the router's placeAndClaim owns the claim; a seam-level spawn
        // on a genuinely unowned key is today's behavior (the claim result, when
        // one happened, arrives as a consumed router verdict above).
        this.recordCleanResolution();
        this.counters.admitted++;
        return { allow: true, mode, row: 'unowned', wouldBlock: false, reason: 'no ownership record — claim rides the router placeAndClaim path', ownership };
      case 'other-alive':
        this.recordCleanResolution();
        return this.decide(input, mode, {
          row: 'other-alive',
          refusalAction: 'forward',
          reason: `owner ${ownership.owner} is alive — forward, never a local spawn`,
          ownership,
        });
      case 'other-dark':
        this.recordCleanResolution();
        return this.decide(input, mode, {
          row: 'other-dark',
          refusalAction: 'owner-dark-ladder',
          reason: `owner ${ownership.owner} is dark — owner-dark ladder (§3.3), never a bootleg copy`,
          ownership,
        });
      case 'error':
        return this.admitErrorArm(input, mode, ownership);
    }
  }

  /** Shared dry-run/enforce decision shaping for the blocking rows. */
  private decide(
    input: AdmitInput,
    mode: AdmissionMode,
    d: { row: AdmissionRow; refusalAction: RefusalAction; reason: string; ownership?: OwnershipResolution; consumedRouterVerdict?: string },
  ): AdmissionDecision {
    const decision: AdmissionDecision =
      mode === 'enforce'
        ? {
            allow: false,
            mode,
            row: d.row,
            wouldBlock: true,
            refusalAction: d.refusalAction,
            reason: d.reason,
            ownership: d.ownership,
            consumedRouterVerdict: d.consumedRouterVerdict,
          }
        : {
            allow: true,
            mode,
            row: d.row,
            wouldBlock: true,
            reason: `[dry-run would-block] ${d.reason}`,
            ownership: d.ownership,
            consumedRouterVerdict: d.consumedRouterVerdict,
          };
    if (decision.allow) this.counters.wouldBlock++;
    else this.counters.refused++;
    this.journalDecision(input, decision);
    this.provenanceRow(input, decision);
    return decision;
  }

  /**
   * Row (e): reachability wins over a broken store — spawn locally, BOUNDED:
   * once-per-topic-per-episode journal row + ONE deduped attention item +
   * windowed breaker. Breaker-open degrades the arm to the rung-3 notice floor
   * (enforce mode only — dry-run always allows).
   */
  private admitErrorArm(input: AdmitInput, mode: AdmissionMode, ownership: OwnershipResolution): AdmissionDecision {
    const now = this.nowFn();
    this.episode.consecutiveErrors++;
    this.episode.consecutiveClean = 0;
    this.episode.recentErrorsAt.push(now);
    const windowFloor = now - ERROR_ARM_CONSTANTS.WINDOWED_TRIP_WINDOW_MS;
    this.episode.recentErrorsAt = this.episode.recentErrorsAt.filter((t) => t >= windowFloor);

    if (!this.episode.open) {
      this.openEpisode(now);
    }

    const tripped =
      this.episode.consecutiveErrors >= ERROR_ARM_CONSTANTS.CONSECUTIVE_TRIP ||
      this.episode.recentErrorsAt.length >= ERROR_ARM_CONSTANTS.WINDOWED_TRIP_COUNT;
    if (tripped && !this.episode.breakerOpen) {
      this.episode.breakerOpen = true;
      this.deps.log(
        `[SpawnAdmission] error-arm breaker OPEN (${this.episode.consecutiveErrors} consecutive / ${this.episode.recentErrorsAt.length} in window) — episode ${this.episode.episodeId}`,
      );
    }

    // Once-per-topic-per-episode journal row (§3.1 row e).
    if (!this.episode.journaledTopics.has(input.sessionKey)) {
      this.episode.journaledTopics.add(input.sessionKey);
      this.deps.journal({
        ts: new Date(now).toISOString(),
        kind: 'spawn-admission-error',
        episodeId: this.episode.episodeId,
        sessionKey: input.sessionKey,
        callsite: input.callsite,
        error: ownership.error ?? 'unknown',
        breakerOpen: this.episode.breakerOpen,
        mode,
      });
      this.raiseErrorEpisodeAttention(now);
    }

    // Breaker-open + enforce → degrade to the rung-3 notice floor. Dry-run and
    // pre-trip enforce keep failing toward the spawn (reachability wins).
    if (this.episode.breakerOpen && mode === 'enforce') {
      const decision: AdmissionDecision = {
        allow: false,
        mode,
        row: 'error',
        wouldBlock: true,
        refusalAction: 'rung3-notice',
        reason: 'registry-error breaker open — degraded to rung-3 notice floor until the episode closes',
        ownership,
      };
      this.counters.refused++;
      this.provenanceRow(input, decision);
      return decision;
    }

    this.counters.errorArmSpawns++;
    const decision: AdmissionDecision = {
      allow: true,
      mode,
      row: 'error',
      wouldBlock: this.episode.breakerOpen,
      reason: `ownership resolution failed (${ownership.error ?? 'unknown'}) — reachability wins over a broken store, bounded + loud`,
      ownership,
    };
    this.provenanceRow(input, decision);
    return decision;
  }

  private openEpisode(now: number): void {
    const winFloor = now - ERROR_ARM_CONSTANTS.EPISODES_WINDOW_MS;
    this.episode.episodeOpensAt = this.episode.episodeOpensAt.filter((t) => t >= winFloor);
    this.episode.episodeOpensAt.push(now);
    this.episode.open = true;
    this.episode.openedAt = now;
    this.episode.episodeId = `err-${now.toString(36)}`;
    this.episode.journaledTopics = new Set();
    this.deps.log(`[SpawnAdmission] registry-error episode OPEN (${this.episode.episodeId})`);
  }

  /** Hysteresis: an episode closes only after J consecutive clean resolutions. */
  private recordCleanResolution(): void {
    if (!this.episode.open) return;
    this.episode.consecutiveErrors = 0;
    this.episode.consecutiveClean++;
    if (this.episode.consecutiveClean >= ERROR_ARM_CONSTANTS.HYSTERESIS_CLEAN_CLOSES) {
      this.deps.log(
        `[SpawnAdmission] registry-error episode CLOSED after ${this.episode.consecutiveClean} clean resolutions (${this.episode.episodeId})`,
      );
      this.episode.open = false;
      this.episode.openedAt = null;
      this.episode.episodeId = null;
      this.episode.breakerOpen = false;
      this.episode.consecutiveClean = 0;
      this.episode.recentErrorsAt = [];
      this.episode.journaledTopics = new Set();
    }
  }

  /** FD11 wording; dedupe key `spawn-admission-error:<machineId>:<episode>`. */
  private raiseErrorEpisodeAttention(now: number): void {
    const machine = this.deps.selfMachineId() ?? 'this machine';
    const winFloor = now - ERROR_ARM_CONSTANTS.EPISODES_WINDOW_MS;
    const episodesIn24h = this.episode.episodeOpensAt.filter((t) => t >= winFloor).length;
    const priority = episodesIn24h >= ERROR_ARM_CONSTANTS.EPISODES_HIGH_THRESHOLD ? 'high' : 'medium';
    const errCount = this.episode.recentErrorsAt.length;
    try {
      this.deps.raiseAttention({
        id: `spawn-admission-error:${machine}:${this.episode.episodeId}`,
        title: 'Conversation-ownership records unreadable — duplicates possible',
        body:
          `I couldn't read conversation-ownership records on ${machine} ` +
          `(${errCount} failures in ${Math.round(ERROR_ARM_CONSTANTS.WINDOWED_TRIP_WINDOW_MS / 60000)} min), ` +
          `so new conversations there are answered locally and duplicates are possible until this clears. ` +
          `Details: logs/owner-dark-ladder.jsonl (episode ${this.episode.episodeId}).`,
        priority,
      });
    } catch (err) {
      this.deps.log(`[SpawnAdmission] attention raise failed (non-fatal): ${(err as Error)?.message ?? err}`);
    }
  }

  private journalDecision(input: AdmitInput, decision: AdmissionDecision): void {
    try {
      this.deps.journal({
        ts: new Date(this.nowFn()).toISOString(),
        kind: 'spawn-admission-decision',
        sessionKey: input.sessionKey,
        callsite: input.callsite,
        row: decision.row,
        mode: decision.mode,
        allow: decision.allow,
        wouldBlock: decision.wouldBlock,
        refusalAction: decision.refusalAction ?? null,
        owner: decision.ownership?.owner ?? null,
        consumedRouterVerdict: decision.consumedRouterVerdict ?? null,
      });
    } catch {
      /* @silent-fallback-ok: the journal is observability — a write failure must never affect admission. */
    }
  }

  /** Deterministic-verdict provenance rows from the seam (§3.5, Increment 1). */
  private provenanceRow(input: AdmitInput, decision: AdmissionDecision): void {
    if (!this.deps.provenance) return;
    try {
      this.deps.provenance({
        component: 'SpawnAdmission',
        decisionPoint: 'may-this-machine-spawn-for-this-topic',
        context: {
          sessionKey: input.sessionKey,
          callsite: input.callsite,
          ownershipKind: decision.ownership?.kind ?? null,
          owner: decision.ownership?.owner ?? null,
          consumedRouterVerdict: decision.consumedRouterVerdict ?? null,
          mode: decision.mode,
        },
        optionsPresented: ['spawn', 'forward', 'owner-dark-ladder', 'rung3-notice'],
        decision: decision.allow ? 'spawn' : (decision.refusalAction as string),
        reason: decision.reason,
        floor: 'admission-table-a-e (deterministic; invariant row — never delegated)',
        fallbackRung: 'deterministic',
      });
    } catch {
      /* @silent-fallback-ok: provenance is observability — a write failure must never affect admission. */
    }
  }

  status(): SpawnAdmissionStatus {
    const now = this.nowFn();
    const winFloor = now - ERROR_ARM_CONSTANTS.EPISODES_WINDOW_MS;
    const mode = this.effectiveMode();
    return {
      mode,
      enforceBlockedBy: !this.flag.enabled
        ? 'flag-disabled'
        : this.flag.dryRun
          ? 'dry-run'
          : this.deps.durableCustodyLive()
            ? null
            : 'durable-custody-dark',
      errorEpisode: {
        open: this.episode.open,
        openedAt: this.episode.openedAt ? new Date(this.episode.openedAt).toISOString() : null,
        episodeId: this.episode.episodeId,
        breakerOpen: this.episode.breakerOpen,
        consecutiveErrors: this.episode.consecutiveErrors,
        consecutiveClean: this.episode.consecutiveClean,
        episodesIn24h: this.episode.episodeOpensAt.filter((t) => t >= winFloor).length,
      },
      counters: { ...this.counters },
    };
  }
}
