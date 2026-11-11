/* @self-action-controller: context-budget-quarantine-reconcile */
/* Also: context-budget-orphan-carrier-clear (hold health) and context-budget-layer-rebuild-request (freshness), both in SELF_ACTION_CONTROLLERS. */
/**
 * The ContextBudgetSentinel — Phase 0 core
 * (context-budget-layered-summaries §7.8, §9.3 "Quarantine", §16 Phase 0
 * "the sentinel skeleton (… boot sweep, quarantine reconciliation)").
 *
 * One server-side watcher per machine. Each tick (default 5 minutes), in this
 * order:
 *  1. QUARANTINE RECONCILIATION — every `quarantined` fold record this machine
 *     owns runs step 8 through a pool-shared, async `SelfHealGate` ladder (one
 *     episode per fold). Within the reconciliation bound (default 15 minutes,
 *     measured from the quarantine) it asks the rollback runner (Phase 2;
 *     absent ⇒ unavailable). Past the bound it FORCE-ENDS the candidate and,
 *     on a later tick, VERIFIES termination (no tmux session it ended is
 *     alive, no live session on the topic, and no transcript it recorded grew
 *     since the force-end). Only then does it move the record to
 *     `rolled-back` (`rollback-degraded`), which releases the holds and every
 *     carrier, and raise ONE notice. If termination cannot be verified —
 *     including a transcript it cannot read — containment STAYS: the record
 *     stays `quarantined`, and the ladder's exhaustion escalates through the
 *     Attention queue with the topic named. Nothing is released on an unknown.
 *  2. TORN RECORDS — a fold record file that exists but cannot be read is an
 *     unknown: the boot sweep keeps its carriers, and the owner's sentinel
 *     raises one Attention item naming the topic.
 *  3. CHECKPOINT GRACE PASS — `pruneSettledCheckpoints` deletes rolled-back
 *     folds' engine checkpoints after their 24 h grace.
 *  3b. OUTBOX and CANARY — pending notices are sent; the standing compaction
 *     canary (§9.1, `compactionCanary.ts`) scans the topic sessions' transcripts;
 *     with compaction recovery on, the heal ladder by cause (`canaryHealLadder.ts`)
 *     acts on its settled divergences and the synthetic press (`syntheticPress.ts`)
 *     earns its positive control on a throwaway session.
 *  3c. THE §17 ROWS (Phase 1):
 *     - LAYER FRESHNESS (§6, Defaults "Layer freshness target"): each live topic
 *       session's H1 against TopicMemory. Over target on a topic this machine
 *       owns ⇒ a bounded rebuild REQUEST through the `requestRebuild` seam (the
 *       sentinel never writes a layer); unknown ⇒ counted, no action; stale
 *       past `LAYER_STALE_SUSTAINED_MS` after a request ⇒ ONE notice per
 *       episode (durable). H3 reads `unavailable: h3-not-built`. Deliberate
 *       deviation from §7.8 "each ladder is a SelfHealGate declaration": the
 *       rebuild request is a bounded ASK, not a heal ladder, so its brakes are
 *       its own durable per-episode counters (registry controller
 *       context-budget-layer-rebuild-request).
 *     - HOLD HEALTH (§10, §17 "hold or marker outliving its record"): a fold hold
 *       or marker whose record is absent or terminal, older than the grace
 *       period, is cleared LOUDLY (degradation row + status) through its own
 *       pool-shared SelfHealGate ladder; the record is re-read immediately
 *       before the release. A live or torn record, an unknown age, or an
 *       unattributable file ⇒ never cleared here.
 *     - ELIGIBLE WITHOUT A FOLD (§9.3, §7.8): observation only. Without the
 *       §7.2 benefit estimator a live topic with no fold for a day reads
 *       `unknown: no-benefit-estimator`, counted, never acted on.
 *  4. GATE PRUNE — after the attempts (the gate's idle rule assumes the caller
 *     attempts before it prunes, and ticks well inside the ladder's wall clock).
 *  5. HEARTBEAT — the fold coordinator's `sentinelHeartbeatFresh` precondition
 *     reads it: no live sentinel, no fold.
 *
 * Non-owner sentinels observe only (the gate refuses before touching
 * anything). Never: writes A, G, U, C or H3; authors a handoff; sends to the
 * user (its notices go to the Attention queue); replaces a context except
 * through the fold's own rollback path.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SelfHealGate, SqliteSelfHealEpisodeStore, type SelfHealEpisodeStore, type SelfHealGateDeps, type SelfHealNotice, type SelfHealRemediationResult, type SelfHealSpec } from '../core/SelfHealGate.js';
import { TERMINAL_STATES, type FoldCoordinator, type FoldRecord, type FoldRecordStore } from './FoldCoordinator.js';
import { MALFORMED_HOLD_FOLD } from './FoldHoldStore.js';
import { TORN_MARKER_KEY } from './foldMarker.js';
import { H1_TARGET_USER_TURNS } from './contextLayers/layerProjection.js';
import { pruneSettledCheckpoints } from './engineCheckpoint.js';
import type { CanaryReport, CanarySession, CompactionCanary } from './compactionCanary.js';
import type { CanaryHealLadder, CanaryHealStatus } from './canaryHealLadder.js';
import type { PressTickOutcome, SyntheticPress } from './syntheticPress.js';
import { readSuiteResults, adapterSuiteDir, type AdapterSuiteResult } from './adapterVerificationSuite.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { topicRef } from '../messaging/shared/topicRef.js';

export const CONTEXT_BUDGET_SENTINEL_TICK_MS = 5 * 60_000;
export const QUARANTINE_RECONCILE_BOUND_MS = 15 * 60_000;
export const QUARANTINE_LADDER_ID = 'context-budget-quarantine-reconcile';
export const ORPHAN_LADDER_ID = 'context-budget-orphan-carrier-clear';
/** A hold or marker younger than this is never cleared (the write-before-record window, a restamp, replication lag). */
export const ORPHAN_GRACE_MS = 15 * 60_000;
/** Rebuild requests per stale episode, and their spacing (the seam's own brake). */
export const LAYER_REBUILD_MAX_PER_EPISODE = 3;
export const LAYER_REBUILD_SPACING_MS = 30 * 60_000;
/** Stale this long after a rebuild request ⇒ one notice for the episode. */
export const LAYER_STALE_SUSTAINED_MS = 60 * 60_000;
/** A topic with no fold for this long is an "eligible without a fold" candidate (§7.8 "for a day"). */
export const NO_FOLD_WINDOW_MS = 24 * 60 * 60_000;
/** Per-topic detail rows in the status, per row kind (counts stay exact). */
export const STATUS_ROW_LIMIT = 50;

/** What the rebuild seam did with a request (counted; the sentinel never writes a layer). */
export type LayerRebuildOutcome = 'reprojected' | 'awareness-behind' | 'no-awareness' | 'failed' | 'unavailable';

/** The layer-freshness row's source: the layers (§9.7) read against TopicMemory. */
export interface LayerFreshnessSource {
  /** H1's freshness for a topic (`contextLayers.h1Freshness`); null or a throw reads `unknown`. */
  h1(topicKey: string): { line: string; stale: boolean | 'unknown'; userTurnsBehind?: number | null } | null;
  /** Ask the layer's own writer to rebuild (a later slice serves more of it). Absent ⇒ `unavailable`, counted. */
  requestRebuild?(topicKey: string): LayerRebuildOutcome | Promise<LayerRebuildOutcome>;
}

/** One hold or marker on disk, with when it was written (null: unknown, never cleared). */
export interface HoldCarrierEntry { topicKey: string; foldId: string; writtenAt: number | null }
/** A fold hold or fold-marker carrier the hold-health row watches. */
export interface HoldCarrierSource { kind: 'fold-hold' | 'fold-marker'; list(): HoldCarrierEntry[]; release(topicKey: string, foldId: string): void }

export interface DegradationRow { feature: string; primary: string; fallback: string; reason: string; impact: string }

export type RollbackOutcome = 'rolled-back' | 'failed' | 'unavailable';

/** A live process that may be the fold's candidate (a topic session). */
export interface FoldCandidate { tmuxSession: string; transcriptPath: string | null }

export interface AttentionNotice { id: string; title: string; summary: string; priority: 'NORMAL' | 'HIGH' | 'URGENT' }

export interface ContextBudgetSentinelDeps {
  stateDir: string;
  machineId: string;
  coordinator: FoldCoordinator;
  store: FoldRecordStore;
  /** Does this machine own the fold (the coordinator's own rule: topic owner, or its own record on a single machine)? */
  ownsFold(rec: FoldRecord): boolean | 'unknown';
  /** Does this machine own the topic (for torn-record escalation)? */
  ownsTopic(topicKey: string): boolean | 'unknown';
  /** Step 8's rollback runner (Phase 2). Absent ⇒ every quarantine waits for the bound. */
  rollback?(rec: FoldRecord): Promise<RollbackOutcome>;
  /** The topic's live sessions (the fold's possible candidates). */
  candidates(topicKey: string): FoldCandidate[];
  /** Is the tmux session alive? `'unknown'` when the probe failed or timed out — never read as gone. */
  tmuxAlive(tmuxSession: string): boolean | 'unknown';
  kill(tmuxSession: string): void | Promise<void>;
  /** A file's size, or null when it cannot be read. */
  fileBytes(p: string): number | null;
  attention(n: AttentionNotice): void | Promise<void>;
  admit: SelfHealGateDeps['admit'];
  consumeToken: SelfHealGateDeps['consumeToken'];
  audit?: (event: { event: string; reason?: string; topicKey?: string; foldId?: string }) => void;
  episodeStore?: SelfHealEpisodeStore;
  now?: () => number;
  tickMs?: number;
  reconcileBoundMs?: number;
  bootId?: string;
  /**
   * The standing compaction canary (§9.1): observation only. Each tick scans the
   * topic sessions' transcripts; its report rides the sentinel's status.
   */
  canary?: { instance: CompactionCanary; sessions(): CanarySession[]; switchOn(): boolean };
  /**
   * The canary's heal ladder by cause (§9.1, `canaryHealLadder.ts`) and its
   * positive control, the synthetic press on a throwaway session
   * (`syntheticPress.ts`). Each runs after the canary scan, ONLY while the
   * canary's switch (compaction recovery) is on; absent ⇒ observation only.
   */
  heal?: CanaryHealLadder;
  press?: SyntheticPress;
  /**
   * The adapter verification suite's trigger (§9.6: "triggers: adapter build and
   * any change of the retained engine binary version"): when the engine version
   * has no recorded result, run the suite once (in its own process), at most once
   * per version per `retryAfterMs` (default 24 h), one run at a time.
   */
  adapterSuite?: { currentVersion(): string | null; run(): Promise<void>; retryAfterMs?: number };
  /** Topics with a live session on this machine (the freshness and eligible-without-fold population). Absent ⇒ both rows read `unavailable`. */
  liveTopics?(): string[];
  /** The layer store's freshness (§6). Absent (layers off) ⇒ the freshness row reads `unavailable: layers-off`. */
  layers?: LayerFreshnessSource | null;
  /**
   * Hold health (§10, §17): the hold and marker carriers, the orphan ladder's own
   * governor admission (its token is minted for ORPHAN_LADDER_ID), and the
   * degradation sink that makes every clear loud. Absent ⇒ the row reads `unavailable`.
   */
  holdHealth?: { carriers: HoldCarrierSource[]; admit: SelfHealGateDeps['admit']; degradation(r: DegradationRow): void; graceMs?: number };
  /**
   * The Codex adapter's suite trigger (§9.6 Codex column, Phase 1 S17): the same
   * rule for the retained Codex binary. One suite run at a time across engines
   * (the cost bound is one throwaway session per run).
   */
  codexAdapterSuite?: { currentVersion(): string | null; run(): Promise<void>; retryAfterMs?: number };
}

const SUITE_RETRY_MS = 24 * 60 * 60_000;
/** Attempts per engine version before the trigger gives up (the status shows it). */
const SUITE_MAX_ATTEMPTS = 3;

type Ctx = { topicKey: string; foldId: string };
type OrphanCtx = { kind: HoldCarrierSource['kind']; topicKey: string; foldId: string };

/** A stale-layer episode for one topic (durable, so a restart cannot re-notify). */
interface StaleEpisode {
  since: number; lastSeenAt: number; requests: number; lastRequestAt: number | null; lastOutcome: LayerRebuildOutcome | null; notified: boolean;
  /** The first request the seam could ACT on (`reprojected` or `failed`); null while every answer was "nothing to rebuild from". */
  firstActionableAt: number | null;
}
const REBUILD_OUTCOMES: ReadonlySet<string> = new Set(['reprojected', 'awareness-behind', 'no-awareness', 'failed', 'unavailable']);
/** Only a well-formed entry is an episode; anything else is dropped (a corrupt file must never fail the tick and darken the heartbeat). */
function validEpisode(v: unknown): v is StaleEpisode {
  const e = v as StaleEpisode;
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  return !!e && typeof e === 'object' && num(e.since) && num(e.lastSeenAt) && Number.isInteger(e.requests) && e.requests >= 0
    && (e.lastRequestAt === null || num(e.lastRequestAt)) && (e.lastOutcome === null || REBUILD_OUTCOMES.has(e.lastOutcome as string))
    && typeof e.notified === 'boolean' && (e.firstActionableAt === null || e.firstActionableAt === undefined || num(e.firstActionableAt));
}

export interface FreshnessRow {
  topicKey: string;
  owned: boolean | 'unknown';
  h1: { stale: boolean | 'unknown'; line: string; userTurnsBehind: number | null };
  h3: { state: 'unavailable'; reason: 'h3-not-built' };
  staleSince: number | null;
  rebuildRequests: number;
  lastRebuild: LayerRebuildOutcome | null;
  notified: boolean;
}

export type OrphanVerdict = 'cleared' | 'pending' | 'in-grace' | 'observe-only' | 'unknown';
export interface OrphanRow { kind: HoldCarrierSource['kind']; topicKey: string; foldId: string; ageMs: number | null; verdict: OrphanVerdict; reason: string }

/** What a force-end left behind for the termination check. */
interface TerminationSnapshot { topicKey: string; at: number; tmux: string[]; transcripts: Array<{ path: string | null; bytes: number | null }> }

/** A notice that must survive a down Attention channel and a restart; sent once its condition holds. */
interface OutboxEntry { notice: AttentionNotice; whenRolledBack?: { topicKey: string; foldId: string } }

/** Bound on any one tick step, so a hung dependency cannot wedge the sentinel. */
const STEP_TIMEOUT_MS = 2 * 60_000;

export interface SentinelStatus {
  lastTickAt: number | null;
  heartbeatFresh: boolean;
  quarantined: Array<{ topicKey: string; foldId: string; ageMs: number; owned: boolean | 'unknown'; lastOutcome: string | null }>;
  torn: Array<{ topicKey: string; foldId: string }>;
  checkpointsPruned: number;
  lastError: string | null;
  /** The compaction canary's report (null when no canary is wired). */
  canary: CanaryReport | null;
  /** The heal ladder's recent decisions and breaker (null when not wired). */
  heal: CanaryHealStatus | null;
  /** The synthetic press's last outcome (null when not wired). */
  press: { last: { at: number; outcome: PressTickOutcome } | null } | null;
  /** The adapter verification suite's recorded results on this machine, newest first, and whether a run is in progress. */
  adapterSuite: {
    running: boolean; results: AdapterSuiteResult[]; attempts: Record<string, { count: number; lastAt: number }>; gaveUp: string[];
    /** The engine version the trigger sees now (null: unknown — a wrong binary path or a failed probe). */
    engineVersion: string | null;
    /** The latest attempt's outcome (`last-run.json`), including an inconclusive run's errors. */
    lastRun: Record<string, unknown> | null;
    /** The Codex adapter's suite trigger (S17): its engine version and latest attempt. */
    codex: { wired: boolean; engineVersion: string | null; lastRun: Record<string, unknown> | null };
  };
  /**
   * §17 "stale layers": H1 against TopicMemory for every live topic session (H3 not built yet).
   * In all three rows `checkedAt` is the tick that produced the row (null: none yet), and the
   * running totals (`rebuildRequests`, `notices`, `clearedTotal`) count since this process started.
   */
  layerFreshness:
    | { state: 'unavailable'; reason: 'layers-off' | 'no-session-source' }
    | { state: 'ok'; checkedAt: number | null; counts: { topics: number; fresh: number; stale: number; unknown: number; observedOnly: number; rebuildRequests: number; notices: number }; topics: FreshnessRow[]; truncated: number };
  /** §17 "hold or marker outliving its record". */
  holdHealth:
    | { state: 'unavailable'; reason: 'no-carriers' }
    | { state: 'ok'; checkedAt: number | null; graceMs: number; counts: { carriers: number; live: number; orphans: number; cleared: number; pending: number; inGrace: number; observedOnly: number; unknown: number; clearedTotal: number }; orphans: OrphanRow[]; recentClears: Array<{ kind: string; topicKey: string; foldId: string; at: number }>; truncated: number };
  /** §17 "eligible topic without a fold": observation only; `unknown` until the §7.2 benefit estimator exists. */
  eligibleWithoutFold:
    | { state: 'unavailable'; reason: 'no-session-source' }
    | { state: 'ok'; checkedAt: number | null; counts: { topics: number; unknown: number; foldedRecently: number }; topics: Array<{ topicKey: string; verdict: 'unknown' | 'folded-recently'; reason: string; lastFoldAt: number | null }>; truncated: number };
}

function keyHash(value: string): string { return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24); }

export class ContextBudgetSentinel {
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly boundMs: number;
  private readonly gate: SelfHealGate<Ctx>;
  private readonly lastOutcome = new Map<string, string>();
  private readonly noticeTopics = new Map<string, Ctx>();
  private lastTickAt: number | null = null;
  private lastError: string | null = null;
  private lastTorn: Array<{ topicKey: string; foldId: string }> = [];
  private checkpointsPruned = 0;
  private ticking = false;
  private readonly orphanGate: SelfHealGate<OrphanCtx> | null = null;
  private readonly orphanNoticeTopics = new Map<string, OrphanCtx>();
  private lastFreshness: Extract<SentinelStatus['layerFreshness'], { state: 'ok' }> | null = null;
  private lastHolds: Extract<SentinelStatus['holdHealth'], { state: 'ok' }> | null = null;
  private lastEligible: Extract<SentinelStatus['eligibleWithoutFold'], { state: 'ok' }> | null = null;
  private rebuildRequestsTotal = 0;
  private staleNoticesTotal = 0;
  private clearedTotal = 0;
  private readonly recentClears: Array<{ kind: string; topicKey: string; foldId: string; at: number }> = [];

  constructor(private readonly d: ContextBudgetSentinelDeps) {
    this.now = d.now ?? Date.now;
    this.tickMs = d.tickMs ?? CONTEXT_BUDGET_SENTINEL_TICK_MS;
    this.boundMs = d.reconcileBoundMs ?? QUARANTINE_RECONCILE_BOUND_MS;
    // The gate's idle-prune rule needs the tick well inside the ladder's wall clock.
    const wallClock = this.boundMs * 3;
    if (!(this.tickMs > 0) || this.tickMs * 2 > wallClock) throw new Error('ContextBudgetSentinel: tick interval must be under half the ladder wall clock');
    const store = d.episodeStore ?? new SqliteSelfHealEpisodeStore(path.join(d.stateDir, 'state', 'context-budget', 'self-heal-episodes.db'), {
      // Four episodes per topic+cause (§9.4); per-incident keys end in `-<foldId>`.
      ring: { groupOf: (k) => k.slice(0, k.lastIndexOf('-')), perGroup: 4 },
    });
    const spec: SelfHealSpec<Ctx> = {
      id: QUARANTINE_LADDER_ID, controllerResource: 'pool-shared', episodeAuthority: 'durable-machine-local', classId: 'context-budget-quarantine',
      severity: () => 'recoverable',
      dedupeKey: (c) => `${this.machineSlug()}-${c.topicKey}-quarantine-${c.foldId}`.slice(0, 120),
      eligible: (c) => {
        const r = d.store.get(c.topicKey, c.foldId);
        return r && r.state === 'quarantined' ? { eligible: true, fence: `${r.foldId}:${r.seq}:${r.generation}` } : { eligible: false, fence: null };
      },
      isOwner: (c) => { const r = d.store.get(c.topicKey, c.foldId); return r ? d.ownsFold(r) : false; },
      remediationMode: 'async',
      remediationAsync: (c) => this.reconcileOnce(c),
      maxRemediationMs: 2 * 60_000,
      maxAttempts: 12,
      maxWallClockMs: wallClock,
      backoffMs: () => 0, // paced by the tick
      // Above the bound plus two ticks: a quarantine waiting its bound is expected, not slow.
      notificationLatencyCeilingMs: this.boundMs + 2 * this.tickMs,
      flap: { maxRecoveries: 3, windowMs: 24 * 60 * 60_000 },
      remediationActions: { operation: 'rollback-or-force-end-and-verify', idempotencyGuard: 'fold record CAS on (state, seq, generation)', compensation: 'containment stays on any unknown' },
    };
    this.gate = new SelfHealGate(spec, {
      admit: d.admit, consumeToken: d.consumeToken, episodeStore: store, now: this.now, bootId: d.bootId,
      notify: (n) => this.onGateNotice(n),
      audit: (e) => d.audit?.({ event: `gate:${e.event}`, ...(e.reason ? { reason: e.reason } : {}) }),
    });
    if (d.holdHealth) this.orphanGate = this.buildOrphanGate(store, d.holdHealth);
  }

  /**
   * The orphan-carrier ladder (§10 hold-store health, §17): one pool-shared
   * episode per (carrier kind, topic, fold), in the sentinel's own episode
   * store. Eligibility RE-READS the record and re-lists the carrier, and the
   * fence binds the exact file generation, so a hold whose fold came back to
   * life (or was rewritten) between the decision and the release is refused.
   */
  private buildOrphanGate(store: SelfHealEpisodeStore, h: NonNullable<ContextBudgetSentinelDeps['holdHealth']>): SelfHealGate<OrphanCtx> {
    const wallClock = Math.max(6 * this.tickMs, 30 * 60_000);
    const spec: SelfHealSpec<OrphanCtx> = {
      id: ORPHAN_LADDER_ID, controllerResource: 'pool-shared', episodeAuthority: 'durable-machine-local', classId: 'context-budget-orphan-carrier',
      severity: () => 'recoverable',
      dedupeKey: (c) => this.orphanKey(c),
      eligible: (c) => { const e = this.orphanEvidence(c); return e.verdict === 'pending' ? { eligible: true, fence: e.fence } : { eligible: false, fence: null }; },
      isOwner: (c) => this.d.ownsTopic(c.topicKey),
      remediation: (c) => this.clearOrphan(c),
      maxAttempts: 3,
      maxWallClockMs: wallClock,
      backoffMs: () => 0, // paced by the tick
      notificationLatencyCeilingMs: wallClock, // exhaustion is the one notice; a slow clear is not paged separately
      flap: { maxRecoveries: 3, windowMs: 24 * 60 * 60_000 },
      // An entry that could not be cleared pages once and is not retried for a week (the boot sweep still releases it at a restart).
      exhaustedRetentionMs: 7 * 24 * 60 * 60_000,
      remediationActions: { operation: 'release-orphan-hold-or-marker', idempotencyGuard: 'record re-read + carrier re-list + file-generation fence immediately before the release', compensation: 'none needed: a released orphan guarded nothing; a live or torn record is never released' },
    };
    return new SelfHealGate(spec, {
      admit: h.admit, consumeToken: this.d.consumeToken, episodeStore: store, now: this.now, bootId: this.d.bootId,
      notify: (n) => this.onOrphanGateNotice(n),
      audit: (e) => this.d.audit?.({ event: `orphan-gate:${e.event}`, ...(e.reason ? { reason: e.reason } : {}) }),
    });
  }

  private machineSlug(): string {
    const s = this.d.machineId.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, '');
    return (s || 'm').slice(0, 40);
  }

  /** The fold precondition: a sentinel that ticked within two intervals. */
  heartbeatFresh(): boolean {
    return this.lastTickAt !== null && this.now() - this.lastTickAt <= 2 * this.tickMs;
  }

  /** One tick. Never throws; overlapping calls are skipped. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    this.lastError = null;
    let clean = true;
    try {
      clean = await this.step('quarantine', () => this.reconcileQuarantines()) && clean;
      clean = await this.step('torn', () => this.escalateTorn()) && clean;
      clean = await this.step('outbox', () => this.flushOutbox()) && clean;
      if (this.d.canary) {
        const k = this.d.canary;
        clean = await this.step('canary', () => k.instance.scan(k.sessions(), k.switchOn())) && clean;
        // Heal and press act only with compaction recovery on (§9.1: off ⇒ today's behaviour, nothing acts).
        let on = false;
        try { on = k.switchOn() === true; } catch { on = false; } // @silent-fallback-ok — an unreadable switch acts on nothing
        if (on && this.d.heal) { const h = this.d.heal; clean = await this.step('heal', () => h.tick()) && clean; }
        if (on && this.d.press) { const pr = this.d.press; clean = await this.step('press', () => pr.tick()) && clean; }
      }
      if (this.d.adapterSuite) clean = await this.step('adapter-suite', () => this.maybeRunAdapterSuite('claude-code')) && clean;
      if (this.d.codexAdapterSuite) clean = await this.step('adapter-suite-codex', () => this.maybeRunAdapterSuite('codex-cli')) && clean;
      if (this.d.layers && this.d.liveTopics) clean = await this.step('layer-freshness', () => this.checkFreshness()) && clean;
      if (this.d.holdHealth) clean = await this.step('hold-health', () => this.checkHolds()) && clean;
      if (this.d.liveTopics) clean = await this.step('eligible-without-fold', () => this.observeEligible()) && clean;
      clean = await this.step('checkpoints', () => { this.checkpointsPruned += pruneSettledCheckpoints(this.d.stateDir, this.now()).length; }) && clean;
      clean = await this.step('prune', () => { this.gate.pruneTerminal(); this.orphanGate?.pruneTerminal(); this.d.heal?.prune(); this.d.press?.prune(); }) && clean;
      // The heartbeat means a WORKING sentinel: a tick with a failed step does not refresh it.
      if (clean) this.lastTickAt = this.now();
    } finally {
      this.ticking = false;
    }
  }

  private async step(name: string, fn: () => unknown): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${STEP_TIMEOUT_MS} ms`)), STEP_TIMEOUT_MS); timer.unref?.(); }),
      ]);
      return true;
    } catch (err) { // @silent-fallback-ok — not silent: recorded as lastError (in the status), audited, and the tick is unclean so the heartbeat goes stale (no fold can begin)
      this.lastError = `${name}: ${err instanceof Error ? err.message : String(err)}`;
      this.d.audit?.({ event: 'step-failed', reason: this.lastError });
      return false;
    } finally { if (timer) clearTimeout(timer); }
  }

  private quarantinedRecords(): FoldRecord[] {
    const out: FoldRecord[] = [];
    for (const t of this.d.store.topics()) for (const r of this.d.store.list(t)) if (r.state === 'quarantined') out.push(r);
    return out;
  }

  private async reconcileQuarantines(): Promise<void> {
    const live = new Set<string>();
    let stateFailure: string | null = null;
    this.noticeTopics.clear();
    for (const r of this.quarantinedRecords()) {
      const ctx = { topicKey: r.topicKey, foldId: r.foldId };
      live.add(r.foldId);
      this.noticeTopics.set(keyHash(`${QUARANTINE_LADDER_ID}:${`${this.machineSlug()}-${r.topicKey}-quarantine-${r.foldId}`.slice(0, 120)}`), ctx);
      const res = await this.gate.attempt(ctx);
      this.lastOutcome.set(r.foldId, `${res.outcome}:${res.reason}`);
      if (res.outcome === 'state-failure') stateFailure = res.reason;
    }
    // Drop a snapshot only on a KNOWN end: the record is absent, or readable and no
    // longer quarantined. A torn record or a failed listing keeps it (never forget
    // evidence on an unknown).
    for (const k of this.listSnapshots()) {
      if (live.has(k)) continue;
      const snap = this.readSnapshot(k);
      if (!snap) continue;
      const seen = this.d.store.inspect(snap.topicKey, k);
      if (seen.kind === 'absent' || (seen.kind === 'ok' && seen.record.state !== 'quarantined')) this.dropSnapshot(k);
    }
    for (const k of [...this.lastOutcome.keys()]) if (!live.has(k)) this.lastOutcome.delete(k);
    // A sentinel that cannot record its own ladder is not a working sentinel (no heartbeat).
    if (stateFailure) throw new Error(`episode store: ${stateFailure}`);
  }

  /** Step 8 for one quarantined fold: rollback within the bound; past it, force-end, verify, then rollback-degraded. */
  private async reconcileOnce(c: Ctx): Promise<SelfHealRemediationResult> {
    const rec = this.d.store.get(c.topicKey, c.foldId);
    if (!rec || rec.state !== 'quarantined') return { outcome: 'healed', evidence: 'already-healthy' };
    const age = this.now() - rec.updatedAt; // quarantined → rolled-back is the only edge, so updatedAt is the quarantine time
    if (!(age >= this.boundMs)) { // a missing or bad timestamp waits, never ends a session early
      if (!this.d.rollback) return { outcome: 'not-healed', evidence: 'source-absent' };
      const r = await this.d.rollback(rec);
      const after = this.d.store.get(c.topicKey, c.foldId);
      return r === 'rolled-back' && after?.state === 'rolled-back' ? { outcome: 'healed', evidence: 'repaired' } : { outcome: 'not-healed', evidence: 'verification-failed' };
    }
    // Past the bound: force-end the candidate, then verify termination on a LATER tick.
    // The snapshot is DURABLE and only ever GROWS (every session and transcript seen
    // across attempts and restarts), so an unreadable transcript is never forgotten
    // and a re-force-end can never verify vacuously.
    const prev = this.readSnapshot(c.foldId);
    if (prev && this.terminated(c.topicKey, prev)) {
      // fall through to the rollback-degraded transition below
    } else {
      const cands = this.d.candidates(c.topicKey);
      const tmux = [...new Set([...(prev?.tmux ?? []), ...cands.map((k) => k.tmuxSession)])];
      for (const t of tmux) {
        if (this.d.tmuxAlive(t) === false) continue;
        try { await this.d.kill(t); } catch (err) {
          // e.g. a protected session: it stays alive, so termination is not verified and the ladder escalates.
          this.d.audit?.({ event: 'kill-refused', reason: err instanceof Error ? err.message : String(err), topicKey: c.topicKey, foldId: c.foldId });
        }
      }
      const paths = new Map<string, string | null>();
      for (const t of prev?.transcripts ?? []) paths.set(t.path ?? `null:${paths.size}`, t.path);
      for (const k of cands) paths.set(k.transcriptPath ?? `null:${paths.size}`, k.transcriptPath);
      this.writeSnapshot(c.foldId, {
        topicKey: c.topicKey, at: this.now(), tmux,
        transcripts: [...paths.values()].map((p) => ({ path: p, bytes: p ? this.d.fileBytes(p) : null })),
      });
      this.d.audit?.({ event: prev ? 'force-end-repeated' : 'force-ended', topicKey: c.topicKey, foldId: c.foldId });
      return { outcome: 'not-healed', evidence: 'verification-failed' }; // verified no sooner than one tick later
    }
    // The notice is written DURABLY before the transition and sent only once the
    // record is rolled back, so a down Attention channel or a crash cannot lose it.
    this.enqueue({
      notice: {
        id: `context-budget-rollback-degraded-${c.topicKey}-${c.foldId}`,
        title: `A context fold on ${topicRef(c.topicKey)} was rolled back the slow way`,
        summary: `Fold ${c.foldId} could not finish or roll back within its time limit, so its session was ended and the conversation was released. Its earlier context may need restoring by hand.`,
        priority: 'HIGH',
      },
      whenRolledBack: { topicKey: c.topicKey, foldId: c.foldId },
    });
    const t = this.d.coordinator.transition(c.topicKey, c.foldId, { state: rec.state, seq: rec.seq, generation: rec.generation }, 'rolled-back', {
      reason: 'rollback-degraded: reconciliation bound passed; the candidate was force-ended and its termination verified',
    });
    if (!t.ok) return { outcome: 'not-healed', evidence: 'fence-stale' };
    this.dropSnapshot(c.foldId);
    await this.flushOutbox();
    return { outcome: 'healed', evidence: 'repaired' };
  }

  /** Verified termination: nothing it ended is alive, no live session on the topic, and no transcript grew (or is unreadable). */
  private terminated(topicKey: string, snap: TerminationSnapshot): boolean {
    if (this.now() - snap.at < this.tickMs) return false; // at least one tick of quiet
    // Nothing was ever seen to end (e.g. the candidate died with a crash and left no
    // session): there is no evidence of termination, so containment stays.
    if (snap.tmux.length === 0 && snap.transcripts.length === 0) return false;
    if (snap.tmux.some((t) => this.d.tmuxAlive(t) !== false)) return false; // alive OR unknown
    if (this.d.candidates(topicKey).some((k) => this.d.tmuxAlive(k.tmuxSession) !== false)) return false;
    for (const t of snap.transcripts) {
      if (t.path === null || t.bytes === null) return false; // no evidence of quiet is not quiet
      if (this.d.fileBytes(t.path) !== t.bytes) return false;
    }
    return true;
  }

  private suiteRunning = false;

  /** Start the suite (not awaited) when this engine version has no recorded result and no recent attempt. */
  private maybeRunAdapterSuite(engine: 'claude-code' | 'codex-cli'): void {
    const k = engine === 'codex-cli' ? this.d.codexAdapterSuite! : this.d.adapterSuite!;
    if (this.suiteRunning) return;
    const v = k.currentVersion();
    if (!v) return;
    if (readSuiteResults(this.d.stateDir).some((r) => (r.engine ?? 'claude-code') === engine && r.version === v)) return;
    // Attempts are keyed per engine (Claude Code keeps the bare version, as recorded before).
    const version = engine === 'codex-cli' ? `codex-cli@${v}` : v;
    const f = path.join(adapterSuiteDir(this.d.stateDir), 'attempts.json');
    let attempts: Record<string, { count: number; lastAt: number }> = {};
    try { attempts = JSON.parse(fs.readFileSync(f, 'utf-8')) as typeof attempts; } catch { attempts = {}; } // @silent-fallback-ok — no attempts yet
    const prev = attempts[version];
    if (prev && (prev.count >= SUITE_MAX_ATTEMPTS || this.now() - prev.lastAt < (k.retryAfterMs ?? SUITE_RETRY_MS))) return;
    // Recorded BEFORE the run, so a crash mid-run still counts as the attempt (bounded retries).
    attempts[version] = { count: (prev?.count ?? 0) + 1, lastAt: this.now() };
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(attempts), { mode: 0o600 }); fs.renameSync(tmp, f);
    this.suiteRunning = true;
    this.d.audit?.({ event: 'adapter-suite-started', reason: version });
    void k.run().catch((err) => this.d.audit?.({ event: 'adapter-suite-failed', reason: err instanceof Error ? err.message : String(err) }))
      .finally(() => { this.suiteRunning = false; });
  }

  private snapshotDir(): string { return path.join(this.d.stateDir, 'state', 'context-budget', 'termination'); }
  private readSnapshot(foldId: string): TerminationSnapshot | null {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(this.snapshotDir(), `${foldId}.json`), 'utf-8')) as TerminationSnapshot;
      return v && typeof v.topicKey === 'string' && typeof v.at === 'number' && Array.isArray(v.tmux) && Array.isArray(v.transcripts) ? v : null;
    } catch { return null; } // @silent-fallback-ok — no snapshot yet: the next attempt force-ends and records one
  }
  private writeSnapshot(foldId: string, snap: TerminationSnapshot): void {
    const dir = this.snapshotDir(); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const f = path.join(dir, `${foldId}.json`); const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snap), { mode: 0o600 }); fs.renameSync(tmp, f);
  }
  private listSnapshots(): string[] {
    try { return fs.readdirSync(this.snapshotDir()).filter((f) => /^[A-Za-z0-9_-]+\.json$/.test(f)).map((f) => f.slice(0, -5)); } catch { return []; } // @silent-fallback-ok — no directory means no snapshots
  }
  private dropSnapshot(foldId: string): void {
    const f = path.join(this.snapshotDir(), `${foldId}.json`);
    if (fs.existsSync(f)) SafeFsExecutor.safeRmSync(f, { force: true, operation: 'src/monitoring/ContextBudgetSentinel.ts:dropSnapshot' });
  }

  private outboxFile(): string { return path.join(this.d.stateDir, 'state', 'context-budget', 'outbox.json'); }
  private readOutbox(): Record<string, OutboxEntry> {
    try { const v = JSON.parse(fs.readFileSync(this.outboxFile(), 'utf-8')); return v && typeof v === 'object' ? v as Record<string, OutboxEntry> : {}; } catch { return {}; } // @silent-fallback-ok — no outbox yet
  }
  private writeOutbox(o: Record<string, OutboxEntry>): void {
    const f = this.outboxFile(); fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(o), { mode: 0o600 }); fs.renameSync(tmp, f);
  }
  private enqueue(e: OutboxEntry): void { const o = this.readOutbox(); if (!o[e.notice.id]) { o[e.notice.id] = e; this.writeOutbox(o); } }

  /** Send every pending notice whose condition holds; keep the rest (and any that fail) for the next tick. */
  private async flushOutbox(): Promise<void> {
    const o = this.readOutbox();
    const done: string[] = [];
    for (const [id, e] of Object.entries(o)) {
      if (e.whenRolledBack) {
        const seen = this.d.store.inspect(e.whenRolledBack.topicKey, e.whenRolledBack.foldId);
        if (seen.kind === 'torn' || (seen.kind === 'ok' && seen.record.state === 'quarantined')) continue; // not yet (or unknown): keep
        // Only a fold THIS path rolled back the slow way gets the notice; any other end drops it.
        if (!(seen.kind === 'ok' && seen.record.state === 'rolled-back' && (seen.record.reason ?? '').startsWith('rollback-degraded'))) { done.push(id); continue; }
      }
      try { await this.d.attention(e.notice); done.push(id); } catch (err) {
        this.d.audit?.({ event: 'notice-pending', reason: err instanceof Error ? err.message : String(err) });
      }
    }
    // Re-read before writing: an entry queued meanwhile (e.g. by a step still running after its timeout) survives.
    if (done.length) { const fresh = this.readOutbox(); for (const id of done) delete fresh[id]; this.writeOutbox(fresh); }
  }

  private onGateNotice(n: SelfHealNotice): Promise<void> | void {
    const m = /^self-heal:([0-9a-f]{24}):/.exec(n.id);
    const ctx = m ? this.noticeTopics.get(m[1]) : undefined;
    const where = ctx ? `${topicRef(ctx.topicKey)} (fold ${ctx.foldId})` : 'a topic on this machine';
    const exhausted = ['max-attempts', 'wall-clock', 'flap', 'state-failure'].includes(n.reason);
    return this.d.attention({
      id: `context-budget-quarantine-${ctx ? `${ctx.topicKey}-${ctx.foldId}` : n.id.replace(/[^A-Za-z0-9_-]/g, '-')}-${n.reason}`,
      title: n.reason === 'state-failure' ? `The context fold watcher on this machine could not record its work${ctx ? ` (${where})` : ''}`
        : exhausted ? `A stuck context fold on ${where} needs you` : `A context fold on ${where} is slow to recover`,
      summary: exhausted
        ? 'Its session could not be confirmed as stopped, so the conversation stays paused rather than risk replies from the wrong state. Check the session for that topic.'
        : 'Its recovery is taking longer than expected; the conversation stays paused until it finishes.',
      priority: exhausted ? 'URGENT' : 'HIGH',
    });
  }

  private raisedTornFile(): string { return path.join(this.d.stateDir, 'state', 'context-budget', 'torn-raised.json'); }
  private readRaisedTorn(): Set<string> {
    try { const v = JSON.parse(fs.readFileSync(this.raisedTornFile(), 'utf-8')); return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []); } catch { return new Set(); } // @silent-fallback-ok — no file yet means nothing raised
  }

  /** One Attention item per torn record this machine owns, raised once (durably). */
  private async escalateTorn(): Promise<void> {
    const torn: Array<{ topicKey: string; foldId: string }> = [];
    for (const t of this.d.store.topics()) for (const f of this.d.store.tornRecords(t)) torn.push({ topicKey: t, foldId: f });
    this.lastTorn = torn;
    const raised = this.readRaisedTorn();
    let changed = false;
    for (const x of torn) {
      const k = `${x.topicKey}/${x.foldId}`;
      if (raised.has(k) || this.d.ownsTopic(x.topicKey) !== true) continue;
      this.enqueue({ notice: {
        id: `context-budget-torn-record-${x.topicKey}-${x.foldId}`,
        title: `A context fold record on ${topicRef(x.topicKey)} is unreadable`,
        summary: `The record for fold ${x.foldId} is damaged, so the conversation's pause and its saved copy are kept in place rather than released on a guess. It needs a look before that conversation can continue normally.`,
        priority: 'URGENT',
      } });
      raised.add(k); changed = true;
    }
    // Forget entries whose record became readable or vanished, so a recurrence raises again.
    const live = new Set(torn.map((x) => `${x.topicKey}/${x.foldId}`));
    for (const k of [...raised]) if (!live.has(k)) { raised.delete(k); changed = true; }
    if (changed) {
      const f = this.raisedTornFile();
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...raised]), { mode: 0o600 });
      fs.renameSync(tmp, f);
    }
  }

  // ── §17 rows: layer freshness, hold health, eligible without a fold ──────

  private liveTopicList(): string[] {
    const raw = this.d.liveTopics!();
    return [...new Set((Array.isArray(raw) ? raw : []).filter((t): t is string => typeof t === 'string' && t.length > 0))].sort();
  }

  private owns(topicKey: string): boolean | 'unknown' {
    try { return this.d.ownsTopic(topicKey); } catch { return 'unknown'; } // @silent-fallback-ok — an owner check that throws is not ownership: observe only
  }

  private episodesFile(): string { return path.join(this.d.stateDir, 'state', 'context-budget', 'layer-stale-episodes.json'); }
  private readEpisodes(): Record<string, StaleEpisode> {
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(this.episodesFile(), 'utf-8')); } catch (err) {
      // No file yet is the normal start. An unreadable one restarts the episodes (their budget
      // and notice) once per corruption — audited, never a failed tick.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.d.audit?.({ event: 'layer-episodes-unreadable', reason: err instanceof Error ? err.message : String(err) });
      return {}; // @silent-fallback-ok — not silent when it matters: a corrupt file is audited above
    }
    const out: Record<string, StaleEpisode> = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (validEpisode(v)) out[k] = { ...v, firstActionableAt: v.firstActionableAt ?? null };
        else this.d.audit?.({ event: 'layer-episode-dropped', reason: 'malformed entry', topicKey: k });
      }
    }
    return out;
  }
  private writeEpisodes(e: Record<string, StaleEpisode>): void {
    const f = this.episodesFile(); fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(e), { mode: 0o600 }); fs.renameSync(tmp, f);
  }

  /**
   * Layer freshness (§6, §17 "Layer freshness"): H1 for each live topic session.
   * Over target on an OWNED topic ⇒ a rebuild request through the seam (at
   * most LAYER_REBUILD_MAX_PER_EPISODE per episode, LAYER_REBUILD_SPACING_MS
   * apart). The notice is raised ONLY when the seam could act and it did not
   * help: LAYER_STALE_SUSTAINED_MS after the first request answered
   * `reprojected` or `failed`, on a later tick, and not on a tick whose request
   * just re-projected. "Nothing to rebuild from" (`awareness-behind`, e.g. a run
   * of acknowledgements the extractor rightly left alone; `no-awareness`;
   * `unavailable`) is counted on the row and never pages. ONE notice per
   * durable episode. Unknown ⇒ counted, no action.
   */
  private async checkFreshness(): Promise<void> {
    const layers = this.d.layers!;
    const now = this.now();
    const eps = this.readEpisodes();
    let changed = false;
    const rows: FreshnessRow[] = [];
    const counts = { topics: 0, fresh: 0, stale: 0, unknown: 0, observedOnly: 0, rebuildRequests: this.rebuildRequestsTotal, notices: this.staleNoticesTotal };
    let noticed = false;
    for (const t of this.liveTopicList()) {
      counts.topics++;
      const owned = this.owns(t);
      let f: ReturnType<LayerFreshnessSource['h1']> = null;
      try { f = layers.h1(t); } catch { f = null; } // @silent-fallback-ok — not silent: an unreadable stamp is the row's `unknown`, counted below
      const stale: boolean | 'unknown' = f && (f.stale === true || f.stale === false) ? f.stale : 'unknown';
      if (stale === 'unknown') counts.unknown++; else if (stale) counts.stale++; else counts.fresh++;
      if (owned !== true) counts.observedOnly++;
      let ep: StaleEpisode | undefined = eps[t];
      if (stale === true) {
        if (!ep) ep = { since: now, lastSeenAt: now, requests: 0, lastRequestAt: null, lastOutcome: null, notified: false, firstActionableAt: null };
        ep.lastSeenAt = now;
        if (owned === true) {
          let thisTick: LayerRebuildOutcome | null = null;
          if (ep.requests < LAYER_REBUILD_MAX_PER_EPISODE && (ep.lastRequestAt === null || now - ep.lastRequestAt >= LAYER_REBUILD_SPACING_MS)) {
            let outcome: LayerRebuildOutcome = 'unavailable';
            if (layers.requestRebuild) {
              try { outcome = await layers.requestRebuild(t); } catch { outcome = 'failed'; } // @silent-fallback-ok — not silent: counted as the request's `failed` outcome in the row and audited
            }
            ep.requests++; ep.lastRequestAt = now; ep.lastOutcome = outcome; thisTick = outcome;
            if (ep.firstActionableAt === null && (outcome === 'reprojected' || outcome === 'failed')) ep.firstActionableAt = now;
            this.rebuildRequestsTotal++; counts.rebuildRequests = this.rebuildRequestsTotal;
            this.d.audit?.({ event: 'layer-rebuild-requested', reason: outcome, topicKey: t });
          }
          if (!ep.notified && ep.firstActionableAt !== null && ep.firstActionableAt < now && thisTick !== 'reprojected'
            && now - ep.firstActionableAt >= LAYER_STALE_SUSTAINED_MS) {
            this.enqueue({ notice: {
              id: `context-budget-layer-stale-${t}-${ep.since}`,
              title: `The running summary for ${topicRef(t)} is falling behind`,
              summary: `Its saved summary of recent work is more than ${H1_TARGET_USER_TURNS} of your messages behind, and an hour after the first refresh it still has not caught up. The conversation itself works normally; only what a fresh session would be briefed with is out of date.`,
              priority: 'NORMAL',
            } });
            ep.notified = true; noticed = true;
            this.staleNoticesTotal++; counts.notices = this.staleNoticesTotal;
          }
        }
        eps[t] = ep; changed = true;
      } else if (stale === false && ep) {
        delete eps[t]; ep = undefined; changed = true; // the episode ends on a KNOWN fresh reading, never on an unknown
      }
      rows.push({
        topicKey: t, owned,
        h1: { stale, line: f?.line ?? 'stale: unknown', userTurnsBehind: typeof f?.userTurnsBehind === 'number' ? f.userTurnsBehind : null },
        h3: { state: 'unavailable', reason: 'h3-not-built' },
        staleSince: ep?.since ?? null, rebuildRequests: ep?.requests ?? 0, lastRebuild: ep?.lastOutcome ?? null, notified: ep?.notified ?? false,
      });
    }
    // An episode not seen stale for a day (the session went away, or the stamp went unknown) is forgotten.
    for (const [k, e] of Object.entries(eps)) if (!(now - (e?.lastSeenAt ?? 0) < NO_FOLD_WINDOW_MS)) { delete eps[k]; changed = true; }
    if (changed) this.writeEpisodes(eps);
    this.lastFreshness = { state: 'ok', checkedAt: now, counts, topics: rows.slice(0, STATUS_ROW_LIMIT), truncated: Math.max(0, rows.length - STATUS_ROW_LIMIT) };
    if (noticed) await this.flushOutbox();
  }

  private orphanKey(c: OrphanCtx): string {
    // Hashed ids: a topic or fold id may carry `_` (outside the gate's key alphabet) or run long.
    // The ring groups by everything before the last `-`: one group per (topic, carrier kind).
    return `${this.machineSlug()}-${keyHash(c.topicKey).slice(0, 12)}-orphan${c.kind === 'fold-hold' ? 'hold' : 'marker'}-${keyHash(c.foldId).slice(0, 12)}`;
  }

  /**
   * The corroborated reading of one carrier entry (§17: "marker file vs
   * record"). `pending` only when the carrier still lists it, its record is
   * ABSENT or TERMINAL (re-read now), its age is known and past the grace
   * period, and this machine owns the topic.
   */
  private orphanEvidence(c: OrphanCtx, listed?: HoldCarrierEntry): { verdict: OrphanVerdict | 'live' | 'gone'; reason: string; ageMs: number | null; fence: string | null } {
    const none = (verdict: OrphanVerdict | 'live' | 'gone', reason: string, ageMs: number | null = null) => ({ verdict, reason, ageMs, fence: null });
    const h = this.d.holdHealth;
    const src = h?.carriers.find((x) => x.kind === c.kind);
    if (!h || !src) return none('unknown', 'no-carrier');
    let entry = listed;
    if (!entry) {
      let entries: HoldCarrierEntry[];
      try { entries = src.list(); } catch { return none('unknown', 'carrier-unreadable'); } // @silent-fallback-ok — an unreadable listing is an unknown: nothing is released
      entry = entries.find((x) => x.topicKey === c.topicKey && x.foldId === c.foldId);
      if (!entry) return none('gone', 'not-on-disk');
    }
    if (c.topicKey === TORN_MARKER_KEY || c.foldId === TORN_MARKER_KEY || c.foldId === MALFORMED_HOLD_FOLD) {
      return none('unknown', 'unattributable file (no fold id to check): left to the boot sweep');
    }
    const seen = this.d.store.inspect(c.topicKey, c.foldId);
    if (seen.kind === 'torn') return none('unknown', 'record-unreadable');
    if (seen.kind === 'ok' && !TERMINAL_STATES.has(seen.record.state)) return none('live', `record-${seen.record.state}`);
    const reason = seen.kind === 'absent' ? 'no-record' : `record-${seen.record.state}`;
    const writtenAt = entry.writtenAt;
    if (typeof writtenAt !== 'number' || !Number.isFinite(writtenAt)) return none('unknown', `${reason}; age unknown`);
    const since = Math.max(writtenAt, seen.kind === 'ok' ? seen.record.updatedAt : -Infinity);
    const ageMs = this.now() - since;
    if (!(ageMs >= (h.graceMs ?? ORPHAN_GRACE_MS))) return none('in-grace', reason, Number.isFinite(ageMs) ? ageMs : null);
    const owner = this.owns(c.topicKey);
    if (owner !== true) return none('observe-only', `${reason}; ${owner === 'unknown' ? 'owner-unknown' : 'not-owner'}`, ageMs);
    const recFence = seen.kind === 'ok' ? `${seen.record.state}:${seen.record.seq}:${seen.record.generation}` : 'absent';
    return { verdict: 'pending', reason, ageMs, fence: `${c.kind}:${c.topicKey}:${c.foldId}:${writtenAt}:${recFence}` };
  }

  /** The orphan ladder's remediation: re-corroborate, release, verify the file is gone, and say so loudly. */
  private clearOrphan(c: OrphanCtx): SelfHealRemediationResult {
    const before = this.orphanEvidence(c);
    if (before.verdict === 'gone') return { outcome: 'healed', evidence: 'already-healthy' };
    if (before.verdict !== 'pending') return { outcome: 'not-healed', evidence: 'fence-stale' };
    const src = this.d.holdHealth!.carriers.find((x) => x.kind === c.kind)!;
    try { src.release(c.topicKey, c.foldId); } catch { return { outcome: 'not-healed', evidence: 'io-error' }; } // @silent-fallback-ok — not silent: the ladder records the failed attempt and exhausts to one notice
    if (this.orphanEvidence(c).verdict !== 'gone') return { outcome: 'not-healed', evidence: 'verification-failed' };
    const at = this.now();
    this.clearedTotal++;
    this.recentClears.unshift({ kind: c.kind, topicKey: c.topicKey, foldId: c.foldId, at });
    this.recentClears.length = Math.min(this.recentClears.length, 20);
    this.d.audit?.({ event: 'orphan-carrier-cleared', reason: `${c.kind}: ${before.reason}`, topicKey: c.topicKey, foldId: c.foldId });
    try {
      this.d.holdHealth!.degradation({
        feature: 'ContextBudgetSentinel.holdHealth',
        primary: 'Every fold hold and marker is released by its fold record\'s terminal transition',
        fallback: `Cleared a leftover ${c.kind === 'fold-hold' ? 'reply pause' : 'session marker'} for fold ${c.foldId} on ${topicRef(c.topicKey)} (${before.reason})`,
        reason: `A ${c.kind} outlived its fold record (${before.reason}) past the ${Math.round((this.d.holdHealth!.graceMs ?? ORPHAN_GRACE_MS) / 60_000)}-minute grace period`,
        impact: c.kind === 'fold-hold' ? 'Replies on that conversation were being held back; they flow again now.' : 'That session\'s tools were being restricted for a fold that had ended; they work again now.',
      });
    } catch (err) {
      this.d.audit?.({ event: 'orphan-degradation-report-failed', reason: err instanceof Error ? err.message : String(err), topicKey: c.topicKey, foldId: c.foldId });
    }
    return { outcome: 'healed', evidence: 'repaired' };
  }

  private onOrphanGateNotice(n: SelfHealNotice): Promise<void> | void {
    // A slow clear is not paged on its own: the ladder's exhaustion is the one notice (its latency ceiling equals its wall clock).
    if (n.reason === 'latency') return;
    const m = /^self-heal:([0-9a-f]{24}):/.exec(n.id);
    const ctx = m ? this.orphanNoticeTopics.get(m[1]) : undefined;
    const where = ctx ? topicRef(ctx.topicKey) : 'a conversation on this machine';
    return this.d.attention({
      id: `context-budget-orphan-${ctx ? `${ctx.kind}-${ctx.topicKey}-${ctx.foldId}` : n.id.replace(/[^A-Za-z0-9_-]/g, '-')}-${n.reason}`,
      title: n.reason === 'state-failure' ? 'The context fold watcher on this machine could not record its work' : `A leftover fold pause on ${where} could not be cleared`,
      summary: n.reason === 'state-failure'
        ? 'Its record of leftover fold pauses could not be written, so it stopped clearing them rather than act without a record.'
        : `A ${ctx?.kind === 'fold-marker' ? 'session restriction' : 'reply pause'} left by a fold that has ended is still in place: ${n.reason === 'max-attempts' ? 'three tries to clear it did not take' : n.reason === 'wall-clock' ? 'it could not be cleared within half an hour (the clear was not admitted or did not take)' : 'clearing it kept recurring'}. Replies or tools on that conversation may stay held until it is cleared; a restart's boot sweep also releases it.`,
      priority: 'HIGH',
    });
  }

  /** Hold health (§10, §17): every hold and marker on disk against its fold record. */
  private async checkHolds(): Promise<void> {
    const h = this.d.holdHealth!;
    const rows: OrphanRow[] = [];
    const counts = { carriers: 0, live: 0, orphans: 0, cleared: 0, pending: 0, inGrace: 0, observedOnly: 0, unknown: 0, clearedTotal: 0 };
    let stateFailure: string | null = null;
    const seenKeys = new Set<string>();
    for (const src of h.carriers) {
      let entries: HoldCarrierEntry[];
      try { entries = src.list(); } catch (err) { // @silent-fallback-ok — not silent: the row shows the carrier as unknown and nothing of it is released
        counts.unknown++;
        rows.push({ kind: src.kind, topicKey: '*', foldId: '*', ageMs: null, verdict: 'unknown', reason: `carrier-unreadable: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) });
        continue;
      }
      for (const e of entries) {
        counts.carriers++;
        const c: OrphanCtx = { kind: src.kind, topicKey: e.topicKey, foldId: e.foldId };
        const ev = this.orphanEvidence(c, e);
        if (ev.verdict === 'live') { counts.live++; continue; }
        if (ev.verdict === 'gone') continue;
        let verdict: OrphanVerdict = ev.verdict;
        let reason = ev.reason;
        if (ev.verdict === 'pending') {
          let k: string | null = null;
          try { k = this.orphanKey(c); } catch { k = null; } // @silent-fallback-ok — an unkeyable entry reads unknown below
          if (!k) { verdict = 'unknown'; reason = `${reason}; unkeyable`; }
          else {
            const nk = keyHash(`${ORPHAN_LADDER_ID}:${k}`);
            this.orphanNoticeTopics.set(nk, c); seenKeys.add(nk);
            const res = await this.orphanGate!.attempt(c);
            if (res.outcome === 'state-failure') stateFailure = res.reason;
            if (res.outcome === 'healed') verdict = 'cleared';
            else reason = `${reason}; ${res.outcome}:${res.reason}`;
          }
        }
        if (verdict === 'cleared') counts.cleared++;
        else if (verdict === 'pending') counts.pending++;
        else if (verdict === 'in-grace') counts.inGrace++;
        else if (verdict === 'observe-only') counts.observedOnly++;
        else counts.unknown++;
        if (verdict === 'cleared' || verdict === 'pending' || verdict === 'observe-only') counts.orphans++;
        rows.push({ kind: c.kind, topicKey: c.topicKey, foldId: c.foldId, ageMs: ev.ageMs, verdict, reason });
      }
    }
    counts.clearedTotal = this.clearedTotal;
    // Kept for entries still on disk (a queued admission may notify after this tick); bounded by them.
    for (const k of [...this.orphanNoticeTopics.keys()]) if (!seenKeys.has(k)) this.orphanNoticeTopics.delete(k);
    this.lastHolds = { state: 'ok', checkedAt: this.now(), graceMs: h.graceMs ?? ORPHAN_GRACE_MS, counts, orphans: rows.slice(0, STATUS_ROW_LIMIT), recentClears: [...this.recentClears], truncated: Math.max(0, rows.length - STATUS_ROW_LIMIT) };
    // A sentinel that cannot record its own ladder is not a working sentinel (no heartbeat).
    if (stateFailure) throw new Error(`orphan episode store: ${stateFailure}`);
  }

  /**
   * Eligible topic without a fold (§7.8, §9.3 "a day with zero folds on an
   * eligible topic"): OBSERVATION ONLY, never an action. Whether a fold would
   * have paid is the §7.2 benefit estimator's call, which does not exist yet,
   * so a live topic with no fold for a day reads `unknown` with that reason.
   */
  private observeEligible(): void {
    const now = this.now();
    const rows: Array<{ topicKey: string; verdict: 'unknown' | 'folded-recently'; reason: string; lastFoldAt: number | null }> = [];
    const counts = { topics: 0, unknown: 0, foldedRecently: 0 };
    for (const t of this.liveTopicList()) {
      counts.topics++;
      let last: number | null = null;
      for (const r of this.d.store.list(t)) if (Number.isFinite(r.createdAt) && (last === null || r.createdAt > last)) last = r.createdAt;
      if (last !== null && now - last < NO_FOLD_WINDOW_MS) {
        counts.foldedRecently++;
        rows.push({ topicKey: t, verdict: 'folded-recently', reason: 'a fold began within the last day', lastFoldAt: last });
      } else {
        counts.unknown++;
        rows.push({ topicKey: t, verdict: 'unknown', reason: 'no-benefit-estimator: whether a fold would have paid cannot be measured until the benefit estimator (§7.2) exists', lastFoldAt: last });
      }
    }
    this.lastEligible = { state: 'ok', checkedAt: now, counts, topics: rows.slice(0, STATUS_ROW_LIMIT), truncated: Math.max(0, rows.length - STATUS_ROW_LIMIT) };
  }

  status(): SentinelStatus {
    const now = this.now();
    return {
      lastTickAt: this.lastTickAt,
      heartbeatFresh: this.heartbeatFresh(),
      quarantined: this.quarantinedRecords().map((r) => ({ topicKey: r.topicKey, foldId: r.foldId, ageMs: now - r.updatedAt, owned: this.d.ownsFold(r), lastOutcome: this.lastOutcome.get(r.foldId) ?? null })),
      torn: this.lastTorn,
      checkpointsPruned: this.checkpointsPruned,
      lastError: this.lastError,
      canary: this.d.canary ? this.d.canary.instance.report(this.d.canary.switchOn()) : null,
      heal: this.d.heal ? this.d.heal.status() : null,
      press: this.d.press ? this.d.press.status() : null,
      adapterSuite: (() => {
        let attempts: Record<string, { count: number; lastAt: number }> = {};
        try { attempts = JSON.parse(fs.readFileSync(path.join(adapterSuiteDir(this.d.stateDir), 'attempts.json'), 'utf-8')) as typeof attempts; } catch { attempts = {}; } // @silent-fallback-ok — no attempts yet
        const results = readSuiteResults(this.d.stateDir);
        const recorded = (key: string) => results.some((r) => key.startsWith('codex-cli@') ? r.engine === 'codex-cli' && `codex-cli@${r.version}` === key : (r.engine ?? 'claude-code') === 'claude-code' && r.version === key);
        const gaveUp = Object.entries(attempts).filter(([v, a]) => a.count >= SUITE_MAX_ATTEMPTS && !recorded(v)).map(([v]) => v);
        const readLast = (name: string): Record<string, unknown> | null => {
          try { return JSON.parse(fs.readFileSync(path.join(adapterSuiteDir(this.d.stateDir), name), 'utf-8')) as Record<string, unknown>; } catch { return null; } // @silent-fallback-ok — no run yet
        };
        return {
          running: this.suiteRunning, results: results.slice(0, 5), attempts, gaveUp,
          engineVersion: this.d.adapterSuite?.currentVersion() ?? null, lastRun: readLast('last-run.json'),
          codex: { wired: !!this.d.codexAdapterSuite, engineVersion: this.d.codexAdapterSuite?.currentVersion() ?? null, lastRun: readLast('last-run-codex-cli.json') },
        };
      })(),
      layerFreshness: !this.d.layers ? { state: 'unavailable', reason: 'layers-off' }
        : !this.d.liveTopics ? { state: 'unavailable', reason: 'no-session-source' }
          : this.lastFreshness ?? { state: 'ok', checkedAt: null, counts: { topics: 0, fresh: 0, stale: 0, unknown: 0, observedOnly: 0, rebuildRequests: this.rebuildRequestsTotal, notices: this.staleNoticesTotal }, topics: [], truncated: 0 },
      holdHealth: !this.d.holdHealth ? { state: 'unavailable', reason: 'no-carriers' }
        : this.lastHolds ?? { state: 'ok', checkedAt: null, graceMs: this.d.holdHealth.graceMs ?? ORPHAN_GRACE_MS, counts: { carriers: 0, live: 0, orphans: 0, cleared: 0, pending: 0, inGrace: 0, observedOnly: 0, unknown: 0, clearedTotal: this.clearedTotal }, orphans: [], recentClears: [...this.recentClears], truncated: 0 },
      eligibleWithoutFold: !this.d.liveTopics ? { state: 'unavailable', reason: 'no-session-source' }
        : this.lastEligible ?? { state: 'ok', checkedAt: null, counts: { topics: 0, unknown: 0, foldedRecently: 0 }, topics: [], truncated: 0 },
    };
  }
}
