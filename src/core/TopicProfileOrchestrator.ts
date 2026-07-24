/**
 * TopicProfileOrchestrator — the §8 orchestration core of TOPIC-PROFILE-SPEC:
 * the debounce / idle-confirmation / kill-respawn machinery that applies a
 * profile change SAFELY, plus the §10.4 spawn-failure circuit breaker and the
 * §14 dry-run shadow regime.
 *
 * Spec clauses owned here (each enforced in code, not prose):
 *
 *  §8 two-phase lock — the per-topic store lock is held in TWO SHORT PHASES,
 *    never across the debounce window: WRITE (mutate → arm/extend debounce →
 *    release) and RESPAWN (re-acquire → re-resolve AT THIS MOMENT → re-confirm
 *    idle → [kill → respawn] → release). Re-resolution + idle re-confirm +
 *    net-unchanged skip run at DEQUEUE time inside the lock (round-4).
 *
 *  Debounce slots — per-topic pending slot + trailing-edge timer; the store
 *    write is immediate, only the RESPAWN is debounced. N changes in the
 *    window collapse to ONE respawn against the final resolved profile; a
 *    net-unchanged sequence fires ZERO respawns and closes its loop out loud.
 *    The framework-switch arm carries the heavier window.
 *
 *  Idle is a precondition re-checked at kill time, never a value carried from
 *    classification (round-2 TOCTOU). The read is three-valued; at kill time
 *    UNCONFIRMED IS BUSY (defer) — never permission to kill. Pane-idle is not
 *    task-done: the autonomous-session registry is consulted, and an active
 *    autonomous/time-boxed run is busy until it completes (only the explicit
 *    "switch now" confirm overrides). PROTECTED SESSIONS ARE NEVER
 *    PROFILE-KILLED — and "switch now" never overrides protection (round-5).
 *
 *  Kill-path precision — a same-framework resume respawn kills via the
 *    resume-saving path (the re-save is wanted); a FRESH respawn PARKS (never
 *    deletes) BOTH resume stores' entries before the kill and sets a
 *    topic-scoped, time-bounded durable suppression marker so no writer
 *    (heartbeat, post-spawn save, kill listener, shutdown save) can re-persist
 *    a stale id during the window — the gates are installed at the resume-map
 *    chokepoints via claudeResumeWriteGate()/codexResumeWriteGate().
 *
 *  Disclosure-of-record — EVERY accepted write discloses; writes inside the
 *    active debounce window coalesce into ONE delta-carrying disclosure
 *    ("was: <pre-burst> → now: <final> (N changes)"); a per-topic rate cap
 *    backstops outside the window with a delta-carrying overflow summary; the
 *    undo snapshot (store.mutate shiftPrevious) moves once per disclosed
 *    burst — undo always restores the profile the operator last saw disclosed
 *    (R7-4). Disclosures carry the audit seq and set the relay dedup bypass.
 *
 *  Global stagger — profile-triggered respawns share a global concurrency cap
 *    (max K in flight, FIFO queue); same-cwd codex spawns are serialized so
 *    two codex sessions never spawn inside the same capture fence window
 *    (bounded wait: prior fence resolves or the RESPAWN-phase TTL, round-7).
 *
 *  §9 interplay — only operator pin writes arm the respawn debounce;
 *    escalation consults read-only and serializes through runExclusive().
 *    Any profile-triggered kill clears the topic's escalation marker and
 *    releases its lease BEFORE computing expected-live; expected-live =
 *    resolved baseline ⊕ any active escalation marker (no controller
 *    ping-pong).
 *
 *  §10.4 breaker — LIVE in every regime (exempt from BOTH `enabled` and
 *    `dryRun`; legacy-path failures count when attributable). Attribution is
 *    an ALLOWLIST (cli-not-found / launch-arg-rejected /
 *    model-rejected-by-account); ambient classes never increment; the counter
 *    resets on any successful spawn. A trip parks the profile
 *    intended-but-unhealthy, reverts to last-known-good (or default),
 *    un-parks the matching-framework resume entry (none-loss when the
 *    transcript survives), notifies the operator, audits
 *    system:circuit-breaker, and respawns IMMEDIATELY (the one keep-working
 *    exception to regime gating). Re-apply of the same recently-tripped
 *    profile requires an explicit cooldown confirm; switch-now,
 *    propose-confirm and the cooldown confirm share ONE armed slot per topic.
 *
 *  §14 dry-run shadow — under `enabled && dryRun`, NEW-axis writes persist to
 *    the shadow intendedProfile field that resolution ignores ([dry-run]
 *    notice); the true→false flip CLEARS every shadow (never promotes) with
 *    one coalesced expired-intents notice; exempted framework writes and the
 *    recovery writes (re-apply / clear) are always LIVE store writes in every
 *    regime, with the recovery writes' APPLICATION arm regime-governed (no
 *    profile-triggered kill outside fully-live; told out loud).
 *
 * Dependency-injected throughout (ModelSwapService house style): every
 * side-effecting surface is a constructor dep; pure logic
 * (classifyProfileChange, profilesEqual) is imported directly.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  classifyProfileChange,
  type IdleReading,
  type ProfileSessionState,
  type SwapMethod,
} from './classifyProfileChange.js';
import {
  FlushRefusedError,
  ProfileLockTimeoutError,
  ProfileValidationRefusal,
  type TopicProfile,
  type TopicProfileStore,
} from './TopicProfileStore.js';
import type { ResolvedTopicProfile } from './TopicProfileResolver.js';
import type {
  EffortLevel,
  ProfileModelTier,
  ThinkingMode,
  ValidatedProfilePatch,
} from './topicProfileValidation.js';
import type { CodexSpawnFence, FenceCaptureResult } from './CodexResumeMap.js';
import type { IntelligenceFramework } from './intelligenceProviderFactory.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types. NOTE: several of these arguably belong in src/core/types.ts, which is
// owned by a parallel agent — they are defined locally per the file-ownership
// boundary and exported for the integrating session.
// ─────────────────────────────────────────────────────────────────────────────

export type ProfileWriteOrigin =
  | 'conversational'
  | 'slash'
  | 'http'
  | 'transfer'
  | 'system';

/**
 * §10.4 failure classes. ONLY the allowlist counts toward the breaker —
 * ambient classes (conditions that would fail ANY profile) never increment,
 * and resume-id-mismatch is the resume map's failure, not the profile's.
 */
export type ProfileSpawnFailureClass =
  | 'cli-not-found'
  | 'launch-arg-rejected'
  | 'model-rejected-by-account'
  | 'resume-id-mismatch'
  | 'quota'
  | 'tmux'
  | 'disk'
  | 'unknown';

const BREAKER_ATTRIBUTABLE: ReadonlySet<ProfileSpawnFailureClass> = new Set([
  'cli-not-found',
  'launch-arg-rejected',
  'model-rejected-by-account',
]);

/** The launch characteristics actually applied to a live session at spawn. */
export interface AppliedProfile {
  framework: IntelligenceFramework;
  /** Concrete model id, or null for the account default. */
  model: string | null;
  /** Tier shape of the pin that produced the model, when tier-shaped. */
  modelTier: ProfileModelTier | null;
  thinkingMode: ThinkingMode | null;
  /** Claude `--effort` level applied at spawn, or null. */
  effort: EffortLevel | null;
}

export interface OrchTopicSession {
  sessionName: string;
  cwd: string;
}

export interface RespawnSpawnOutcome {
  ok: boolean;
  failureClass?: ProfileSpawnFailureClass;
  /** Profile observed on the newly-created session, after launch defaults. */
  applied?: AppliedProfile;
}

/** The narrow session surface the orchestrator is allowed to touch. */
export interface OrchestratorSessionPort {
  getSessionForTopic(topicKey: string): OrchTopicSession | null;
  /** All live topic-bound sessions (boot reconcile sweep). */
  listTopicSessions(): Array<{ topicKey: string; sessionName: string }>;
  /** FABLE capture-pane idle confirmation — three-valued (§8). */
  readIdle(sessionName: string): IdleReading;
  /**
   * Kill via SessionManager.killSession — fires beforeSessionKill, so the
   * resume re-save happens (WANTED for a same-framework resume respawn).
   */
  killForResume(sessionName: string): Promise<boolean>;
  /**
   * Fresh-respawn kill: direct tmux path or suppression-set kill — NO resume
   * re-save may fire (the §8 symmetric-poisoning rule; the durable
   * suppression marker backstops writers that fire anyway).
   */
  killFresh(sessionName: string): Promise<boolean>;
  /** Spawn the topic's session with the resolved profile. */
  spawn(
    topicKey: string,
    resolved: ResolvedTopicProfile,
    directive: { method: SwapMethod; resumeId?: string },
  ): Promise<RespawnSpawnOutcome>;
}

export interface ClaudeResumePort {
  /** §8 pre-kill predicate: hook-provenance resume readiness. */
  ready(topicKey: string): boolean;
  resumeId(topicKey: string): string | null;
  park(topicKey: string, reason: string): void;
  unpark(topicKey: string): boolean;
}

export interface CodexResumePort {
  get(topicKey: string): string | null;
  captureAtKill(
    topicKey: string,
    sessionName: string,
    fence: CodexSpawnFence,
  ): Promise<FenceCaptureResult>;
  park(topicKey: string, reason: string): void;
  unpark(topicKey: string): boolean;
}

/** §9 — FABLE's ephemeral last-applied-tier marker, read-only + clear. */
export interface EscalationPort {
  /** The active escalation marker for a topic (escalated model id), or null. */
  activeMarker(topicKey: string): { model: string } | null;
  /** All topics holding markers (boot-sweep stale-marker clear). */
  listMarkerTopics(): string[];
  /** Profile-triggered kill / stale sweep: clear marker + release the lease. */
  clearMarkerAndReleaseLease(topicKey: string): void;
}

/** The §7 in-flight row — the FABLE model-swap route (tier only, never an id). */
export interface InFlightSwapPort {
  swap(
    sessionName: string,
    tier: 'default' | 'escalated',
  ): Promise<{ status: 'swapped' | 'unconfirmed' | 'dry-run' | 'noop' | 'refused'; reason?: string }>;
}

/** §6/§14 verification markers feeding the classifier's contingency flags. */
export interface ProfileVerificationFlags {
  inFlightSwapConfirmedRecently: boolean;
  thinkingOffOnResumeVerified: boolean;
  thinkingLevelResumeVerified: boolean;
  crossModelResumeVerified: boolean;
  claudeThinkingControlAvailable: boolean;
}

export interface OrchestratorConfig {
  /** RESOLVED gate value (DEV_GATED_FEATURES / operator override). */
  enabled: boolean;
  dryRun: boolean;
  respawnDebounceMs: number;
  frameworkSwitchDebounceMs: number;
  maxConcurrentProfileRespawns: number;
  spawnFailureBreakerThreshold: number;
  switchNowConfirmTtlMs: number;
}

export interface DisclosureMeta {
  /** Relay exact-duplicate suppression bypass (§8 — disclosure-of-record). */
  allowDuplicate: true;
  auditSeq: number;
}

export interface TopicProfileOrchestratorDeps {
  store: TopicProfileStore;
  /** The §5.2 single resolution point (in-memory, O(1)). */
  resolveProfile: (topicKey: string) => ResolvedTopicProfile;
  sessions: OrchestratorSessionPort;
  claudeResume: ClaudeResumePort;
  codexResume: CodexResumePort;
  escalation: EscalationPort;
  inFlightSwap: InFlightSwapPort;
  /** §8 — an active autonomous/time-boxed session is busy until it completes. */
  autonomousActive: (topicKey: string) => boolean;
  isProtectedSession: (sessionName: string) => boolean;
  /** The codex spawn fence recorded at launch for a topic (§7), or null. */
  codexFence: (topicKey: string) => CodexSpawnFence | null;
  verification: () => ProfileVerificationFlags;
  getConfig: () => OrchestratorConfig;
  /** Platform-routed disclosure to the topic's owning conversation (§10.5). */
  disclose: (topicKey: string, text: string, meta: DisclosureMeta) => void;
  /** Structured audit sink → logs/topic-profile-changes.jsonl (§10.3). */
  audit: (event: Record<string, unknown>) => void;
  /** Durable orchestrator side-state (lastApplied / suppressions / trips). */
  stateFilePath: string;
  now?: () => number;
}

export interface ProfileWriteAttribution {
  /** Server-verified principal (or 'api-token' / 'system:*') — never body-supplied. */
  updatedBy: string;
  origin: ProfileWriteOrigin;
}

export type ProfileWriteOutcome =
  | { outcome: 'applied'; reply: string; auditSeq: number; supersededParked: boolean }
  | { outcome: 'shadow-recorded'; reply: string; auditSeq: number }
  | { outcome: 'no-change'; reply: string }
  | { outcome: 'refused'; reply: string; reason: string };

export type RecoveryWriteOutcome =
  | { outcome: 'applied'; reply: string }
  | { outcome: 'confirm-required'; reply: string }
  | { outcome: 'refused'; reply: string; reason: string };

// ── internal state shapes ────────────────────────────────────────────────────

type ConfirmKind = 'switch-now' | 'cooldown-reapply' | 'propose';

interface ArmedConfirm {
  kind: ConfirmKind;
  echo: string;
  armedAt: number;
  expiresAt: number;
  /** Platform message id of the rendered echo (§10.1 event-ordering). */
  echoMessageId?: number;
  run: () => Promise<string>;
}

interface PendingSlot {
  timer: ReturnType<typeof setTimeout> | null;
  /** Live characteristics at burst start (net-unchanged + "was:" rendering). */
  preBurst: TopicProfile | null;
  changeCount: number;
  origins: Set<string>;
  frameworkArm: boolean;
  /** Busy-abort re-arm state — tick() retries these (§8 real carrier). */
  deferred: boolean;
  deferredReason?: string;
  /** Set by an in-flight 'unconfirmed' outcome — never guess again (§14). */
  forceNoInFlight: boolean;
  /** Disclosed-once dedupe for the defer notices (per pending change). */
  disclosedDefer: Set<string>;
  /** A breaker revert / switch-now task bypasses the busy deferral. */
  switchNowOverride: boolean;
}

interface DurableSideState {
  lastApplied: Record<string, { profile: AppliedProfile; at: string }>;
  /** topicKey → ISO until — mid-framework-switch resume-save suppression. */
  suppressions: Record<string, string>;
  /** §10.4 cooldown-confirm memory: the profile that just tripped. */
  breakerTrips: Record<string, { profileKey: string; at: string }>;
}

interface RespawnTask {
  topicKey: string;
  /** Breaker revert: live in every regime, immediate, no debounce. */
  breakerRevert: boolean;
  switchNowOverride: boolean;
  enqueuedAt: number;
  firstBlockedAt?: number;
}

// ── hardcoded v1 constants (§12.5 — no invented knobs) ──────────────────────

const RESPAWN_PHASE_TTL_MS = 90_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
const SUPPRESSION_TTL_MS = 10 * 60_000;
const DISCLOSURE_RATE_CAP = 4;
const DISCLOSURE_RATE_WINDOW_MS = 60_000;
const REAPPLY_COOLDOWN_MS = 10 * 60_000;
const CONFIRM_ARM_RATE_CAP = 5;
const CONFIRM_ARM_RATE_WINDOW_MS = 60_000;

const PROFILE_AXES = ['framework', 'model', 'modelTier', 'escalationOverride', 'thinkingMode', 'effort'] as const;

export class TopicProfileOrchestrator {
  private readonly deps: TopicProfileOrchestratorDeps;
  private readonly now: () => number;

  private readonly pendingSlots = new Map<string, PendingSlot>();
  private readonly confirmSlots = new Map<string, ArmedConfirm>();
  private readonly confirmArmTimes = new Map<string, number[]>();
  private confirmArmCooldownUntil = new Map<string, number>();

  /** FIFO respawn queue + global stagger cap (§8). */
  private readonly respawnQueue: RespawnTask[] = [];
  private inFlightRespawns = 0;
  private readonly activeRespawnTopics = new Set<string>();
  private drainWakeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Same-cwd codex fence windows (cwd → until epoch ms). */
  private readonly codexFenceWindows = new Map<string, number>();

  /** Per-topic immediate-disclosure timestamps + overflow accumulation. */
  private readonly disclosureTimes = new Map<string, number[]>();
  private readonly overflow = new Map<
    string,
    { count: number; origins: Set<string>; preOverflow: TopicProfile | null; timer: ReturnType<typeof setTimeout> }
  >();

  private durable: DurableSideState = { lastApplied: {}, suppressions: {}, breakerTrips: {} };
  private auditSeq = 0;
  private lastSeenDryRun: boolean | null = null;

  constructor(deps: TopicProfileOrchestratorDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.loadDurable();
    this.lastSeenDryRun = this.cfg().dryRun;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Write surface entry — regime-gated (§5.2 / §14)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Apply a validated NEW-axis profile patch under the current regime.
   *  - fully-live (`enabled && !dryRun`): live mutate + debounce-armed respawn.
   *  - `enabled && dryRun`: shadow intendedProfile write, `[dry-run]` notice —
   *    resolution never reads it, the flip never promotes it (§14).
   *  - `!enabled`: REFUSED (existing pins stay honored on read) — EXCEPT a
   *    clear-only patch, which is a §5.2(b) recovery write, live everywhere.
   * The caller has already run §10.1 identity + §10.2 validation; this method
   * re-enforces the store-side invariants regardless (defense in depth).
   */
  async requestProfileChange(
    topicKey: number | string,
    patch: ValidatedProfilePatch,
    attribution: ProfileWriteAttribution,
  ): Promise<ProfileWriteOutcome> {
    const key = String(topicKey);
    const cfg = this.cfg();
    this.checkDryRunFlip();

    const clearOnly = isClearOnlyPatch(patch);
    const isSystemWrite = attribution.updatedBy.startsWith('system:');

    if (!cfg.enabled && !clearOnly && !isSystemWrite) {
      const reply =
        'the topic-profile feature is not enabled on this agent — existing pins stay honored, but new pins are refused';
      this.audit_({ type: 'write-refused', topic: key, reason: 'disabled', origin: attribution.origin });
      return { outcome: 'refused', reply, reason: 'disabled' };
    }

    if (cfg.enabled && cfg.dryRun && !clearOnly && !isSystemWrite) {
      // §14 shadow write — never silently live.
      await this.deps.store.setShadow(key, patch, attribution.updatedBy);
      const seq = ++this.auditSeq;
      const reply = `[dry-run] would set ${renderPatch(patch)} on this topic — recorded as a dry-run intent (not applied)`;
      this.deps.disclose(key, this.stamp(reply, seq), { allowDuplicate: true, auditSeq: seq });
      this.audit_({ type: 'shadow-recorded', topic: key, seq, patch: renderPatch(patch), origin: attribution.origin });
      return { outcome: 'shadow-recorded', reply, auditSeq: seq };
    }

    return this.applyLiveWrite(key, patch, attribution, { recovery: clearOnly });
  }

  /**
   * §5.2(d) — an exempted framework-arm write (the legacy `/route` lane):
   * ALWAYS a live store write regardless of `enabled`/`dryRun`. The legacy
   * path performs its own immediate respawn; NO §8 machinery is engaged here
   * — but under `enabled && dryRun` the §8 orchestration runs in SHADOW,
   * logging the `[dry-run]` decisions it WOULD have made (audit-only, never
   * operator-facing). Returns the disclosure-of-record metadata the legacy
   * reply must carry (audit stamp + dedup bypass + parked-supersession name).
   */
  async applyExemptFrameworkWrite(
    topicKey: number | string,
    framework: IntelligenceFramework,
    attribution: ProfileWriteAttribution,
  ): Promise<{
    changed: boolean;
    auditSeq: number;
    supersededParked: boolean;
    /** Append to the legacy reply when non-null (R10-3/R13). */
    supersessionNote: string | null;
    /** Stamp + dedup-bypass the legacy reply with these (R13). */
    meta: DisclosureMeta;
  }> {
    const key = String(topicKey);
    const cfg = this.cfg();
    const pre = this.deps.store.resolve(key);

    // The legacy reply is the delta-carrying disclosure-of-record — it
    // anchors the §5.1 undo-snapshot cadence (shift once per disclosure).
    const result = await this.deps.store.mutate(
      key,
      { framework, updatedBy: attribution.updatedBy },
      { shiftPrevious: true },
    );
    const seq = ++this.auditSeq;
    this.audit_({
      type: 'write-accepted',
      lane: 'legacy-exempt-framework',
      topic: key,
      seq,
      framework,
      origin: attribution.origin,
      supersededParked: result.supersededParked,
    });

    // §14 canary: shadow-observe the would-be §8 decisions against this real
    // traffic — audit/maturation-log only, never an operator message.
    if (cfg.enabled && cfg.dryRun && result.changed) {
      this.shadowObserveSwitch(key, pre, this.deps.store.resolve(key));
    }

    return {
      changed: result.changed,
      auditSeq: seq,
      supersededParked: result.supersededParked,
      supersessionNote: result.supersededParked
        ? 'your previously-parked profile pin was superseded by this change'
        : null,
      meta: { allowDuplicate: true, auditSeq: seq },
    };
  }

  /**
   * §5.2(b) recovery writes — re-apply a §10.4 parked pin, or clear. LIVE in
   * every regime (never refused as a new pin, never shadowed). The
   * APPLICATION arm is regime-governed: outside fully-live there is NO
   * profile-triggered kill — the write applies at the next natural spawn /
   * boot sweep, and the confirmation says so out loud.
   */
  async requestRecoveryWrite(
    topicKey: number | string,
    action: 'reapply' | 'clear',
    attribution: ProfileWriteAttribution,
    opts: { confirmed?: boolean } = {},
  ): Promise<RecoveryWriteOutcome> {
    const key = String(topicKey);

    if (action === 'clear') {
      const live = await this.applyLiveWrite(
        key,
        { framework: null, model: null, modelTier: null, thinkingMode: null, effort: null, escalationOverride: null },
        attribution,
        { recovery: true },
      );
      if (live.outcome === 'refused') return { outcome: 'refused', reply: live.reply, reason: live.reason };
      return { outcome: 'applied', reply: live.reply };
    }

    // re-apply
    const parked = this.deps.store.parkedFor(key);
    if (!parked) {
      const reply = "nothing parked — you've since set a new profile (or none ever parked here)";
      this.audit_({ type: 'reapply-refused', topic: key, reason: 'nothing-parked' });
      return { outcome: 'refused', reply, reason: 'nothing-parked' };
    }

    // §10.4 cooldown guard: re-applying the SAME profile that just tripped
    // needs the consequence stated + an explicit confirm.
    const trip = this.durable.breakerTrips[key];
    const parkedKey = profileKeyOf(parked.profile);
    const withinCooldown = trip && trip.profileKey === parkedKey && this.now() - Date.parse(trip.at) < REAPPLY_COOLDOWN_MS;
    if (withinCooldown && !opts.confirmed) {
      const n = this.cfg().spawnFailureBreakerThreshold;
      const echo = `this exact profile failed ${n} times a few minutes ago — apply it anyway?`;
      this.armConfirm(key, 'cooldown-reapply', echo, async () => {
        const r = await this.requestRecoveryWrite(key, 'reapply', attribution, { confirmed: true });
        return r.reply;
      });
      this.audit_({ type: 'reapply-cooldown-confirm-armed', topic: key });
      return { outcome: 'confirm-required', reply: echo };
    }

    const patch: ValidatedProfilePatch = {
      framework: parked.profile.framework ?? null,
      model: parked.profile.model ?? null,
      modelTier: parked.profile.modelTier ?? null,
      thinkingMode: parked.profile.thinkingMode ?? null,
      effort: parked.profile.effort ?? null,
      escalationOverride: parked.profile.escalationOverride ?? null,
    };
    const live = await this.applyLiveWrite(key, patch, attribution, {
      recovery: true,
      reapplyOfParked: true,
      confirmedOverCooldown: Boolean(withinCooldown && opts.confirmed),
    });
    if (live.outcome === 'refused') return { outcome: 'refused', reply: live.reply, reason: live.reason };
    await this.deps.store.clearParked(key);
    return { outcome: 'applied', reply: live.reply };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // WRITE phase (§8 phase 1)
  // ───────────────────────────────────────────────────────────────────────────

  private async applyLiveWrite(
    key: string,
    patch: ValidatedProfilePatch,
    attribution: ProfileWriteAttribution,
    flags: { recovery?: boolean; reapplyOfParked?: boolean; confirmedOverCooldown?: boolean } = {},
  ): Promise<ProfileWriteOutcome> {
    const cfg = this.cfg();
    const fullyLive = cfg.enabled && !cfg.dryRun;
    const slot = this.pendingSlots.get(key);
    const overflowActive = this.overflow.has(key);

    // §5.1 undo cadence: `previous` shifts ONCE per delta-carrying disclosure
    // — at the FIRST write of an active coalescing window or rate-cap
    // overflow period (no slot + no overflow ⇒ this write OPENS a disclosed
    // burst → shift; either active ⇒ this write coalesces into the
    // already-shifted burst → no shift). Undo always restores the profile
    // the operator last saw disclosed (R7-4).
    const shiftPrevious = !slot && !overflowActive;
    const preBurst = shiftPrevious ? this.deps.store.resolve(key) : null;

    let result;
    try {
      result = await this.deps.store.mutate(key, { ...patch, updatedBy: attribution.updatedBy }, {
        shiftPrevious: Boolean(shiftPrevious),
      });
    } catch (err) {
      if (err instanceof ProfileValidationRefusal) {
        this.audit_({
          type: 'write-refused',
          topic: key,
          reason: err.validation.failure,
          field: err.validation.field,
          origin: attribution.origin,
        });
        return { outcome: 'refused', reply: err.validation.reason, reason: err.validation.failure };
      }
      if (err instanceof ProfileLockTimeoutError) {
        // §8 — a spoken refusal, never a silent drop.
        const reply = "couldn't apply — this topic's session is mid-restart; say it again in a minute";
        this.audit_({ type: 'write-refused', topic: key, reason: 'lock-timeout', origin: attribution.origin });
        return { outcome: 'refused', reply, reason: 'lock-timeout' };
      }
      if (err instanceof FlushRefusedError) {
        // §5.1 — durability precedes acknowledgment; the store rolled back.
        const reply = "couldn't save that change durably — nothing was applied; please try again";
        this.audit_({ type: 'write-refused', topic: key, reason: 'flush-failed', origin: attribution.origin });
        return { outcome: 'refused', reply, reason: 'flush-failed' };
      }
      throw err;
    }

    if (!result.changed) {
      return { outcome: 'no-change', reply: 'already set — no change needed' };
    }

    const seq = ++this.auditSeq;
    this.audit_({
      type: flags.reapplyOfParked ? 'reapply-accepted' : 'write-accepted',
      topic: key,
      seq,
      patch: renderPatch(patch),
      origin: attribution.origin,
      recovery: Boolean(flags.recovery),
      confirmedOverCooldown: Boolean(flags.confirmedOverCooldown),
      supersededParked: result.supersededParked,
    });

    // ── application arm ──────────────────────────────────────────────────
    const session = this.deps.sessions.getSessionForTopic(key);
    const resolvedNow = this.deps.resolveProfile(key);

    let reply: string;
    if (!fullyLive) {
      // §5.2(b): recovery (and system) writes apply with NO profile-triggered
      // kill outside the fully-live regime — told out loud.
      reply = flags.reapplyOfParked
        ? "re-applied — takes effect at this topic's next session restart"
        : `${renderPatch(patch)} saved — takes effect at this topic's next session restart`;
      this.discloseWrite(key, reply, seq, attribution, { slotActive: false });
      return { outcome: 'applied', reply, auditSeq: seq, supersededParked: result.supersededParked };
    }

    if (!session) {
      reply = `${renderPatch(patch)} pinned — applies at this topic's next session start`;
      this.discloseWrite(key, reply, seq, attribution, { slotActive: Boolean(slot) });
      return { outcome: 'applied', reply, auditSeq: seq, supersededParked: result.supersededParked };
    }

    // Preview classification (window choice + busy wording ONLY — idle and
    // everything else re-confirms at dequeue inside the lock).
    const lastApplied = this.durable.lastApplied[key]?.profile ?? null;
    const preview = classifyProfileChange(
      appliedToPseudo(lastApplied) ?? this.deps.store.previousFor(key),
      resolvedToPseudo(resolvedNow),
      this.sessionState(key, session),
    );

    if (preview.swapMethod === 'none') {
      // A write landing during an ACTIVE window still coalesces into the
      // pending respawn (§8) — e.g. the toggle-back leg of a net-unchanged
      // sequence classifies 'none' against the live characteristics, but the
      // dequeue-time re-resolution (and the net-unchanged loop-closing
      // disclosure) must count it.
      if (this.pendingSlots.has(key)) {
        this.armRespawn(key, cfg.respawnDebounceMs, {
          frameworkArm: false,
          preBurst,
          origin: attribution.origin,
        });
      }
      reply = `${renderPatch(patch)} set${result.supersededParked ? ' (your parked pin was superseded)' : ''} — ${preview.reason}`;
      this.discloseWrite(key, reply, seq, attribution, { slotActive: Boolean(slot) });
      return { outcome: 'applied', reply, auditSeq: seq, supersededParked: result.supersededParked };
    }

    const frameworkArm = preview.changedFields.includes('framework');
    const windowMs = frameworkArm ? cfg.frameworkSwitchDebounceMs : cfg.respawnDebounceMs;

    if (preview.refuseOrConfirm && preview.protectedDeferral) {
      reply =
        'this session is protected — unprotect it first, or the switch applies at the next natural restart';
    } else if (preview.refuseOrConfirm) {
      // §8 busy framework switch — refuse-or-confirm + arm "switch now".
      reply =
        "This topic is mid-task right now — switching frameworks would interrupt the running build and lose its in-flight work. I'll apply the switch the moment it goes idle, or say 'switch now' to interrupt.";
      this.armConfirm(key, 'switch-now', reply, async () => this.executeSwitchNow(key));
    } else if (preview.protectedDeferral) {
      reply =
        'this session is protected — unprotect it first, or the change applies at the next natural restart';
    } else {
      reply = `${renderPatch(patch)} pinned — applying in ~${Math.round(windowMs / 1000)}s`;
    }
    if (result.supersededParked) reply += ' (your parked pin was superseded by this change)';

    this.armRespawn(key, windowMs, { frameworkArm, preBurst, origin: attribution.origin });
    this.discloseWrite(key, reply, seq, attribution, { slotActive: Boolean(slot) });
    return { outcome: 'applied', reply, auditSeq: seq, supersededParked: result.supersededParked };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Debounce slot + RESPAWN phase (§8 phase 2)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * §8 write-surface seam (ProfileOrchestratorLike). Called by the write
   * surface AFTER it has performed the live store write in the fully-live
   * regime — the surface owns the mutate, the orchestrator owns the debounced,
   * idle-gated respawn. Re-resolves nothing here: it arms the per-topic
   * debounce window (heavier window when the framework axis changed) and the
   * trailing-edge fire enqueues the §8 respawn. A no-op when the orchestrator
   * is not in the fully-live regime (the surface only calls this when fully-live,
   * but the guard keeps the seam safe under a regime flip mid-burst).
   */
  onProfileWrite(
    topicKey: number | string,
    info: { frameworkChanged: boolean; origin: string },
  ): void {
    const key = String(topicKey);
    const cfg = this.cfg();
    if (!cfg.enabled || cfg.dryRun) return;
    const slot = this.pendingSlots.get(key);
    // Capture the live characteristics at burst start so a net-unchanged burst
    // closes the loop with the "was:" rendering (§8 debounce contract).
    const preBurst = slot ? slot.preBurst : this.deps.store.resolve(key);
    this.armRespawn(key, cfg.respawnDebounceMs, {
      frameworkArm: info.frameworkChanged,
      preBurst,
      origin: info.origin,
    });
  }

  private armRespawn(
    key: string,
    windowMs: number,
    info: { frameworkArm: boolean; preBurst: TopicProfile | null; origin: string },
  ): void {
    let slot = this.pendingSlots.get(key);
    if (!slot) {
      slot = {
        timer: null,
        preBurst: info.preBurst,
        changeCount: 0,
        origins: new Set(),
        frameworkArm: false,
        deferred: false,
        forceNoInFlight: false,
        disclosedDefer: new Set(),
        switchNowOverride: false,
      };
      this.pendingSlots.set(key, slot);
    }
    slot.changeCount += 1;
    slot.origins.add(info.origin);
    slot.frameworkArm = slot.frameworkArm || info.frameworkArm;
    slot.deferred = false;

    // Trailing edge: each write extends the window; a burst containing a
    // framework switch uses the heavier window.
    const effectiveWindow = slot.frameworkArm
      ? Math.max(windowMs, this.cfg().frameworkSwitchDebounceMs)
      : windowMs;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => this.onDebounceFire(key), effectiveWindow);
    slot.timer.unref?.();
  }

  private onDebounceFire(key: string): void {
    const slot = this.pendingSlots.get(key);
    if (slot) slot.timer = null;
    this.enqueueRespawn({
      topicKey: key,
      breakerRevert: false,
      switchNowOverride: slot?.switchNowOverride ?? false,
      enqueuedAt: this.now(),
    });
  }

  private enqueueRespawn(task: RespawnTask): void {
    this.respawnQueue.push(task);
    void this.drainQueue();
  }

  /** Global stagger: max K respawns in flight; FIFO; codex same-cwd serialized. */
  private async drainQueue(): Promise<void> {
    const cfg = this.cfg();
    while (this.inFlightRespawns < cfg.maxConcurrentProfileRespawns && this.respawnQueue.length > 0) {
      const task = this.respawnQueue.shift()!;
      if (this.activeRespawnTopics.has(task.topicKey)) {
        // Same topic already executing — its terminal re-resolves; drop.
        continue;
      }
      // Same-cwd codex fence serialization (§7/§8): never spawn two codex
      // sessions inside one fence window — bounded by the RESPAWN-phase TTL.
      const blockedUntil = this.codexBlockedUntil(task.topicKey);
      if (blockedUntil !== null) {
        task.firstBlockedAt = task.firstBlockedAt ?? this.now();
        if (this.now() - task.firstBlockedAt < RESPAWN_PHASE_TTL_MS) {
          this.respawnQueue.push(task);
          this.scheduleDrainWake(blockedUntil);
          // Nothing else can run this pass if the only tasks are blocked —
          // avoid a hot spin by breaking when the queue is all-blocked.
          if (this.respawnQueue.every((t) => this.codexBlockedUntil(t.topicKey) !== null)) break;
          continue;
        }
        // Timed out waiting — proceed; a multi-candidate fence degrades
        // honestly per the zero-or-one rule (never a blind capture).
        this.audit_({ type: 'codex-fence-wait-timeout', topic: task.topicKey });
      }

      this.inFlightRespawns += 1;
      this.activeRespawnTopics.add(task.topicKey);
      void this.executeRespawn(task)
        .catch((err) => {
          // @silent-fallback-ok: not silent — the failure is recorded to the
          // durable orchestrator audit trail as type:'respawn-error', and the
          // finally below releases the in-flight slot so the queue drains.
          this.audit_({ type: 'respawn-error', topic: task.topicKey, error: String(err) });
        })
        .finally(() => {
          this.inFlightRespawns -= 1;
          this.activeRespawnTopics.delete(task.topicKey);
          void this.drainQueue();
        });
    }
  }

  private codexBlockedUntil(topicKey: string): number | null {
    const resolved = this.deps.resolveProfile(topicKey);
    if (resolved.framework !== 'codex-cli') return null;
    const session = this.deps.sessions.getSessionForTopic(topicKey);
    const cwd = session?.cwd;
    if (!cwd) return null;
    const until = this.codexFenceWindows.get(cwd);
    if (until == null || until <= this.now()) {
      if (until != null) this.codexFenceWindows.delete(cwd);
      return null;
    }
    return until;
  }

  private scheduleDrainWake(at: number): void {
    if (this.drainWakeTimer) return;
    const delay = Math.max(50, at - this.now());
    this.drainWakeTimer = setTimeout(() => {
      this.drainWakeTimer = null;
      void this.drainQueue();
    }, delay);
    this.drainWakeTimer.unref?.();
  }

  /**
   * RESPAWN phase — re-acquire the per-topic lock, re-resolve AT THIS MOMENT,
   * re-confirm idle, then [kill → respawn]. TTL-bounded: a wedged kill/spawn
   * aborts the phase and leaves the divergence to the reconcile sweep.
   */
  private async executeRespawn(task: RespawnTask): Promise<void> {
    const key = task.topicKey;
    try {
      await this.deps.store.withTopicLock(
        key,
        async () => {
          await withTimeout(
            this.respawnPhase(task),
            RESPAWN_PHASE_TTL_MS,
            () => this.audit_({ type: 'respawn-ttl-abort', topic: key }),
          );
        },
        LOCK_ACQUIRE_TIMEOUT_MS,
      );
    } catch (err) {
      if (err instanceof ProfileLockTimeoutError) {
        this.audit_({ type: 'respawn-lock-timeout', topic: key });
        return;
      }
      throw err;
    }
  }

  private async respawnPhase(task: RespawnTask): Promise<void> {
    const key = task.topicKey;
    const slot = this.pendingSlots.get(key);

    // Re-resolve from the cache AT THIS MOMENT (§8 dequeue-time resolution).
    const resolved = this.deps.resolveProfile(key);
    const lastApplied = this.durable.lastApplied[key]?.profile ?? null;

    // Expected-live = resolved baseline ⊕ any active escalation marker (§9 —
    // a session legitimately on the escalated model under `inherit` is never
    // read as divergence).
    if (this.matchesExpectedLive(key, lastApplied, resolved)) {
      if (slot && slot.changeCount > 1 && this.pseudoEquals(slot.preBurst, resolvedToPseudo(resolved))) {
        // Net-unchanged teardown closes its loop out loud (§8).
        const seq = ++this.auditSeq;
        this.deps.disclose(key, this.stamp("you're back where you started — no restart needed", seq), {
          allowDuplicate: true,
          auditSeq: seq,
        });
      }
      this.audit_({ type: 'respawn-skipped', topic: key, reason: 'already-applied' });
      this.teardownSlot(key);
      return;
    }

    const session = this.deps.sessions.getSessionForTopic(key);
    if (!session) {
      // Session gone/replaced — abort spawn-only; the next natural spawn
      // reconciles (the boot sweep is the backstop). §8 round-3 (c).
      this.audit_({ type: 'respawn-skipped', topic: key, reason: 'session-gone' });
      this.teardownSlot(key);
      return;
    }

    const state = this.sessionState(key, session);
    // §14 unconfirmed-attempt choreography: after an in-flight swap returned
    // 'unconfirmed' we never guess again — reclassify with the in-flight row
    // unavailable so the classifier yields the kill+--resume fallback.
    const effectiveState: ProfileSessionState = slot?.forceNoInFlight
      ? { ...state, inFlightSwapConfirmedRecently: false }
      : state;
    const classification = classifyProfileChange(
      appliedToPseudo(lastApplied),
      resolvedToPseudo(resolved),
      effectiveState,
    );

    if (classification.swapMethod === 'none') {
      this.audit_({ type: 'respawn-skipped', topic: key, reason: classification.reason });
      this.teardownSlot(key);
      return;
    }

    // Protected sessions are never profile-killed; "switch now" NEVER
    // overrides protection (§8 round-5) — the in-flight (no-kill) row also
    // defers on a protected session, mirroring FABLE's refusal.
    if (classification.protectedDeferral) {
      this.deferSlot(key, 'protected', () =>
        'this session is protected — unprotect it first, or the switch applies at the next natural restart',
      );
      return;
    }

    const switchNow = task.switchNowOverride || slot?.switchNowOverride === true;

    // §7 in-flight row (Claude modelTier, confirmed-idle, canary passed).
    if (classification.swapMethod === 'in-flight') {
      const tier = resolved.modelTier ?? 'default';
      const swap = await this.deps.inFlightSwap.swap(session.sessionName, tier);
      if (swap.status === 'swapped' || swap.status === 'noop') {
        this.recordApplied(key, resolvedToApplied(resolved));
        this.audit_({ type: 'in-flight-applied', topic: key, tier, status: swap.status });
        this.discloseTerminal(key, slot, resolved, classification.swapMethod, null);
        this.teardownSlot(key);
        return;
      }
      // Unconfirmed/refused: do not guess — the next confirmed-idle window
      // applies the kill+--resume fallback, disclosed (§14 choreography).
      if (slot) slot.forceNoInFlight = true;
      this.deferSlot(key, `in-flight-${swap.status}`, () => null);
      this.audit_({ type: 'in-flight-deferred', topic: key, status: swap.status, reason: swap.reason });
      return;
    }

    // Idle is a precondition re-checked AT KILL TIME inside the lock —
    // unconfirmed is treated as busy (defer), never permission to kill. An
    // active autonomous run is busy regardless of pane state. Only the
    // explicit "switch now" confirm overrides busy/autonomous — never
    // protection (checked above).
    if (classification.deferUntilIdle && !switchNow) {
      this.deferSlot(key, 'busy', () =>
        classification.refuseOrConfirm
          ? "This topic is mid-task right now — switching frameworks would interrupt the running build and lose its in-flight work. I'll apply the switch the moment it goes idle, or say 'switch now' to interrupt."
          : "this topic is mid-task — I'll apply it when this task finishes (checked periodically) or at the next session restart, whichever comes first",
      );
      if (classification.refuseOrConfirm && !this.confirmSlots.has(key)) {
        this.armConfirm(
          key,
          'switch-now',
          'switch now to interrupt the running task',
          async () => this.executeSwitchNow(key),
        );
      }
      return;
    }

    // ── kill → respawn ────────────────────────────────────────────────────
    // Any profile-triggered kill clears the topic's escalation marker and
    // releases its lease BEFORE expected-live is next computed (§8 round-5).
    this.deps.escalation.clearMarkerAndReleaseLease(key);

    let method: SwapMethod = classification.swapMethod;
    let resumeId: string | undefined;
    let lossNote: string | null = null;
    let fresh = classification.freshRespawn;
    const oldFramework = (lastApplied?.framework ?? 'claude-code') as IntelligenceFramework;

    if (method === 'resume' && oldFramework === 'codex-cli') {
      // §7 codex capture-at-kill against the spawn fence — zero-or-one.
      const fence = this.deps.codexFence(key);
      let captured: FenceCaptureResult = { outcome: 'none', candidateCount: 0 };
      if (fence) {
        captured = await this.deps.codexResume.captureAtKill(key, session.sessionName, fence);
      }
      if (captured.outcome === 'captured' && captured.rolloutId) {
        resumeId = captured.rolloutId;
      } else {
        const existing = this.deps.codexResume.get(key);
        if (existing) {
          resumeId = existing;
        } else {
          method = 'continuation';
          fresh = true;
          lossNote =
            "couldn't pin this codex conversation's resume id — continuing with recent history + memory";
          this.audit_({ type: 'codex-capture-degraded', topic: key, outcome: captured.outcome });
        }
      }
    } else if (method === 'resume') {
      // §8 pre-kill verification: the resume entry must exist (hook
      // provenance) BEFORE the kill — absent ⇒ disclose the real loss class
      // up front instead of promising none-loss we cannot deliver.
      resumeId = this.deps.claudeResume.resumeId(key) ?? undefined;
      if (!resumeId && !this.deps.claudeResume.ready(key)) {
        method = 'continuation';
        fresh = true;
        lossNote =
          'no resumable transcript id was captured for this session — continuing with recent history + memory';
        this.audit_({ type: 'claude-resume-degraded', topic: key });
      }
    }

    if (fresh) {
      // Park BOTH resume stores' entries BEFORE the kill (park, not delete —
      // §8 round-5) and set the topic-scoped, time-bounded durable
      // suppression marker so no save-on-kill writer re-persists a stale id.
      this.deps.claudeResume.park(key, 'mid-framework-switch');
      this.deps.codexResume.park(key, 'mid-framework-switch');
      this.setSuppression(key);
      await this.deps.sessions.killFresh(session.sessionName);
    } else {
      await this.deps.sessions.killForResume(session.sessionName);
    }

    const outcome = await this.deps.sessions.spawn(key, resolved, { method, resumeId });
    if (outcome.ok) {
      const applied = outcome.applied ?? resolvedToApplied(resolved);
      this.recordApplied(key, applied);
      this.clearSuppression(key);
      if (resolved.framework === 'codex-cli') {
        const cwd = this.deps.sessions.getSessionForTopic(key)?.cwd ?? session.cwd;
        this.codexFenceWindows.set(cwd, this.now() + RESPAWN_PHASE_TTL_MS);
      }
      this.discloseTerminal(key, slot, appliedToResolvedForDisclosure(resolved, applied), method, lossNote);
      this.audit_({ type: 'respawn-applied', topic: key, method, fresh, breakerRevert: task.breakerRevert });
    } else {
      this.recordSpawnFailureInternal(key, outcome.failureClass ?? 'unknown');
      this.audit_({ type: 'respawn-spawn-failed', topic: key, failureClass: outcome.failureClass ?? 'unknown' });
    }
    this.teardownSlot(key);
  }

  private deferSlot(key: string, reason: string, text: () => string | null): void {
    let slot = this.pendingSlots.get(key);
    if (!slot) {
      // A boot-sweep/breaker task can defer with no prior write slot.
      slot = {
        timer: null,
        preBurst: null,
        changeCount: 1,
        origins: new Set(['system']),
        frameworkArm: false,
        deferred: false,
        forceNoInFlight: false,
        disclosedDefer: new Set(),
        switchNowOverride: false,
      };
      this.pendingSlots.set(key, slot);
    }
    slot.deferred = true;
    slot.deferredReason = reason;
    const t = text();
    if (t && !slot.disclosedDefer.has(reason)) {
      slot.disclosedDefer.add(reason);
      const seq = ++this.auditSeq;
      this.deps.disclose(key, this.stamp(t, seq), { allowDuplicate: true, auditSeq: seq });
    }
    this.audit_({ type: 'respawn-deferred', topic: key, reason });
  }

  private teardownSlot(key: string): void {
    const slot = this.pendingSlots.get(key);
    if (slot?.timer) clearTimeout(slot.timer);
    this.pendingSlots.delete(key);
    // A confirm armed for this pending change expires with the slot.
    const confirm = this.confirmSlots.get(key);
    if (confirm?.kind === 'switch-now') this.confirmSlots.delete(key);
  }

  /** Terminal disclosure: coalesced burst delta + the honest swap line. */
  private discloseTerminal(
    key: string,
    slot: PendingSlot | undefined,
    resolved: ResolvedTopicProfile,
    method: SwapMethod,
    lossNote: string | null,
  ): void {
    const parts: string[] = [];
    if (slot && slot.changeCount > 1) {
      const was = renderProfileShort(slot.preBurst);
      const now = renderProfileShort(resolvedToPseudo(resolved));
      parts.push(
        `was: ${was} → now: ${now} (${slot.changeCount} changes, origins: ${[...slot.origins].join(', ')})`,
      );
    }
    parts.push(
      `Now driving this topic: ${renderDoor(resolved.framework)} door, ${resolved.model ?? 'account-default'} model.`,
    );
    if (method === 'continuation') {
      parts.push(
        `The full transcript can't follow across that boundary, so I'm carrying recent history + memory — continuing from there.`,
      );
    }
    if (lossNote) parts.push(lossNote);
    if (parts.length === 0) return;
    const seq = ++this.auditSeq;
    this.deps.disclose(key, this.stamp(parts.join(' '), seq), { allowDuplicate: true, auditSeq: seq });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // "switch now" / confirm slot (§8 / §10.1(c) / §10.4 — ONE armed slot)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Arm a confirm. All three confirm surfaces (switch-now, propose-confirm,
   * cooldown-reapply) share THIS one slot per topic: arming supersedes the
   * prior armed confirm (the §10.1(c) re-echo discipline — a bare "yes" can
   * only ever fire the most-recently-echoed confirm). Re-proposals are
   * rate-bounded; churn past the bound tears the slot down for a cooldown
   * and is audited as a suspicion signal.
   */
  armConfirm(topicKey: number | string, kind: ConfirmKind, echo: string, run: () => Promise<string>): boolean {
    const key = String(topicKey);
    const now = this.now();
    const cooldownUntil = this.confirmArmCooldownUntil.get(key) ?? 0;
    if (now < cooldownUntil) {
      this.audit_({ type: 'confirm-arm-refused', topic: key, reason: 'arm-rate-cooldown' });
      return false;
    }
    const times = (this.confirmArmTimes.get(key) ?? []).filter((t) => now - t < CONFIRM_ARM_RATE_WINDOW_MS);
    times.push(now);
    this.confirmArmTimes.set(key, times);
    if (times.length > CONFIRM_ARM_RATE_CAP) {
      this.confirmSlots.delete(key);
      this.confirmArmCooldownUntil.set(key, now + CONFIRM_ARM_RATE_WINDOW_MS);
      this.audit_({ type: 'confirm-arm-churn', topic: key, suspicion: true });
      return false;
    }
    const prior = this.confirmSlots.get(key);
    if (prior) this.audit_({ type: 'confirm-superseded', topic: key, prior: prior.kind, next: kind });
    this.confirmSlots.set(key, {
      kind,
      echo,
      armedAt: now,
      expiresAt: now + this.cfg().switchNowConfirmTtlMs,
      run,
    });
    this.audit_({ type: 'confirm-armed', topic: key, kind });
    return true;
  }

  /** Record the platform message id of the rendered echo (§10.1 ordering). */
  attachConfirmEchoMessageId(topicKey: number | string, messageId: number): void {
    const slot = this.confirmSlots.get(String(topicKey));
    if (slot) slot.echoMessageId = messageId;
  }

  /**
   * Fire the armed confirm. The caller (server-side ingress parse) has
   * already established first-party origin + forward-metadata exclusion;
   * this enforces TTL, supersession, and the platform-message-id ordering
   * when ids are available (a confirm answering a superseded/older echo is
   * refused toward re-echo).
   */
  async fireConfirm(
    topicKey: number | string,
    opts: { messageId?: number } = {},
  ): Promise<{ fired: boolean; reply: string }> {
    const key = String(topicKey);
    const slot = this.confirmSlots.get(key);
    if (!slot) {
      return { fired: false, reply: 'nothing is pending confirmation right now' };
    }
    if (this.now() > slot.expiresAt) {
      this.confirmSlots.delete(key);
      return { fired: false, reply: 'that proposal has expired — say what you want again' };
    }
    if (slot.echoMessageId != null && opts.messageId != null && opts.messageId <= slot.echoMessageId) {
      return {
        fired: false,
        reply: `I re-proposed — please confirm the new version: ${slot.echo}`,
      };
    }
    this.confirmSlots.delete(key);
    this.audit_({ type: 'confirm-fired', topic: key, kind: slot.kind });
    const reply = await slot.run();
    return { fired: true, reply };
  }

  /** The currently-armed confirm echo (readout / re-echo surfaces). */
  armedConfirm(topicKey: number | string): { kind: ConfirmKind; echo: string } | null {
    const slot = this.confirmSlots.get(String(topicKey));
    if (!slot || this.now() > slot.expiresAt) return null;
    return { kind: slot.kind, echo: slot.echo };
  }

  /**
   * Operator's "switch now" — overrides busy/autonomous deferral for the
   * SPECIFIC pending change that armed it. NEVER overrides protection.
   * With no armed pending switch this is a no-op with a plain reply.
   */
  async handleSwitchNow(topicKey: number | string): Promise<{ fired: boolean; reply: string }> {
    const key = String(topicKey);
    const slot = this.confirmSlots.get(key);
    if (!slot || slot.kind !== 'switch-now') {
      return { fired: false, reply: 'there is no pending switch to apply right now' };
    }
    return this.fireConfirm(key);
  }

  private async executeSwitchNow(key: string): Promise<string> {
    const slot = this.pendingSlots.get(key);
    if (!slot) return 'that switch already applied (or was withdrawn) — nothing to do';
    // Protection re-check happens inside the respawn phase — switch-now
    // never overrides it (§8 round-5).
    slot.switchNowOverride = true;
    if (slot.timer) {
      clearTimeout(slot.timer);
      slot.timer = null;
    }
    this.enqueueRespawn({
      topicKey: key,
      breakerRevert: false,
      switchNowOverride: true,
      enqueuedAt: this.now(),
    });
    return 'switching now — interrupting the running task as you asked';
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Spawn-outcome intake — §10.4 breaker (LIVE in every regime)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Called at EVERY successful spawn (natural, sentinel, or profile-triggered;
   * wiring obligation on the spawn path): records the last-applied-profile
   * marker (durable — the boot sweep compares against it across restarts),
   * resets the breaker counter, clears any suppression, and registers the
   * codex fence window for same-cwd serialization.
   */
  recordSpawnSuccess(topicKey: number | string, applied: AppliedProfile, opts: { cwd?: string } = {}): void {
    const key = String(topicKey);
    this.recordApplied(key, applied);
    void this.deps.store.resetBreaker(key).catch(() => {});
    this.clearSuppression(key);
    if (applied.framework === 'codex-cli' && opts.cwd) {
      this.codexFenceWindows.set(opts.cwd, this.now() + RESPAWN_PHASE_TTL_MS);
    }
  }

  /**
   * Called on a failed spawn attempt for a topic, from ANY path — including
   * the legacy `/route` respawn (§10.4: legacy-path failures count when
   * attributable; the breaker is never dormant).
   */
  recordSpawnFailure(topicKey: number | string, failureClass: ProfileSpawnFailureClass): void {
    this.recordSpawnFailureInternal(String(topicKey), failureClass);
  }

  private recordSpawnFailureInternal(key: string, failureClass: ProfileSpawnFailureClass): void {
    if (!BREAKER_ATTRIBUTABLE.has(failureClass)) {
      // Ambient classes never increment — an unattributed counter would turn
      // any outage into a silent override of operator authority.
      this.audit_({ type: 'spawn-failure-ambient', topic: key, failureClass });
      return;
    }
    const current = this.deps.store.resolve(key);
    if (!current) {
      // No pin — nothing to attribute the failure TO (default profile
      // failures are not the breaker's business).
      this.audit_({ type: 'spawn-failure-no-pin', topic: key, failureClass });
      return;
    }
    void this.deps.store
      .incrementBreaker(key)
      .then((count) => {
        this.audit_({ type: 'breaker-increment', topic: key, failureClass, count });
        if (count >= this.cfg().spawnFailureBreakerThreshold) {
          return this.tripBreaker(key, failureClass);
        }
        return undefined;
      })
      .catch((err) => this.audit_({ type: 'breaker-error', topic: key, error: String(err) }));
  }

  /**
   * §10.4 trip: park the failing profile intended-but-unhealthy, revert to
   * last-known-good (or the global default), un-park the matching-framework
   * resume entry (the revert is none-loss when the transcript survives),
   * notify, audit system:circuit-breaker, and respawn IMMEDIATELY — the one
   * keep-working exception, live in EVERY regime.
   */
  private async tripBreaker(key: string, failureClass: ProfileSpawnFailureClass): Promise<void> {
    const failing = this.deps.store.resolve(key);
    const lastKnownGood = this.deps.store.previousFor(key);
    await this.deps.store.parkAndRevert(
      key,
      `spawn-failure-breaker:${failureClass}`,
      lastKnownGood,
    );
    // Remember the tripped profile for the re-apply cooldown confirm.
    if (failing) {
      this.durable.breakerTrips[key] = {
        profileKey: profileKeyOf(failing),
        at: new Date(this.now()).toISOString(),
      };
      this.saveDurable();
    }
    // Un-park the matching-framework resume entry so the revert resumes the
    // surviving transcript instead of CONTINUATION'ing.
    const revertFramework = (lastKnownGood?.framework ?? 'claude-code') as IntelligenceFramework;
    if (revertFramework === 'codex-cli') this.deps.codexResume.unpark(key);
    else this.deps.claudeResume.unpark(key);

    const seq = ++this.auditSeq;
    this.audit_({
      type: 'breaker-revert',
      topic: key,
      principal: 'system:circuit-breaker',
      failureClass,
      seq,
      revertedTo: renderProfileShort(lastKnownGood),
    });
    this.deps.disclose(
      key,
      this.stamp(
        "Couldn't launch with the requested profile — reverting this topic to its last working settings to keep it usable. Your pin is parked; say re-apply when it's fixed.",
        seq,
      ),
      { allowDuplicate: true, auditSeq: seq },
    );

    // Immediate keep-working respawn — exempt from regime gating AND from
    // the debounce (a failing profile means the session is already down).
    this.enqueueRespawn({
      topicKey: key,
      breakerRevert: true,
      switchNowOverride: false,
      enqueuedAt: this.now(),
    });
  }

  /** Marks a topic's codex capture fence resolved (rollout observed). */
  markCodexFenceResolved(cwd: string): void {
    this.codexFenceWindows.delete(cwd);
    void this.drainQueue();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Periodic tick + boot reconcile sweep (§8)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Piggybacks an existing periodic cadence (reaper/watchdog — no per-topic
   * pollers): retries deferred (busy-abort) swaps and re-checks the dry-run
   * flip lever.
   */
  tick(): void {
    this.checkDryRunFlip();
    for (const [key, slot] of this.pendingSlots) {
      if (slot.deferred && slot.timer === null && !this.activeRespawnTopics.has(key)) {
        slot.deferred = false;
        this.enqueueRespawn({
          topicKey: key,
          breakerRevert: false,
          switchNowOverride: slot.switchNowOverride,
          enqueuedAt: this.now(),
        });
      }
    }
    // Expire stale suppressions (time-bounded by construction).
    let changed = false;
    for (const [key, until] of Object.entries(this.durable.suppressions)) {
      if (Date.parse(until) <= this.now()) {
        delete this.durable.suppressions[key];
        changed = true;
      }
    }
    if (changed) this.saveDurable();
  }

  /**
   * Boot-time reconcile sweep (§8 round-3): the pending slot is
   * process-local, but tmux sessions and the store survive a restart
   * mid-debounce. Compares each live topic-bound session's last-applied
   * profile against the store (⊕ escalation marker) and arms the normal
   * debounced, idle-gated respawn on divergence — in the fully-live regime.
   * In gated regimes divergence is audited and left to the next natural
   * spawn (no profile-triggered kill outside fully-live, §5.2(b)).
   * Stale escalation markers (session gone) are cleared FIRST.
   */
  bootReconcileSweep(): void {
    const cfg = this.cfg();
    const live = this.deps.sessions.listTopicSessions();
    const liveKeys = new Set(live.map((s) => s.topicKey));

    // Stale-marker clear BEFORE computing expected-live (§8 round-5).
    for (const markerTopic of this.deps.escalation.listMarkerTopics()) {
      if (!liveKeys.has(markerTopic)) {
        this.deps.escalation.clearMarkerAndReleaseLease(markerTopic);
        this.audit_({ type: 'stale-escalation-marker-cleared', topic: markerTopic });
      }
    }

    const divergent: string[] = [];
    for (const { topicKey } of live) {
      const resolved = this.deps.resolveProfile(topicKey);
      const lastApplied = this.durable.lastApplied[topicKey]?.profile ?? null;
      if (!this.matchesExpectedLive(topicKey, lastApplied, resolved)) {
        divergent.push(topicKey);
      }
    }

    for (const topicKey of divergent) {
      if (cfg.enabled && !cfg.dryRun) {
        this.armRespawn(topicKey, cfg.respawnDebounceMs, {
          frameworkArm: false,
          preBurst: null,
          origin: 'system',
        });
        const seq = ++this.auditSeq;
        this.deps.disclose(
          topicKey,
          this.stamp(
            "this topic's pinned profile wasn't applied before my last restart — applying it now (the session will briefly restart when idle)",
            seq,
          ),
          { allowDuplicate: true, auditSeq: seq },
        );
        this.audit_({ type: 'boot-sweep-armed', topic: topicKey, seq });
      } else {
        this.audit_({ type: 'boot-sweep-divergence-observed', topic: topicKey, regime: 'gated' });
      }
    }
  }

  /**
   * §14 — the dryRun true→false flip clears EVERY topic's shadow (intents
   * are NEVER promoted, at the flip or ever) and surfaces the expired
   * would-be intents ONCE as a single coalesced notice.
   */
  checkDryRunFlip(): void {
    const dryRun = this.cfg().dryRun;
    const prior = this.lastSeenDryRun;
    this.lastSeenDryRun = dryRun;
    if (prior === true && dryRun === false) {
      void this.deps.store.clearAllShadows().then((cleared) => {
        if (cleared.length === 0) return;
        const seq = ++this.auditSeq;
        const list = cleared
          .map((c) => `topic ${c.topicKey}: ${renderPatch(c.shadow.fields as ValidatedProfilePatch)}`)
          .join('; ');
        // One coalesced notice — delivered to each affected topic's
        // conversation so every recorded intent's owner sees it once.
        for (const c of cleared) {
          this.deps.disclose(
            c.topicKey,
            this.stamp(
              `dry-run ended — these recorded intents were never applied; re-issue any you still want: ${list}`,
              seq,
            ),
            { allowDuplicate: true, auditSeq: seq },
          );
        }
        this.audit_({ type: 'dry-run-flip-cleared-shadows', count: cleared.length, seq });
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // §9 escalation interplay + resume-writer gates
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Lock pass-through for the escalation authority (§5.1/§9): an escalation
   * swap serializes its live-session mutation through the SAME per-topic
   * lock — ordering, not shared fields (it writes only its own marker and
   * NEVER arms the respawn debounce).
   */
  runExclusive<T>(topicKey: number | string, fn: () => Promise<T> | T): Promise<T> {
    return this.deps.store.withTopicLock(topicKey, fn);
  }

  /**
   * §8 resume-writer gates — install via TopicResumeMap.setWriteGate /
   * the codex map's wiring. A writer may persist a Claude UUID only for a
   * topic whose resolved framework IS claude-code and that is not
   * mid-framework-switch (the durable suppression marker).
   */
  claudeResumeWriteGate(topicId: number | string): { allowed: boolean; reason?: string } {
    const key = String(topicId);
    if (this.suppressionActive(key)) {
      return { allowed: false, reason: 'mid-framework-switch' };
    }
    const resolved = this.deps.resolveProfile(key);
    if (resolved.framework !== 'claude-code') {
      return { allowed: false, reason: `resolved framework is ${resolved.framework}` };
    }
    return { allowed: true };
  }

  codexResumeWriteGate(topicId: number | string): { allowed: boolean; reason?: string } {
    const key = String(topicId);
    if (this.suppressionActive(key)) {
      return { allowed: false, reason: 'mid-framework-switch' };
    }
    const resolved = this.deps.resolveProfile(key);
    if (resolved.framework !== 'codex-cli') {
      return { allowed: false, reason: `resolved framework is ${resolved.framework}` };
    }
    return { allowed: true };
  }

  /** Introspection (readout / tests). */
  pendingFor(topicKey: number | string): { deferred: boolean; changeCount: number } | null {
    const slot = this.pendingSlots.get(String(topicKey));
    if (!slot) return null;
    return { deferred: slot.deferred, changeCount: slot.changeCount };
  }

  suppressionActive(topicKey: number | string): boolean {
    const until = this.durable.suppressions[String(topicKey)];
    return until != null && Date.parse(until) > this.now();
  }

  /** Clear timers (tests / shutdown). */
  dispose(): void {
    for (const slot of this.pendingSlots.values()) {
      if (slot.timer) clearTimeout(slot.timer);
    }
    this.pendingSlots.clear();
    for (const o of this.overflow.values()) clearTimeout(o.timer);
    this.overflow.clear();
    if (this.drainWakeTimer) clearTimeout(this.drainWakeTimer);
    this.drainWakeTimer = null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // §14 shadow observation (legacy-served switches under enabled && dryRun)
  // ───────────────────────────────────────────────────────────────────────────

  private shadowObserveSwitch(key: string, pre: TopicProfile | null, post: TopicProfile | null): void {
    const session = this.deps.sessions.getSessionForTopic(key);
    if (!session) {
      this.audit_({ type: 'dry-run-shadow-decision', topic: key, decision: 'no-live-session — would apply at next spawn' });
      return;
    }
    const state = this.sessionState(key, session);
    const classification = classifyProfileChange(pre, post, state);
    this.audit_({
      type: 'dry-run-shadow-decision',
      topic: key,
      decision: classification.refuseOrConfirm
        ? 'would refuse-until-idle (busy framework switch)'
        : classification.deferUntilIdle
          ? 'would defer until idle'
          : `would ${classification.swapMethod} after ${this.cfg().frameworkSwitchDebounceMs}ms debounce`,
      swapMethod: classification.swapMethod,
      expectedLoss: classification.expectedLoss,
      wouldPark: classification.freshRespawn,
      maturationSignal: true,
      feature: 'topic-profile',
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Disclosure accounting (§8 — coalescing + rate cap + undo cadence)
  // ───────────────────────────────────────────────────────────────────────────

  private discloseWrite(
    key: string,
    text: string,
    seq: number,
    attribution: ProfileWriteAttribution,
    info: { slotActive: boolean },
  ): void {
    if (info.slotActive) {
      // Coalesces into the pending slot's terminal disclosure — the burst's
      // single delta-carrying notice covers this write.
      return;
    }
    const now = this.now();
    const times = (this.disclosureTimes.get(key) ?? []).filter((t) => now - t < DISCLOSURE_RATE_WINDOW_MS);

    const existingOverflow = this.overflow.get(key);
    if (existingOverflow) {
      existingOverflow.count += 1;
      existingOverflow.origins.add(attribution.origin);
      return;
    }
    if (times.length >= DISCLOSURE_RATE_CAP) {
      // Enter the overflow period — itself treated as a disclosed burst for
      // the undo shift (the FIRST overflow write captured `previous`).
      const timer = setTimeout(() => this.flushOverflow(key), DISCLOSURE_RATE_WINDOW_MS);
      timer.unref?.();
      this.overflow.set(key, {
        count: 1,
        origins: new Set([attribution.origin]),
        preOverflow: this.deps.store.previousFor(key),
        timer,
      });
      return;
    }
    times.push(now);
    this.disclosureTimes.set(key, times);
    const originNote = attribution.origin === 'http' ? ' (profile changed via API)' : '';
    this.deps.disclose(key, this.stamp(text + originNote, seq), { allowDuplicate: true, auditSeq: seq });
  }

  private flushOverflow(key: string): void {
    const o = this.overflow.get(key);
    if (!o) return;
    this.overflow.delete(key);
    const seq = ++this.auditSeq;
    const final = this.deps.store.resolve(key);
    // Delta-carrying summary (§8 round-9): was → now, count, origins.
    this.deps.disclose(
      key,
      this.stamp(
        `was: ${renderProfileShort(o.preOverflow)} → now: ${renderProfileShort(final)} (${o.count} changes, origins: ${[...o.origins].join(', ')})`,
        seq,
      ),
      { allowDuplicate: true, auditSeq: seq },
    );
    this.audit_({ type: 'disclosure-overflow-summary', topic: key, count: o.count, seq });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // internals
  // ───────────────────────────────────────────────────────────────────────────

  private cfg(): OrchestratorConfig {
    return this.deps.getConfig();
  }

  private stamp(text: string, seq: number): string {
    // §8 — disclosures carry the audit sequence/timestamp in the rendered
    // text so the relay's exact-duplicate window can never silently swallow
    // a repeat notice.
    return `${text} [#${seq}]`;
  }

  private audit_(event: Record<string, unknown>): void {
    try {
      this.deps.audit({ ts: new Date(this.now()).toISOString(), source: 'topic-profile-orchestrator', ...event });
    } catch {
      // best-effort — never throws into the orchestration path
    }
  }

  private sessionState(key: string, session: OrchTopicSession): ProfileSessionState {
    const v = this.deps.verification();
    return {
      exists: true,
      idle: this.deps.sessions.readIdle(session.sessionName),
      autonomousActive: this.deps.autonomousActive(key),
      isProtected: this.deps.isProtectedSession(session.sessionName),
      claudeResumeReady: this.deps.claudeResume.ready(key),
      codexRolloutCaptured:
        this.deps.codexResume.get(key) !== null || this.deps.codexFence(key) !== null,
      inFlightSwapConfirmedRecently: v.inFlightSwapConfirmedRecently,
      thinkingOffOnResumeVerified: v.thinkingOffOnResumeVerified,
      thinkingLevelResumeVerified: v.thinkingLevelResumeVerified,
      crossModelResumeVerified: v.crossModelResumeVerified,
      claudeThinkingControlAvailable: v.claudeThinkingControlAvailable,
    };
  }

  private matchesExpectedLive(
    key: string,
    lastApplied: AppliedProfile | null,
    resolved: ResolvedTopicProfile,
  ): boolean {
    if (!lastApplied) return false;
    const base = resolvedToApplied(resolved);
    if (appliedEquals(lastApplied, base)) return true;
    const marker = this.deps.escalation.activeMarker(key);
    if (marker) {
      const overlay: AppliedProfile = { ...base, model: marker.model, modelTier: null };
      if (appliedEquals(lastApplied, overlay)) return true;
    }
    return false;
  }

  private pseudoEquals(a: TopicProfile | null, b: TopicProfile | null): boolean {
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;
    return PROFILE_AXES.every((f) => (a[f] ?? null) === (b[f] ?? null));
  }

  private recordApplied(key: string, applied: AppliedProfile): void {
    this.durable.lastApplied[key] = { profile: applied, at: new Date(this.now()).toISOString() };
    this.saveDurable();
  }

  private setSuppression(key: string): void {
    this.durable.suppressions[key] = new Date(this.now() + SUPPRESSION_TTL_MS).toISOString();
    this.saveDurable();
  }

  private clearSuppression(key: string): void {
    if (this.durable.suppressions[key]) {
      delete this.durable.suppressions[key];
      this.saveDurable();
    }
  }

  private loadDurable(): void {
    try {
      if (fs.existsSync(this.deps.stateFilePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.deps.stateFilePath, 'utf-8')) as Partial<DurableSideState>;
        this.durable = {
          lastApplied: parsed.lastApplied && typeof parsed.lastApplied === 'object' ? parsed.lastApplied : {},
          suppressions: parsed.suppressions && typeof parsed.suppressions === 'object' ? parsed.suppressions : {},
          breakerTrips: parsed.breakerTrips && typeof parsed.breakerTrips === 'object' ? parsed.breakerTrips : {},
        };
      }
    } catch (err) {
      console.warn(`[TopicProfileOrchestrator] Failed to load ${this.deps.stateFilePath}: ${err}`);
    }
  }

  private saveDurable(): void {
    try {
      const dir = path.dirname(this.deps.stateFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.deps.stateFilePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.durable, null, 2), 'utf-8');
      fs.renameSync(tmp, this.deps.stateFilePath);
    } catch (err) {
      console.warn(`[TopicProfileOrchestrator] Failed to persist side-state: ${err}`);
      DegradationReporter.getInstance().report({
        feature: 'TopicProfileOrchestrator.saveDurable',
        primary: 'Persist orchestrator side-state (lastApplied, disclosure suppressions, breaker trips)',
        fallback: 'Continue with in-memory state only; the file stays stale until the next successful save',
        reason: `Side-state write failed: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'A restart before the next successful save loses breaker-trip history and disclosure dedupe (duplicate notices, reset breakers)',
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers (pure)
// ─────────────────────────────────────────────────────────────────────────────

function isClearOnlyPatch(patch: ValidatedProfilePatch): boolean {
  const supplied = PROFILE_AXES.filter((f) => patch[f] !== undefined);
  return supplied.length > 0 && supplied.every((f) => patch[f] === null);
}

/** Convert the launch-applied characteristics into a classifier pseudo-profile. */
function appliedToPseudo(applied: AppliedProfile | null): TopicProfile | null {
  if (!applied) return null;
  return {
    framework: applied.framework,
    model: applied.modelTier ? null : applied.model,
    modelTier: applied.modelTier,
    thinkingMode: applied.thinkingMode,
    effort: applied.effort,
    updatedAt: '',
    updatedBy: '',
  };
}

function resolvedToPseudo(resolved: ResolvedTopicProfile): TopicProfile {
  return {
    framework: resolved.framework,
    model: resolved.modelTier ? null : (resolved.model ?? null),
    modelTier: resolved.modelTier ?? null,
    thinkingMode: resolved.thinkingMode ?? null,
    effort: resolved.effort ?? null,
    updatedAt: '',
    updatedBy: '',
  };
}

function appliedToResolvedForDisclosure(
  resolved: ResolvedTopicProfile,
  applied: AppliedProfile,
): ResolvedTopicProfile {
  return {
    ...resolved,
    framework: applied.framework,
    model: applied.model ?? undefined,
    modelTier: applied.modelTier,
    thinkingMode: applied.thinkingMode ?? undefined,
    effort: applied.effort ?? undefined,
  };
}

function renderDoor(framework: IntelligenceFramework): string {
  if (framework === 'codex-cli') return 'Codex';
  if (framework === 'claude-code') return 'Claude';
  if (framework === 'gemini-cli') return 'Gemini';
  return 'Pi';
}

/** The characteristics a spawn against this resolution applies. */
export function resolvedToApplied(resolved: ResolvedTopicProfile): AppliedProfile {
  return {
    framework: resolved.framework,
    model: resolved.modelTier ? null : (resolved.model ?? null),
    modelTier: resolved.modelTier ?? null,
    thinkingMode: resolved.thinkingMode ?? null,
    effort: resolved.effort ?? null,
  };
}

function appliedEquals(a: AppliedProfile, b: AppliedProfile): boolean {
  return (
    a.framework === b.framework &&
    (a.model ?? null) === (b.model ?? null) &&
    (a.modelTier ?? null) === (b.modelTier ?? null) &&
    (a.thinkingMode ?? null) === (b.thinkingMode ?? null) &&
    (a.effort ?? null) === (b.effort ?? null)
  );
}

/** Identity key for the §10.4 cooldown-confirm "same profile" check. */
function profileKeyOf(p: TopicProfile): string {
  return PROFILE_AXES.map((f) => `${f}=${p[f] ?? ''}`).join('|');
}

function renderPatch(patch: ValidatedProfilePatch): string {
  const parts: string[] = [];
  for (const f of PROFILE_AXES) {
    if (patch[f] === undefined) continue;
    parts.push(patch[f] === null ? `${f} cleared` : `${f}: ${String(patch[f])}`);
  }
  return parts.length > 0 ? parts.join(', ') : 'profile';
}

function renderProfileShort(p: TopicProfile | null): string {
  if (!p) return 'defaults';
  const parts: string[] = [];
  for (const f of PROFILE_AXES) {
    const v = p[f];
    if (v != null) parts.push(`${f}=${String(v)}`);
  }
  return parts.length > 0 ? parts.join(' ') : 'defaults';
}

/** TTL race — on timeout the phase logically aborts (lock released by return). */
async function withTimeout(p: Promise<void>, ms: number, onTimeout: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<'timeout'>((res) => {
    timer = setTimeout(() => res('timeout'), ms);
    timer.unref?.();
  });
  const result = await Promise.race([p.then(() => 'done' as const), timeout]);
  if (timer) clearTimeout(timer);
  if (result === 'timeout') onTimeout();
}
