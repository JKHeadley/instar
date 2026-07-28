/**
 * MachineCoherenceSentinel — the machine-coherence guard's evaluator core
 * (machine-coherence-guard §3.3/§3.4; roadmap 4.1, F4/P0-1).
 *
 * A pure-core, tick-driven, signal-only sentinel in the `checkPoolFlagCoherence`
 * shape: it compares, across every ONLINE machine in the pool, the §3.2 advert
 * dimensions (version / resolved flags / protocol / manifest generation) and —
 * when the pool diverges — will raise ONE deduped, episode-scoped attention item
 * from exactly ONE elected machine. It never blocks, equalizes, or restarts
 * anything.
 *
 * INCREMENT STATUS (C₁ is landing in sub-units — see the side-effects artifact):
 *   - LANDED here: config resolution (spec §7 keys, code-side defaults,
 *     `enabled` OMITTED from ConfigDefaults → resolveDevAgentGate, the #1001
 *     anti-mechanism), the tick loop's early no-op gates (single-machine strict
 *     no-op BEFORE any state is touched), the per-tick peer-classification pass
 *     (composing the pure C₀ helpers), the §3.4 election over live candidates,
 *     the M11 comparison-universe honesty accounting, and the §6 status
 *     snapshot shape.
 *   - NOT YET here (Session B): dimension comparison + confirmation counters
 *     (R2-L3 consecutive rule, M6 update-wave suppression, N8 warm-up
 *     accounting beyond the tick gate), the §4 episode state machine + the ONE
 *     attention item + §4.2.1 fix flow, the alarm-marker attach into
 *     refreshPool's advert, jsonl transitions, and the status route.
 *
 * Fail toward silence (§3.3): any evaluator error → no emit this tick, an
 * error counter on the status snapshot. A guard that can flood on its own
 * malfunction re-creates the disease it treats.
 *
 * Supervision tier (N6): Tier 0 — fully deterministic; no LLM call anywhere.
 * Signal-vs-authority: PURE SIGNAL (dev-gated dark; dry-run first even on dev).
 */

import type { MachineCapacity } from '../core/types.js';
import { resolveDevAgentGate } from '../core/devAgentGate.js';
import { getByPath } from '../core/machineCoherenceManifest.js';
import {
  classifyPeer,
  computeDivergentRows,
  electRaiser,
  type ClassifiedPeer,
  type SkewRow,
  type SkewDimension,
} from './machineCoherenceEvaluate.js';
import { MachineCoherenceEpisodeManager, type EpisodeEffect } from './machineCoherenceEpisodeManager.js';

/** Per-row confirmation state (machine-coherence-guard §3.3, R2-L3). */
interface RowConfirmState {
  dimension: SkewDimension;
  row: SkewRow;
  /** Consecutive ticks the row's identity has been present (R2-L3 — a
   *  participant dropping out changes/vanishes the identity → resets to 1). */
  consecutiveTicks: number;
  /** Wall-clock ms of first (re)appearance — the patch-only version grace clock. */
  firstSeenAtMs: number;
  confirmed: boolean;
}

/** Resolved config (spec §7 — every knob carries its shipped default in code). */
export interface MachineCoherenceResolvedConfig {
  enabled: boolean;
  dryRun: boolean;
  flagConfirmTicks: number;
  versionSkewGraceMs: number;
  resolveTicks: number;
  escalateAfterMs: number;
  advertStaleMs: number;
  warmupTicks: number;
  reopenWindowMs: number;
  maxEpisodeItemsPerDay: number;
  suspendedEpisodeExpiryMs: number;
  raiserTakeoverTicks: number;
  flappingLatchReopens: number;
  episodeAppendBudget: number;
  episodeAppendWindowMs: number;
  fixVerifyTicks: number;
  /**
   * calm-transient-episode-alerting: the MASTER gate for the calm narration set
   * (M-P0 anchors, M-P1 progress-aware confirmation, M-P2 calm/silent/derived
   * narration, wave backstop). Rides resolveDevAgentGate — LIVE on a development
   * agent, DARK on the fleet; dark ⇒ bit-identical to legacy behavior including
   * zero durable-file changes. Explicit `monitoring.machineCoherence.calmEnabled`
   * always wins.
   */
  calmEnabled: boolean;
  /** M-P1 rollback lever: false ⇒ confirm at grace exactly as today. */
  progressExtensionEnabled: boolean;
  /** Flap-brake rollback lever. */
  flapBrakeEnabled: boolean;
  versionSkewProgressWindowMs: number;
  versionSkewStallCeilingMs: number;
  /** Clamped to the priority enum at resolution. */
  patchSkewPriority: 'NORMAL' | 'HIGH';
  /** false ⇒ today's notifying resolve note (rollback lever). */
  silentResolveNote: boolean;
  /** true ⇒ calm raises buzz (rollback lever; silent is the standard-mandated default). */
  calmRaiseNotify: boolean;
  calmWaveBackstopEnabled: boolean;
  calmWaveThreshold: number;
  skewFlapThreshold: number;
}

/**
 * Resolve the guard's config from the full agent config object. `enabled` is
 * DELIBERATELY absent from ConfigDefaults — resolveDevAgentGate decides (LIVE
 * on a development agent, DARK on the fleet; an explicit value always wins —
 * the #1001 anti-mechanism). `dryRun` defaults TRUE even on dev (dry-run
 * FIRST: evaluator runs, counters record would-raise, NO item).
 */
export function resolveMachineCoherenceConfig(config: Record<string, unknown>): MachineCoherenceResolvedConfig {
  const block = (getByPath(config, 'monitoring.machineCoherence') ?? {}) as Record<string, unknown>;
  const num = (key: string, fallback: number): number => {
    const v = block[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  return {
    enabled: resolveDevAgentGate(
      typeof block.enabled === 'boolean' ? block.enabled : undefined,
      config as { developmentAgent?: boolean },
    ),
    dryRun: typeof block.dryRun === 'boolean' ? block.dryRun : true,
    flagConfirmTicks: num('flagConfirmTicks', 2),
    versionSkewGraceMs: num('versionSkewGraceMs', 2_700_000), // 45 min
    resolveTicks: num('resolveTicks', 3),
    escalateAfterMs: num('escalateAfterMs', 86_400_000), // 24 h
    advertStaleMs: num('advertStaleMs', 300_000), // 5 min (M5)
    warmupTicks: num('warmupTicks', 4), // N8
    reopenWindowMs: num('reopenWindowMs', 3_600_000), // 60 min (M2)
    maxEpisodeItemsPerDay: num('maxEpisodeItemsPerDay', 3), // M2
    suspendedEpisodeExpiryMs: num('suspendedEpisodeExpiryMs', 604_800_000), // 7 d (M1)
    raiserTakeoverTicks: num('raiserTakeoverTicks', 10), // C1/R2-M1
    flappingLatchReopens: num('flappingLatchReopens', 3), // R2-N4
    episodeAppendBudget: num('episodeAppendBudget', 6), // R3-M5
    episodeAppendWindowMs: num('episodeAppendWindowMs', 21_600_000), // 6 h (R3-M5)
    fixVerifyTicks: num('fixVerifyTicks', 10), // R2-M3-v
    // ── calm-transient-episode-alerting (all engage only under calmEnabled) ──
    calmEnabled: resolveDevAgentGate(
      typeof block.calmEnabled === 'boolean' ? block.calmEnabled : undefined,
      config as { developmentAgent?: boolean },
    ),
    progressExtensionEnabled: typeof block.progressExtensionEnabled === 'boolean' ? block.progressExtensionEnabled : true,
    flapBrakeEnabled: typeof block.flapBrakeEnabled === 'boolean' ? block.flapBrakeEnabled : true,
    versionSkewProgressWindowMs: numClamped('versionSkewProgressWindowMs', 1_800_000), // 30 min
    versionSkewStallCeilingMs: numClamped('versionSkewStallCeilingMs', 10_800_000), // 3 h
    patchSkewPriority: block.patchSkewPriority === 'HIGH' ? 'HIGH' : 'NORMAL', // enum-clamped
    silentResolveNote: typeof block.silentResolveNote === 'boolean' ? block.silentResolveNote : true,
    calmRaiseNotify: typeof block.calmRaiseNotify === 'boolean' ? block.calmRaiseNotify : false,
    calmWaveBackstopEnabled: typeof block.calmWaveBackstopEnabled === 'boolean' ? block.calmWaveBackstopEnabled : true,
    calmWaveThreshold: numClamped('calmWaveThreshold', 6),
    skewFlapThreshold: numClamped('skewFlapThreshold', 3),
  };

  /** Calibration keys clamp zero/invalid to defaults — no zero-sentinel magic
   *  meanings (rollback is the explicit booleans, never a magic 0). */
  function numClamped(key: string, fallback: number): number {
    const v = block[key];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
  }
}

/**
 * Boot-time config-sanity warning (calm-alerting M-P1 invariant): the progress
 * window MUST exceed the restart-cascade dampener window with margin — the
 * dampener deliberately delays a laggard's restart, and a smaller window would
 * read deliberate batching as a stall. Warn-only (the multiMachine
 * config-validation pattern); returns the message for testability.
 */
export function checkCalmAlertingConfigSanity(config: Record<string, unknown>, resolved: MachineCoherenceResolvedConfig): string | null {
  if (!resolved.calmEnabled || !resolved.progressExtensionEnabled) return null;
  const dampener = getByPath(config, 'updates.restartCascadeDampenerWindowMs');
  const dampenerMs = typeof dampener === 'number' && Number.isFinite(dampener) ? dampener : 900_000;
  if (resolved.versionSkewProgressWindowMs <= dampenerMs) {
    return `machine-coherence calm-alerting: versionSkewProgressWindowMs (${resolved.versionSkewProgressWindowMs}) must exceed updates.restartCascadeDampenerWindowMs (${dampenerMs}) with margin — deliberate restart batching would read as a stall. Raise the progress window or lower the dampener.`;
  }
  return null;
}

/** The guard's own posture, derived from resolved config (feeds candidacy). */
export function selfPostureOf(cfg: Pick<MachineCoherenceResolvedConfig, 'enabled' | 'dryRun'>): 'live' | 'dry-run' | 'dark' {
  return cfg.enabled ? (cfg.dryRun ? 'dry-run' : 'live') : 'dark';
}

export interface MachineCoherenceSentinelDeps {
  /** The pool view (self + peers) — `machinePoolRegistry.getCapacities()`. */
  listCapacities: () => MachineCapacity[];
  /** This machine's id (null before pool identity is established). */
  selfMachineId: () => string | null;
  /** The serving-lease holder's machine id, or null when unknown/none. */
  leaseHolderMachineId: () => string | null;
  /** Wall clock — injectable for tests. */
  now?: () => number;
  /** The per-agent state root (`<agent>/.instar`). When provided, the sentinel
   *  owns a durable EpisodeManager (§4 episode machinery); when absent (pure
   *  unit tests), the sentinel runs classification + confirmation only. */
  stateDir?: () => string | null;
  /** machineId → operator-facing nickname (registry display label). */
  nicknameOf?: (machineId: string) => string;
}

/** The §6 status snapshot (the future `GET /pool/machine-coherence` body core). */
export interface MachineCoherenceStatus {
  enabled: boolean;
  dryRun: boolean;
  lastTickAt: string | null;
  machinesRegisteredOnline: number;
  machinesCompared: number;
  peerClassifications: { compared: number; unknown: number; advertStale: number; advertRejected: number };
  raiser: { machineId: string | null; isSelf: boolean; candidates: string[] };
  /** The open episode (§4), or null when none / the durable machinery is unwired.
   *  `pendingFix` carries the §4.2.1 proposal awaiting operator approval (or null). */
  openEpisode: {
    episodeId: string; rows: number; suspended: boolean; itemRaisedAt: string | null;
    pendingFix: { state: import('./machineCoherenceEpisode.js').PendingFixState; key: string; targetMachineId: string; targetValue: string; proposalHash: string } | null;
  } | null;
  /** Episode lifecycle counters (§4.5) — present only when the machinery is wired. */
  episodeCounters?: import('./machineCoherenceEpisodeManager.js').EpisodeManagerCounters;
  /** calm-alerting observability (silent ≠ dead): progress extensions, ceiling
   *  confirms, flap fires, calm/silent raise + resolve counts, wave fires, and
   *  the fail-loud escalationRaiseFailed. Present when the machinery is wired. */
  calm?: {
    progressExtensions: number; ceilingConfirms: number; flapBrakeFires: number;
    calmRaises: number; calmRaisesSilent: number; silentResolves: number;
    resolveNotesSuppressed: number; waveBackstopFires: number; escalationRaiseFailed: number;
  };
  /**
   * `skewsConfirmed` is CUMULATIVE (a counter of confirmation transitions, not a
   * live gauge). `confirmedRows`/`pendingRows` are the live gauges — how many
   * distinct skew rows are currently confirmed vs still accruing consecutive
   * ticks. `errors` is fail-toward-silence tick errors.
   */
  counters: { ticks: number; skewsConfirmed: number; confirmedRows: number; pendingRows: number; errors: number };
}

export class MachineCoherenceSentinel {
  private lastTickAtMs = 0;
  private ticks = 0;
  private errors = 0;
  /** Post-boot warm-up accounting (N8): ticks completed since construction. */
  private ticksSinceBoot = 0;
  private lastClassified: ClassifiedPeer[] = [];
  /** calm-alerting M-P0 feed: this tick's post-M6 raw rows + raw versions. */
  private lastRawRows: SkewRow[] = [];
  private lastVersionsByMachine: Record<string, string> = {};
  private lastRegisteredOnline = 0;
  private lastRaiser: string | null = null;
  private lastCandidates: string[] = [];
  /** §3.3 confirmation engine: per-row consecutive-tick + grace-clock state. */
  private rowState = new Map<string, RowConfirmState>();
  /** The row identities present LAST tick (R2-L3 consecutive detection). */
  private lastTickRowIds = new Set<string>();
  /** Cumulative count of confirmation transitions (never decremented). */
  private skewsConfirmed = 0;
  /** The §4 episode machinery (constructed only when a stateDir is provided). */
  private episode?: MachineCoherenceEpisodeManager;
  /** Effects the last tick produced, awaiting execution by the caller (server). */
  private pendingEffects: EpisodeEffect[] = [];

  constructor(
    private readonly deps: MachineCoherenceSentinelDeps,
    private readonly cfg: MachineCoherenceResolvedConfig,
  ) {
    const dir = this.deps.stateDir?.() ?? null;
    if (dir) this.episode = new MachineCoherenceEpisodeManager(dir, cfg);
  }

  /**
   * Drain the effects the last reconcile produced (raise/append/resolve). The
   * caller (server) executes them against the telegram adapter, keeping the
   * sentinel Tier-0 and its tick synchronous. Empty on a dark/no-episode agent.
   */
  drainPendingEffects(): EpisodeEffect[] {
    const out = this.pendingEffects;
    this.pendingEffects = [];
    return out;
  }

  /** Passthrough for the conversational reply path (b3): the durable "leave it" ack. */
  setOperatorAck(ack: boolean): void {
    this.episode?.setOperatorAck(ack);
  }

  /**
   * Operator "fix it" approval passthrough (§4.2.1-i). The caller (conversational
   * reply path) has verified the sender is the topic's VERIFIED operator (Know
   * Your Principal) and passes `verifiedOperator`; `proposalHash` is the display-
   * integrity authority. Returns the transition + any effects (an `execute-fix`
   * for the divergent==raiser case) the caller executes immediately. A dark/
   * unwired guard is a no-op refusal.
   */
  approveFix(args: { proposalHash: string; verifiedOperator: boolean; now?: number }): { result: { ok: boolean; reason?: string; state?: string }; effects: EpisodeEffect[] } {
    if (!this.episode) return { result: { ok: false, reason: 'guard-not-active' }, effects: [] };
    return this.episode.approveFix({ proposalHash: args.proposalHash, verifiedOperator: args.verifiedOperator, now: args.now ?? (this.deps.now ?? Date.now)() });
  }

  /**
   * Whether this tick is still inside the N8 post-boot warm-up window:
   * `MachinePoolRegistry` is in-memory, so a local restart wipes every peer's
   * advert until the next 30s pull — for `warmupTicks` after boot,
   * `unknown`/`advert-stale` classifications must count toward NOTHING (no
   * confirmation progress, no version-class grace clock). The classification
   * itself still runs (the status snapshot stays honest); the CONSUMERS of
   * warm-up (confirmation counters, Session B) read this flag.
   */
  inWarmup(): boolean {
    return this.ticksSinceBoot < this.cfg.warmupTicks;
  }

  /**
   * One evaluator tick (rides the existing 30s peerPresenceTick — no timer of
   * its own). Runs only when the guard resolves live or dry-run; the caller
   * owns the gate (a dark guard never constructs/ticks the sentinel). Fails
   * toward silence: any error increments the error counter and emits nothing.
   */
  tick(): void {
    this.ticks += 1;
    this.ticksSinceBoot += 1;
    const nowMs = (this.deps.now ?? Date.now)();
    this.lastTickAtMs = nowMs;
    try {
      const self = this.deps.selfMachineId();
      const online = this.deps.listCapacities().filter((c) => c.online);
      this.lastRegisteredOnline = online.length;
      // Single-machine strict no-op (§3.3): the comparison set is {self} —
      // short-circuit at fewer than 2 members BEFORE any state is touched.
      if (online.length < 2 || self === null) {
        this.lastClassified = [];
        this.lastRaiser = null;
        this.lastCandidates = [];
        // Below 2 comparable members → no divergence is possible; the whole
        // confirmation engine resets (R2-L3: every row's participants dropped).
        this.rowState.clear();
        this.lastTickRowIds = new Set();
        return;
      }
      // Per-machine classification (M11 universe honesty: every ONLINE machine
      // is accounted — one that cannot be compared classifies `unknown`/
      // `advert-stale`/`advert-rejected`, surfaced, never silently coherent).
      this.lastClassified = online.map((c) => classifyPeer(c, nowMs, this.cfg.advertStaleMs));
      // §3.4 election: candidates are the machines whose guard posture reads
      // 'live'. Self's posture is known LOCALLY (resolved config — authoritative
      // over our own possibly-stale advert echo); peers' via their adverts.
      const selfLive = selfPostureOf(this.cfg) === 'live';
      const candidates = this.lastClassified
        .filter((p) => (p.machineId === self ? selfLive : p.advert?.guard === 'live'))
        .map((p) => p.machineId);
      this.lastCandidates = candidates;
      this.lastRaiser = electRaiser(candidates, this.deps.leaseHolderMachineId());
      // ── §3.3 dimension comparison + confirmation counters (R2-L3, M6) ──
      this.updateConfirmation(nowMs);
      // ── §4 episode reconcile (when the durable machinery is wired) ──
      if (this.episode && !this.inWarmup()) {
        const online = new Set(this.lastClassified.map((p) => p.machineId));
        const compared = new Set(this.lastClassified.filter((p) => p.cls === 'compared').map((p) => p.machineId));
        const nick = this.deps.nicknameOf ?? ((m: string) => m);
        const effects = this.episode.reconcile({
          confirmedRows: this.confirmedSkewRows(),
          comparedMachineIds: compared,
          onlineMachineIds: online,
          selfMachineId: self,
          raiserMachineId: this.lastRaiser,
          leaseHolderMachineId: this.deps.leaseHolderMachineId(),
          nicknameOf: nick,
          now: nowMs,
          // calm-alerting M-P0 feed (consumed only under cfg.calmEnabled)
          rawRows: this.lastRawRows,
          versionsByMachine: this.lastVersionsByMachine,
          tickMs: 30_000,
        });
        const expiries = this.episode.expireIfStale(nowMs, nick);
        this.pendingEffects.push(...effects, ...expiries);
      }
    } catch {
      // Fail toward silence (§3.3): no emit, a visible error counter. The
      // confirmation state is LEFT INTACT on an error tick (a transient pool-read
      // fault must not fabricate a participant-drop reset); the next clean tick
      // recomputes over fresh data.
      this.errors += 1;
    }
  }

  /**
   * §3.3 confirmation engine (R2-L3 consecutive rule + M6 update-wave
   * suppression). Runs over the CURRENTLY-`compared` machines (self included —
   * self records its own advert every beat), turns the raw per-tick divergences
   * into confirmed rows, and never raises anything (the episode/alarm machinery
   * is Session B). Pure state transitions; the caller owns fail-toward-silence.
   *
   * The consecutive rule (R2-L3): a row's confirmation counts ONLY ticks in which
   * the row's identity (which encodes every participant's clamped value) is
   * present. Because a participant dropping out (offline / unknown / advert-stale)
   * either vanishes the identity or changes it, the old identity leaves
   * `currentIds`, its counter is dropped, and a re-appearance starts fresh at 1 —
   * one flapping reading can never accumulate toward confirmation.
   *
   * M6 update-wave suppression: FLAG rows are suppressed while ANY version skew
   * exists among the compared machines (a differing version OR an open patch-only
   * grace window — an update that changes a flag's resolved default would else
   * alarm HIGH mid-wave and auto-resolve). Once every version agrees, residual
   * flag skew confirms normally.
   */
  private updateConfirmation(nowMs: number): void {
    const compared = this.lastClassified
      .filter((p): p is ClassifiedPeer & { advert: NonNullable<ClassifiedPeer['advert']> } => p.cls === 'compared' && !!p.advert)
      .map((p) => ({ machineId: p.machineId, advert: p.advert }));

    let rows = computeDivergentRows(compared);
    // M6: suppress FLAG rows while a version skew (differing version or open
    // grace) is present among the compared machines.
    const hasVersionSkew = new Set(compared.map((c) => c.advert.instarVersion)).size > 1;
    if (hasVersionSkew) rows = rows.filter((r) => r.dimension !== 'flag');

    // calm-alerting M-P0 feed: the POST-suppression raw rows + per-machine raw
    // versions ride into the episode manager's anchor reconcile this tick.
    this.lastRawRows = rows;
    this.lastVersionsByMachine = Object.fromEntries(compared.map((c) => [c.machineId, c.advert.instarVersion]));

    const currentIds = new Set(rows.map((r) => r.identity));

    // Increment consecutive counters for rows present this tick; a row whose
    // identity was NOT present last tick (re)starts at 1 with a fresh grace clock.
    for (const r of rows) {
      const existing = this.rowState.get(r.identity);
      if (existing && this.lastTickRowIds.has(r.identity)) {
        existing.consecutiveTicks += 1;
        existing.row = r; // refresh the row snapshot (nicknames etc. are not in the identity)
      } else {
        this.rowState.set(r.identity, { dimension: r.dimension, row: r, consecutiveTicks: 1, firstSeenAtMs: nowMs, confirmed: false });
      }
    }
    // Drop rows that vanished this tick (R2-L3 reset — a participant left the set,
    // the pair equalized, or M6 suppressed a flag row): their counter is gone.
    for (const id of [...this.rowState.keys()]) {
      if (!currentIds.has(id)) this.rowState.delete(id);
    }

    // Confirmation predicate per dimension.
    for (const st of this.rowState.values()) {
      if (st.confirmed) continue;
      let doConfirm: boolean;
      if (st.dimension === 'version' && st.row.versionSeverity === 'patch-only') {
        // Patch-only version skew. Legacy: versionSkewGraceMs of CONTINUOUS row
        // age. Calm-alerting M-P1: the decision reads the identity-independent
        // durable anchor (activeSkewMs grace / gap-narrowing progress extension /
        // unresettable stall ceiling); 'no-anchor' falls back to the legacy path
        // (fail toward today's behavior).
        if (this.cfg.calmEnabled && this.episode) {
          const d = this.episode.decidePatchSkewConfirmation(st.row.key, nowMs, this.lastVersionsByMachine);
          if (d.reason === 'extend') this.episode.countersCalm.progressExtensions += 1;
          doConfirm = d.reason === 'no-anchor'
            ? nowMs - st.firstSeenAtMs >= this.cfg.versionSkewGraceMs
            : d.confirm;
        } else {
          doConfirm = nowMs - st.firstSeenAtMs >= this.cfg.versionSkewGraceMs;
        }
      } else {
        // flag / major-minor version / manifest-class / protocol: N consecutive ticks.
        doConfirm = st.consecutiveTicks >= this.cfg.flagConfirmTicks;
      }
      if (doConfirm) {
        st.confirmed = true;
        this.skewsConfirmed += 1;
        // calm-alerting flap accounting: a confirm transition arms the key's
        // pending flap marker; a later GENUINE convergence completes the cycle.
        if (this.cfg.calmEnabled) this.episode?.noteConfirmTransition(st.dimension, st.row.key);
      }
    }

    this.lastTickRowIds = currentIds;
  }

  /** The currently-confirmed skew rows (C₁b-ii — Session B's episode machinery
   *  consumes these; the status route exposes their count). Pure read. */
  confirmedSkewRows(): SkewRow[] {
    return [...this.rowState.values()].filter((s) => s.confirmed).map((s) => s.row);
  }

  /** The rows still accruing consecutive ticks (divergent, not yet confirmed). */
  pendingSkewRows(): SkewRow[] {
    return [...this.rowState.values()].filter((s) => !s.confirmed).map((s) => s.row);
  }

  /**
   * The GuardRegistry runtime getter (GUARD-POSTURE-ENDPOINT-SPEC §2.1): a
   * synchronous in-memory read the /guards endpoint snapshots per request.
   * `expectRuntime:true` on the GUARD_MANIFEST entry requires the C₁b server-boot
   * wiring to register THIS at boot. `enabled`/`dryRun` come from the resolved
   * config; `lastTickAt` drives the on-stale grading (a constructed-but-never-
   * ticking guard reads stale, never "on"). Pure — never mutates.
   */
  guardStatus(): { enabled: boolean; dryRun: boolean; lastTickAt: number } {
    return { enabled: this.cfg.enabled, dryRun: this.cfg.dryRun, lastTickAt: this.lastTickAtMs };
  }

  /** The §6 status snapshot (pure read — never mutates). */
  status(): MachineCoherenceStatus {
    const counts = { compared: 0, unknown: 0, advertStale: 0, advertRejected: 0 };
    for (const p of this.lastClassified) {
      if (p.cls === 'compared') counts.compared += 1;
      else if (p.cls === 'unknown') counts.unknown += 1;
      else if (p.cls === 'advert-stale') counts.advertStale += 1;
      else counts.advertRejected += 1;
    }
    const self = this.deps.selfMachineId();
    // Self is always comparable (§3.3): a below-2 pool reports compared=1.
    const machinesCompared = this.lastClassified.length === 0 ? (self !== null ? 1 : 0) : counts.compared;
    return {
      enabled: this.cfg.enabled,
      dryRun: this.cfg.dryRun,
      lastTickAt: this.lastTickAtMs ? new Date(this.lastTickAtMs).toISOString() : null,
      machinesRegisteredOnline: this.lastRegisteredOnline,
      machinesCompared,
      peerClassifications: counts,
      raiser: {
        machineId: this.lastRaiser,
        isSelf: this.lastRaiser !== null && this.lastRaiser === self,
        candidates: [...this.lastCandidates],
      },
      openEpisode: this.episode?.status().openEpisode ?? null,
      episodeCounters: this.episode?.status().counters,
      calm: this.episode ? { ...this.episode.countersCalm } : undefined,
      counters: {
        ticks: this.ticks,
        skewsConfirmed: this.skewsConfirmed,
        confirmedRows: this.confirmedSkewRows().length,
        pendingRows: this.pendingSkewRows().length,
        errors: this.errors,
      },
    };
  }
}
