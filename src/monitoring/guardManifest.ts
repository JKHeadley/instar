/**
 * guardManifest — the STATIC DECLARED MANIFEST of every guard this codebase
 * ships (GUARD-POSTURE-ENDPOINT-SPEC §2.1).
 *
 * The authoritative discovery boundary for the /guards inventory: the shared
 * extractor (guardPosture.ts) covers config-shaped guards generically; this
 * manifest declares the rest — guards with no config key at all (default-ON
 * in code), guards living outside `monitoring.*`, sub-guards that must not
 * hide inside an on-confirmed parent, and out-of-process (lifeline) guards —
 * plus per-guard metadata the honest-state derivation needs (expected tick
 * cadence for staleness, liveConfig divergence suppression, dry-run paths).
 *
 * The companion `NOT_A_GUARD` list classifies every other boot-constructed
 * component that LOOKS guard-shaped but deliberately is not in the inventory,
 * with a reason. scripts/lint-guard-manifest.js enforces that every candidate
 * component appears in exactly one of the two lists — a future guard cannot
 * be forgotten (Structure > Willpower; the lint follows the
 * lint-dev-agent-dark-gate.js + exclusions-list precedent).
 */

export type GuardKind = 'config' | 'code-default';
export type GuardProcess = 'server' | 'lifeline';

export interface GuardManifestEntry {
  /** Canonical inventory key (matches the shared extractor's key where both cover a guard). */
  key: string;
  kind: GuardKind;
  /** kind 'config': dotted path to the enabled boolean in the agent config. */
  configPath?: string;
  /** kind 'code-default': the shipped in-code value. Also the fallback default
   *  for kind 'config' guards whose default is deliberately OMITTED from
   *  ConfigDefaults (runtime-fallback pattern, e.g. contextWedge autoRecovery). */
  defaultEnabled: boolean;
  /** Dotted path to a dry-run flag, when the guard has one. */
  dryRunConfigPath?: string;
  /** Self-declared tick cadence; staleness threshold = 5 × this (spec §2.2). */
  expectedTickMs?: number;
  /** Component re-reads config per use → `diverged-pending-restart` is
   *  SUPPRESSED (the change is already live; the state would lie). */
  liveConfig?: boolean;
  process: GuardProcess;
  /** True only where the component ACTUALLY self-registers a runtime getter
   *  into the GuardRegistry at boot. An enabled guard with expectRuntime that
   *  registered nothing reports `missing` (reconciliation, spec §2.1). Keep
   *  this exactly in sync with the registration callsites — an aspirational
   *  `true` here manufactures phantom `missing` rows. */
  expectRuntime: boolean;
  /** Implementing component (class/module name) — the lint's join key. */
  component?: string;
  description: string;
  // ── G3: dark-but-load-bearing classification (g3-dark-but-load-bearing-guards) ──
  /** A CRITICAL PATH depends on this guard — a silent-unguarded posture is a
   *  visible gap, not quiet (the "A Dark Feature Guards Nothing" arm). */
  loadBearing?: boolean;
  /** REQUIRED when loadBearing — the path the guard protects (e.g. "operator
   *  inbound message delivery"). Travels on EVERY anomaly of a load-bearing guard. */
  criticalPath?: string;
  /** Graduated-rollout soak budget, days from declaredLoadBearingAt (manifest
   *  constant). 0/absent ⇒ no grace → an on-dry-run guard is immediately a Gap. */
  soakWindowDays?: number;
  /** ISO date the loadBearing flag was added (manifest constant). REQUIRED +
   *  valid-ISO when soakWindowDays>0; absent/malformed at runtime ⇒ the soak
   *  clause cannot be evaluated → the guard falls to the loud Gap (safe/loud). */
  declaredLoadBearingAt?: string;
}

export const GUARD_MANIFEST: readonly GuardManifestEntry[] = [
  // ── Durable Inbound Message Queue (spec §Observability; keys === configPath) ──
  {
    key: 'multiMachine.sessionPool.inboundQueue.enabled',
    kind: 'config',
    configPath: 'multiMachine.sessionPool.inboundQueue.enabled',
    defaultEnabled: false,
    dryRunConfigPath: 'multiMachine.sessionPool.inboundQueue.dryRun',
    expectedTickMs: 15_000,
    process: 'server',
    expectRuntime: false,
    component: 'QueueDrainLoop',
    description: 'Durable custody for undeliverable inbound messages + the drain that delivers them (ships dark).',
    // G3 load-bearing (g3-dark-but-load-bearing-guards, Decision 2): the durable
    // inbound-message custody + drain sits directly on the OPERATOR MESSAGE
    // DELIVERY path the 2026-07-01 silent-loss postmortem named. Ships dry-run-first
    // (enabled:true,dryRun:true), so a graduating agent SOAKS for the window; a
    // fully-dark agent is a loud loadBearingGap (force a decision: graduate or
    // record an owned accept).
    loadBearing: true,
    criticalPath: 'operator inbound message delivery (durable custody + drain for undeliverable inbound messages)',
    soakWindowDays: 30,
    declaredLoadBearingAt: '2026-07-01',
  },
  // ── U4.1 — WS1.3 pin persistence (docs/specs/u4-1-pin-persistence.md §2A) ──
  // ── Standby-Write Reconciliation (docs/specs/standby-write-reconciliation.md §3.5) ──
  {
    key: 'writeAdmission',
    kind: 'config',
    configPath: 'multiMachine.writeAdmission.enabled',
    // Dev-gated: `enabled` OMITTED from ConfigDefaults (resolveDevAgentGate) —
    // dark-default on the fleet, live on a development agent, dry-run FIRST.
    defaultEnabled: false,
    dryRunConfigPath: 'multiMachine.writeAdmission.dryRun',
    process: 'server',
    expectRuntime: false,
    component: 'WriteAdmission',
    description: 'Ownership-scoped write admission + typed refusal (standby-write reconciliation): classifies every write into a domain and admits or typed-refuses in <2s instead of the blanket standby boolean. Dry-run first — the LEGACY blanket guard keeps enforcing until dryRun:false AND the wave-2 inventory ladder gate.',
    // §3.5: loadBearing stays FALSE while the legacy blanket guard remains the
    // enforcing layer — re-reviewed (and expected flipped) at fleet
    // graduation, when the legacy guard's authority is subsumed.
    loadBearing: false,
  },
  {
    key: 'multiMachine.seamlessness.ws13Reconcile',
    kind: 'config',
    configPath: 'multiMachine.seamlessness.ws13Reconcile',
    // Dev-gated: `enabled` OMITTED from ConfigDefaults (resolveDevAgentGate) —
    // dark-default on the fleet, live on a development agent. ws13DryRun is the
    // in-component "log intended CAS without performing it" rung.
    defaultEnabled: false,
    dryRunConfigPath: 'multiMachine.seamlessness.ws13DryRun',
    expectedTickMs: 30_000, // ws13TickMs default
    process: 'server',
    // expectRuntime honesty (U4.1 §2A manifest constants): TRUE only because the
    // reconciler's GuardRegistry self-registration is BUILT (OwnershipReconciler
    // .guardStatus() registered at boot in server.ts) — a manifest that expects a
    // runtime report nobody sends is a standing false alarm.
    expectRuntime: true,
    component: 'OwnershipReconciler',
    description: 'U4.1/WS1.3 ownership reconciler — the owning controller that drives a pinned topic to its desired machine within a bounded time (cooperative transfer/adopt; paced; sustained-online gated) or escalates loudly (pin-diverged / pin-pending-aged attention items).',
    // G3 (U4.1 §2A): pin persistence is the exact "A Dark Feature Guards Nothing"
    // failure named after the 2026-07-01 incident — a dark/dry-run posture must
    // classify loadBearingSoaking→loadBearingGap, never sit silent.
    loadBearing: true,
    criticalPath: 'deliberate placement persistence (operator pin survives lease handover and machine bounce)',
    soakWindowDays: 30,
    declaredLoadBearingAt: '2026-07-02',
  },
  {
    key: 'multiMachine.seamlessness.ws13PinReplicate',
    kind: 'config',
    configPath: 'multiMachine.seamlessness.ws13PinReplicate',
    // Dev-gated: OMITTED from ConfigDefaults (resolveDevAgentGate) — dark-default
    // on the fleet, live on a development agent.
    defaultEnabled: false,
    process: 'server',
    // No single ticking runtime component: emission rides the store-agnostic
    // ReplicatedRecordEmitter and reads ride the TopicPinFoldView refresh — no
    // self-registration, so expectRuntime stays honest at false.
    expectRuntime: false,
    component: 'TopicPinReplicatedStore',
    description: 'U4.1/WS1.3 pin replication — the topic-pin-record advisory stream (HLC-ordered, tombstone-respecting, skew-gated answer-complete fold) that lets the owning machine and a new lease-holder SEE an operator pin set elsewhere.',
    loadBearing: true,
    criticalPath: 'deliberate placement persistence (operator pin survives lease handover and machine bounce)',
    soakWindowDays: 30,
    declaredLoadBearingAt: '2026-07-02',
  },
  // ── U4.3 — rope-health recovery probe (docs/specs/u4-3-breaker-recovery-probe.md §3) ──
  {
    key: 'multiMachine.meshTransport.recoveryProbeEnabled',
    kind: 'config',
    configPath: 'multiMachine.meshTransport.recoveryProbeEnabled',
    // Dev-gated: `enabled` OMITTED from ConfigDefaults (resolveDevAgentGate) —
    // dark-default on the fleet, live (dry-run) on a development agent.
    defaultEnabled: false,
    dryRunConfigPath: 'multiMachine.meshTransport.recoveryProbeDryRun',
    expectedTickMs: 5_000, // rides the ~5s lease-pull tick (the carrier)
    process: 'server',
    expectRuntime: false,
    component: 'RopeRecoveryProber',
    description: 'U4.3 traffic-independent recovery probe for dead mesh ropes (pinned signed canary dials feeding the one HealthRecord authority; episode-scoped, P19 15-min floor, escalate-once per episode).',
    // G3 (R-r2-6): this is a GUARD for a live incident class (a healed rope
    // presumed dead for a week), so a dark/stalled state must classify as
    // loadBearingGap/loadBearingSoaking — never sit silently off. The soak
    // constants make the day-one dev dry-run posture classify loadBearingSoaking
    // (a guard graduating within its bounded window), not an instant Gap alarm.
    loadBearing: true,
    criticalPath: 'mesh reachability recovery',
    soakWindowDays: 30,
    declaredLoadBearingAt: '2026-07-02',
  },
  // ── U4.5 — rope-health alerts monitor (docs/specs/u4-5-rope-health-alerts.md §4) ──
  {
    key: 'monitoring.ropeHealth.enabled',
    kind: 'config',
    configPath: 'monitoring.ropeHealth.enabled',
    // Dev-gated: `enabled` OMITTED from ConfigDefaults (resolveDevAgentGate) —
    // dark-default on the fleet, live on a development agent day one.
    defaultEnabled: false,
    expectedTickMs: 30_000, // the monitor's OWN bounded evaluation loop (R-r2-2)
    process: 'server',
    expectRuntime: false,
    component: 'RopeHealthMonitor',
    description: 'U4.5 rope-health alerts — deterministic sleep-aware mesh-degradation classifier (ok/degraded/peer-offline/urgent) with episode-deduped HIGH partition alerts + Tailscale key-expiry warnings.',
    // G3: this IS the alerting layer for mesh reachability — a partition with the
    // monitor dark is exactly the silent-message-loss precondition it exists to
    // surface, so a dark/stalled state must classify loadBearingGap/Soaking.
    loadBearing: true,
    criticalPath: 'mesh partition alerting',
    soakWindowDays: 30,
    declaredLoadBearingAt: '2026-07-02',
  },
  {
    key: 'multiMachine.sessionPool.holdForStability.enabled',
    kind: 'config',
    configPath: 'multiMachine.sessionPool.holdForStability.enabled',
    defaultEnabled: false,
    process: 'server',
    // §4.2: the runtime getter reports the EFFECTIVE state (always-failover
    // default ⇒ enabled:false) and registers on the UNCONDITIONAL boot path,
    // so the orphaned-config case (hold on, queue off) derives
    // off-runtime-divergent rather than on-unverified.
    expectRuntime: true,
    component: 'OwnerHoldVerdict',
    description: 'Hold-for-stability: briefly-wobbly machines get up to holdMaxMs to recover before their conversations move (ships dark; trails inboundQueue one stage).',
  },
  {
    // U4.2 stale-owner release (docs/specs/u4-2-stale-owner-release.md §5) —
    // `enabled` is deliberately OMITTED from ConfigDefaults (developmentAgent
    // dark-feature gate: dev-live-in-dryRun, dark fleet; DEV_GATED_FEATURES).
    // defaultEnabled:false reflects the fleet default.
    key: 'multiMachine.sessionPool.staleOwnerRelease.enabled',
    kind: 'config',
    configPath: 'multiMachine.sessionPool.staleOwnerRelease.enabled',
    defaultEnabled: false,
    dryRunConfigPath: 'multiMachine.sessionPool.staleOwnerRelease.dryRun',
    process: 'server',
    expectRuntime: false,
    component: 'StaleOwnerReleaseEngine',
    description:
      "U4.2 stale-owner release — the serving-lease holder force-claims a provably-dead owner's topics behind the §2.2 evidence bar (ships dev-dry-run / dark fleet; graduation soak-gated).",
    // G3 load-bearing (spec §5): this feature class is literally on the
    // postmortem's existed-but-dark list — a stalled dark/dry-run posture must
    // classify LOUDLY per #1318, never sit quiet.
    loadBearing: true,
    criticalPath: 'topic reachability when its owner machine dies (auto-failover of stranded topics)',
    soakWindowDays: 30,
    declaredLoadBearingAt: '2026-07-02',
  },
  {
    // U4.4 lease hand-back (docs/specs/u4-4-lease-handback.md §5) — ACTION-BEARING
    // lease authority; ships HARD-DARK everywhere (enabled:false + dryRun:true,
    // DARK_GATE_EXCLUSIONS) until the live two-machine pair verification passes.
    key: 'multiMachine.leaseSelfHeal.preferredCaptainHandback.enabled',
    kind: 'config',
    configPath: 'multiMachine.leaseSelfHeal.preferredCaptainHandback.enabled',
    defaultEnabled: false,
    dryRunConfigPath: 'multiMachine.leaseSelfHeal.preferredCaptainHandback.dryRun',
    process: 'server',
    expectRuntime: false,
    component: 'LeaseHandbackReconciler',
    description:
      'U4.4 lease hand-back — drives the serving lease back to the F4 preferred captain after a failover (hysteresis-gated, claim-before-release via signed consent token; ships hard-dark, live-pair-verified before enablement).',
    // G3 load-bearing (spec §5, R-r2-7): deliberately hard-dark past any
    // reasonable soak until the live-pair drive — the soak constants make the
    // pre-graduation posture classify loadBearingSoaking within its window; a
    // stall past it falls to the loud Gap, with the manual captain-flip playbook
    // as the recorded interim operator fallback.
    loadBearing: true,
    criticalPath: 'serving-lease returns to intended captain (mesh drifts off the always-on machine after failover)',
    soakWindowDays: 60,
    declaredLoadBearingAt: '2026-07-02',
  },
  // ── Swap-continuity anti-thrash guards (swap-continuity-antithrash §6.4) ──
  {
    // Piece 1 — the anti-thrash brakes on the proactive account swap. Nested
    // under the already-opt-in subscriptionPool.proactiveSwap lever (fleet-dark
    // today); the block resolves `enabled:true, dryRun:true` when ABSENT, so an
    // opted-in install grades on-dry-run (the rung-2 soak) rather than off.
    key: 'subscriptionPool.proactiveSwap.antiThrash.enabled',
    kind: 'config',
    configPath: 'subscriptionPool.proactiveSwap.antiThrash.enabled',
    // Runtime-fallback default (`?? true`) — ConfigDefaults deliberately omits
    // the block per spec §9 (absence = defaults).
    defaultEnabled: true,
    dryRunConfigPath: 'subscriptionPool.proactiveSwap.antiThrash.dryRun',
    // §7.1: every antiThrash knob is re-read via the config getter each tick,
    // so a config change is already live — diverged-pending-restart would lie.
    liveConfig: true,
    process: 'server',
    expectRuntime: false,
    component: 'SwapAntiThrashEngine',
    description:
      'Anti-thrash brakes on the proactive account swap (all-hot brake, 45-min dwell, target-materially-better, two-tier thrash breaker) — the fix for the 2026-07-02 36-swap thrash day. Dry-run soaks by default; live only at a deliberate dryRun:false.',
  },
  {
    // Piece 2 — the in-flight work gate on every session-killing mutation.
    // The `enabled` key is OMITTED from shipped config (dev-agent gate: live on
    // a dev agent, dark on the fleet — the #1001 anti-mechanism); the posture
    // row exists independently of proactiveSwap (§6.4) and grades dark-default
    // on the fleet — ships-dark quiet, never a load-bearing gap (no critical
    // path depends on it until the fleet flip).
    key: 'subscriptionPool.swapContinuity.enabled',
    kind: 'config',
    configPath: 'subscriptionPool.swapContinuity.enabled',
    defaultEnabled: false,
    dryRunConfigPath: 'subscriptionPool.swapContinuity.dryRun',
    process: 'server',
    expectRuntime: false,
    component: 'SwapWorkGate',
    description:
      'In-flight work gate for session-killing mutations (proactive swap defers; reactive gets a bounded grace then proceeds WITH F3 mitigations; interactive refresh gets a structured session-busy refusal + force) — a swap never silently kills builders mid-task.',
  },
  // ── Session lifecycle guards ──
  {
    key: 'monitoring.sessionReaper.enabled',
    kind: 'config',
    configPath: 'monitoring.sessionReaper.enabled',
    defaultEnabled: false,
    dryRunConfigPath: 'monitoring.sessionReaper.dryRun',
    expectedTickMs: 120_000,
    process: 'server',
    expectRuntime: true,
    component: 'SessionReaper',
    description: 'Pressure-aware reaper of idle-but-alive sessions (the guard the Mini ran without for a week).',
  },
  {
    key: 'monitoring.resumeQueue.enabled',
    kind: 'config',
    configPath: 'monitoring.resumeQueue.enabled',
    // Code-defaulted true (#1157 keeps resume-queue keys OUT of ConfigDefaults to
    // preserve the fleet flip; this is the runtime-fallback default).
    defaultEnabled: true,
    dryRunConfigPath: 'monitoring.resumeQueue.dryRun',
    process: 'server',
    // The runtime getter (ResumeQueue.guardStatus) registers UNCONDITIONALLY at
    // boot, so a disabled queue (e.g. an un-healable foreign-host lock) derives
    // off-runtime-divergent (config on, runtime off) rather than `missing` —
    // the alerting class that makes a silently-disabled revival guard loud.
    expectRuntime: true,
    component: 'ResumeQueue',
    description: 'Mid-work resume queue: revives a reaped registered autonomous run (#1157). A disabled queue reports off-runtime-divergent so it is never silently inert (an autonomous run must outlive its session).',
  },
  {
    key: 'monitoring.reapNotify.enabled',
    kind: 'config',
    configPath: 'monitoring.reapNotify.enabled',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'ReapNotify',
    description: 'User-facing notice when a session is autonomously shut down.',
  },
  {
    key: 'monitoring.greenPrAutoMerge.enabled',
    kind: 'config',
    configPath: 'monitoring.greenPrAutoMerge.enabled',
    defaultEnabled: false,
    dryRunConfigPath: 'monitoring.greenPrAutoMerge.dryRun',
    expectedTickMs: 600_000,
    process: 'server',
    expectRuntime: true,
    component: 'GreenPrAutoMerger',
    description: 'Background watcher that merges a green, mergeable, non-held PR this agent authored (Phase 7 becomes machinery). Repo-gated; lease-serialized; runtime rollback + breaker.',
  },
  {
    key: 'monitoring.watchdog.enabled',
    kind: 'config',
    configPath: 'monitoring.watchdog.enabled',
    defaultEnabled: true,
    expectedTickMs: 30_000,
    liveConfig: true,
    process: 'server',
    expectRuntime: true,
    component: 'SessionWatchdog',
    description: 'Stuck-process detection + escalating kill sequence.',
  },
  {
    key: 'monitoring.socketDisconnectSentinel.enabled',
    kind: 'config',
    configPath: 'monitoring.socketDisconnectSentinel.enabled',
    defaultEnabled: true,
    expectedTickMs: 15_000,
    process: 'server',
    expectRuntime: true,
    component: 'SocketDisconnectSentinel',
    description: 'Detects sessions that silently dropped their socket.',
  },
  {
    key: 'monitoring.activeWorkSilenceSentinel.enabled',
    kind: 'config',
    configPath: 'monitoring.activeWorkSilenceSentinel.enabled',
    defaultEnabled: true,
    expectedTickMs: 60_000,
    process: 'server',
    expectRuntime: true,
    component: 'ActiveWorkSilenceSentinel',
    description: 'Detects sessions frozen mid-task (active work gone silent).',
  },
  {
    key: 'monitoring.permissionPromptAutoResolver.enabled',
    kind: 'config',
    // NB: there is NO persisted `enabled` for this floor (a stale `false` could
    // re-disable the very safety it provides — the trap that caused the bug). The
    // posture key is COMPUTED in extractGuardPosture from inverted `emergencyDisable`,
    // defaulting on; this configPath matches that computed key.
    configPath: 'monitoring.permissionPromptAutoResolver.enabled',
    defaultEnabled: true,
    expectedTickMs: 5_000,
    process: 'server',
    expectRuntime: true,
    component: 'PermissionPromptAutoResolver',
    description: 'Always-on floor that auto-answers a framework approval prompt (the cd-redirection wedge); never silently disableable.',
  },
  {
    key: 'intelligence.selfActionGovernor.enabled',
    kind: 'config',
    // SYNTHETIC enabled-polarity key (unified-self-action-backpressure
    // §Fail-direction deliverable 1 — the PermissionPromptAutoResolver
    // precedent): the governor's only switch is the INVERTED
    // `intelligence.selfActionGovernor.emergencyDisable` (true = OFF), so
    // extractGuardPosture COMPUTES `enabled = emergencyDisable !== true`
    // (absent => on) under this configPath. A deliberate disable then reads as
    // enabled->disabled — a tripwire incident, never a silent batch-flip.
    configPath: 'intelligence.selfActionGovernor.enabled',
    defaultEnabled: true,
    // emergencyDisable is read live by the governor (a disk/PATCH change takes
    // effect with no restart) — diverged-pending-restart would lie.
    liveConfig: true,
    expectedTickMs: 60_000,
    process: 'server',
    expectRuntime: true,
    component: 'SelfActionGovernor',
    description:
      'Unified self-action backpressure chokepoint (observe-only rollout): every registered self-triggered action (kill, swap, notify, respawn) rides admit() for would-deny measurement; per-class enforce is the operator FD8 ladder.',
    loadBearing: true,
    criticalPath: 'self-action capacity safety (the runaway self-trigger flood brake: reaper kill storms, swap thrash, notify floods)',
    // G3 manifest lint: every loadBearing entry declares its soak budget. The
    // governor ships observe-only BY DESIGN (FD1) and its runtime getter does
    // not report observe as dryRun (the FD8/FD12 ladder owns per-class
    // graduation), so the soak window exists to satisfy the uniform G3
    // contract — the guard's own enabled-state (emergencyDisable inversion)
    // is what the gap classification watches.
    soakWindowDays: 30,
    declaredLoadBearingAt: '2026-07-10',
  },
  {
    key: 'monitoring.externalHogSentinel.enabled',
    kind: 'config',
    configPath: 'monitoring.externalHogSentinel.enabled',
    // Dev-gated: `enabled` OMITTED from ConfigDefaults (resolveDevAgentGate) —
    // dark-default on the fleet, live (watch-only dryRun) on a development agent.
    // dryRun is the kill-safety canary: live-on-dev scans/classifies/LOGS would-kills
    // but signals NOTHING until a deliberate PIN-gated arm.
    defaultEnabled: false,
    dryRunConfigPath: 'monitoring.externalHogSentinel.dryRun',
    expectedTickMs: 60_000, // scanIntervalMs default
    // The sentinel self-registers its GuardRegistry getter at boot (commands/server.ts →
    // guardRegistry.register('monitoring.externalHogSentinel.enabled', () =>
    // sentinel.guardRuntimeStatus())), so /guards expects a runtime report. lastTickAt is the
    // sampler heartbeat (last SUCCESSFUL parse) → a blind-but-ticking sentinel reads on-stale.
    process: 'server',
    expectRuntime: true,
    component: 'ExternalHogSentinel',
    description: 'External-hog zombie auto-kill sentinel — surfaces any sustained EXTERNAL CPU hog (broad observability) and, within a mechanical veto-only floor + an intelligence kill/leave/alert verdict, auto-kills exactly one narrow class (orphaned Electron editor extension-host wrappers). Ships dev-gated dark-on-fleet, watch-only dryRun; a live kill needs a deliberate PIN-gated arm.',
    // loadBearing FALSE: a new watch-only capability nothing else depends on — a dark
    // posture just means zombies persist (the status quo), not a broken critical path.
    // Re-reviewed at fleet graduation.
    loadBearing: false,
  },
  {
    key: 'monitoring.contextWedgeSentinel.enabled',
    kind: 'config',
    configPath: 'monitoring.contextWedgeSentinel.enabled',
    defaultEnabled: true,
    expectedTickMs: 20_000,
    process: 'server',
    expectRuntime: true,
    component: 'ContextWedgeSentinel',
    description: 'Detects the thinking-block/AUP wedge that permanently kills a session.',
  },
  {
    // Sub-guard (spec §2.1): the destructive fresh-respawn arm inside the
    // wedge sentinel. Its own inventory row so "autoRecovery silently off
    // inside an on-confirmed sentinel" cannot hide. Default is the runtime
    // fallback in server.ts (deliberately OMITTED from ConfigDefaults).
    key: 'monitoring.contextWedgeSentinel.autoRecovery.enabled',
    kind: 'config',
    configPath: 'monitoring.contextWedgeSentinel.autoRecovery.enabled',
    defaultEnabled: false,
    dryRunConfigPath: 'monitoring.contextWedgeSentinel.autoRecovery.dryRun',
    process: 'server',
    expectRuntime: true,
    component: 'ContextWedgeSentinel',
    description: 'Auto-recovery (kill + fresh respawn) arm of the context-wedge sentinel.',
  },
  {
    key: 'monitoring.agentWorktreeReaper.enabled',
    kind: 'config',
    configPath: 'monitoring.agentWorktreeReaper.enabled',
    defaultEnabled: false,
    dryRunConfigPath: 'monitoring.agentWorktreeReaper.dryRun',
    expectedTickMs: 86_400_000,
    process: 'server',
    expectRuntime: false,
    component: 'AgentWorktreeReaper',
    description: 'Reclaims merged+clean+unused agent worktrees.',
  },
  {
    // Machine-coherence guard (machine-coherence-guard §6/§7, roadmap 4.1
    // F4/P0-1). `enabled` is deliberately OMITTED from ConfigDefaults — the
    // runtime resolves it through the developmentAgent dark-feature gate (dark
    // on the fleet, live on a dev agent; dry-run first). defaultEnabled:false
    // reflects the fleet default. expectRuntime:true — increment C₁b-i adds the
    // server-boot construction + guardRegistry.register('monitoring.machineCoherence.enabled')
    // callsite on the peerPresenceTick path, registered ONLY when the gate
    // resolves enabled. The `missing` classification requires configEnabled===true
    // (guardPostureView §precedence), so a dark fleet agent (gate → false) never
    // constructs, never registers, and is never falsely graded `missing` — the
    // ws13Reconcile/holdForStability expectRuntime:true precedent.
    // NOT loadBearing (Frontloaded Decision D6): signal-only, no critical path
    // consumes it yet, and loadBearing:true would raise G3 gap alarms on every
    // fleet agent where the guard is deliberately dark.
    key: 'monitoring.machineCoherence.enabled',
    kind: 'config',
    configPath: 'monitoring.machineCoherence.enabled',
    defaultEnabled: false,
    expectedTickMs: 30_000,
    process: 'server',
    expectRuntime: true,
    component: 'MachineCoherenceSentinel',
    description: 'Machine-coherence guard evaluator: compares version/resolved-flag/protocol/manifest across the agent\'s own ONLINE machines (the F4 skew class) and will raise ONE episode-scoped attention item from exactly ONE elected machine. Signal-only; MUTATES NOTHING.',
  },
  {
    // `enabled` is deliberately OMITTED from ConfigDefaults — the runtime resolves
    // it through the developmentAgent dark-feature gate (dark on the fleet, live on
    // a dev agent). defaultEnabled:false reflects the fleet default.
    key: 'monitoring.orphanedWorkSentinel.enabled',
    kind: 'config',
    configPath: 'monitoring.orphanedWorkSentinel.enabled',
    defaultEnabled: false,
    expectedTickMs: 600_000,
    process: 'server',
    expectRuntime: false,
    component: 'OrphanedWorkSentinel',
    description: 'Detects agent worktrees with uncommitted work whose owning session died + settled.',
  },
  {
    // `enabled` is deliberately OMITTED from ConfigDefaults — the runtime resolves
    // it through the developmentAgent dark-feature gate (dark on the fleet, live on
    // a dev agent). defaultEnabled:false reflects the fleet default. expectRuntime:
    // true REQUIRES the server-boot guardRegistry.register callsite (a pure
    // in-memory guardStatus getter); an enabled-but-unregistered guard reports
    // `missing`. expectedTickMs derives the on-stale threshold (5×).
    key: 'monitoring.strandedTopicSentinel.enabled',
    kind: 'config',
    configPath: 'monitoring.strandedTopicSentinel.enabled',
    defaultEnabled: false,
    expectedTickMs: 60_000,
    process: 'server',
    expectRuntime: true,
    component: 'StrandedTopicSentinel',
    description: 'Pure-signal detector: surfaces a topic whose owner machine is online-but-unable-to-serve (quota-walled / adapter-disconnected) while a healthy machine holds the lease, so inbound is silently dead. Raises ONE aggregated attention item; MUTATES NOTHING.',
    // G3 load-bearing (g3-dark-but-load-bearing-guards, Decision 2): the ONLY
    // detector of "inbound is silently dead" — an online-but-unable-to-serve
    // owner. Directly on the operator-message-reachability critical path. No
    // dry-run arm, so a dark agent is an immediate loud loadBearingGap (the honest
    // force-a-decision signal); the soak window applies only where it is graduated.
    loadBearing: true,
    criticalPath: 'inbound message reachability (detects an online-but-unable-to-serve owner so inbound is not silently dead)',
    soakWindowDays: 30,
    declaredLoadBearingAt: '2026-07-01',
  },
  {
    // Durable-Output Hygiene Standard §2 Layer B ("What Persists Must Be Clean",
    // docs/specs/durable-output-hygiene-standard.md). `enabled` is deliberately
    // OMITTED from ConfigDefaults — the runtime resolves it through the
    // developmentAgent dark-feature gate (dark on the fleet, live on a dev
    // agent); defaultEnabled:false reflects the fleet default. NO expectedTickMs:
    // it is EVENT-DRIVEN (runs inline at each durable-output persistence write,
    // not on a tick), so a quiet store is not stale. expectRuntime: false — it is
    // a pure write-path transform constructed at boot, with no guardRegistry
    // heartbeat. dryRunConfigPath is the canary arm (dryRun:true computes +
    // records would-redact metrics but persists the ORIGINAL text; the
    // dryRun:false flip is the operator's endpoint decision — spec Frontloaded
    // Decision #4).
    key: 'monitoring.durableOutputScrub.enabled',
    kind: 'config',
    configPath: 'monitoring.durableOutputScrub.enabled',
    dryRunConfigPath: 'monitoring.durableOutputScrub.dryRun',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'DurableOutputScrubber',
    description: 'Deterministic credential-SPAN scrub over LLM output at durable-output persistence chokepoints (session summaries first) — redacts known token shapes BEFORE the write, with provenance markers + would-redact telemetry (counts/kind/offset only, never bytes). Content-altering safety floor, never blocking; dark-first + dryRun canary.',
  },
  {
    // tmux Event-Loop Resilience (C). `enabled` is deliberately OMITTED from
    // ConfigDefaults — the runtime resolves it through the developmentAgent
    // dark-feature gate (dark on the fleet, live on a dev agent). defaultEnabled:false
    // reflects the fleet default. NO expectedTickMs: it is EVENT-DRIVEN (fed by
    // (A)'s tmux-call latency + (B)'s 'stall' events), so a quiet/healthy tmux is
    // not stale — setting expectedTickMs would derive a false on-stale. expectRuntime:
    // true REQUIRES the server-boot guardRegistry.register callsite (a pure in-memory
    // guardStatus getter); an enabled-but-unregistered guard reports `missing`.
    key: 'monitoring.degradedTmuxGuard.enabled',
    kind: 'config',
    configPath: 'monitoring.degradedTmuxGuard.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: true,
    component: 'DegradedTmuxGuard',
    description: 'Signal-only watcher: raises ONE deduped agent-health Attention item when the shared tmux server is degraded (slow sync calls / event-loop stalls). NEVER kills the shared socket.',
  },
  {
    key: 'monitoring.mcpProcessReaper.enabled',
    kind: 'config',
    configPath: 'monitoring.mcpProcessReaper.enabled',
    defaultEnabled: false,
    expectedTickMs: 1_800_000,
    process: 'server',
    expectRuntime: false,
    component: 'McpProcessReaper',
    description: 'Reaps orphaned MCP server processes.',
  },
  {
    key: 'monitoring.staleBackstop.enabled',
    kind: 'config',
    configPath: 'monitoring.staleBackstop.enabled',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'StaleBackstop',
    description: 'Backstop cleanup for stale session state.',
  },
  {
    key: 'monitoring.agentSleep.enabled',
    kind: 'config',
    configPath: 'monitoring.agentSleep.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'AgentSleep',
    description: 'Agent sleep/idle power management.',
  },
  // ── Liveness / health guards ──
  {
    key: 'monitoring.bootHealthBeacon.enabled',
    kind: 'config',
    configPath: 'monitoring.bootHealthBeacon.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'BootHealthBeacon',
    description: 'Boot-time health beacon endpoint (dev-gated, CMT-1438).',
  },
  {
    key: 'monitoring.enforcedTermination.enabled',
    kind: 'config',
    configPath: 'monitoring.enforcedTermination.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'EnforcedTerminationWatchdog',
    description: 'External hard-stop for autonomous runs that overrun their budget (dev-gated, F2).',
  },
  {
    key: 'monitoring.rateLimitSentinel.enabled',
    kind: 'config',
    configPath: 'monitoring.rateLimitSentinel.enabled',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'RateLimitSentinel',
    description: 'Detects provider rate-limit walls and schedules recovery.',
  },
  {
    key: 'monitoring.parallelWorkSentinel.enabled',
    kind: 'config',
    configPath: 'monitoring.parallelWorkSentinel.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'ParallelWorkSentinel',
    description: 'Cross-topic overlap councilor (dev-gated, Phase B).',
  },
  {
    key: 'monitoring.resourceLedger.enabled',
    kind: 'config',
    configPath: 'monitoring.resourceLedger.enabled',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'ResourceLedger',
    description: 'CPU/memory sampling + rate-limit-event ledger (read-only observability).',
  },
  {
    key: 'monitoring.processFootprintMonitor.enabled',
    kind: 'config',
    configPath: 'monitoring.processFootprintMonitor.enabled',
    defaultEnabled: false, // dark on the fleet; ON for dev agents via the developmentAgent gate
    process: 'server',
    expectRuntime: false,
    component: 'ProcessFootprintMonitor',
    description: 'Per-machine process-footprint count + trend (observe-only; the climb measurement missing before the 2026-06-26 panic).',
  },
  {
    key: 'monitoring.memoryMonitoring',
    kind: 'config',
    configPath: 'monitoring.memoryMonitoring',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'MemoryPressureMonitor',
    description: 'Memory-pressure sampling that feeds load-shed decisions.',
  },
  {
    key: 'monitoring.quotaTracking',
    kind: 'config',
    configPath: 'monitoring.quotaTracking',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'QuotaTracker',
    description: 'Threshold-based LLM quota tracking + load shedding.',
  },
  {
    key: 'monitoring.telemetry.enabled',
    kind: 'config',
    configPath: 'monitoring.telemetry.enabled',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'TelemetryCollector',
    description: 'Job/session telemetry collection.',
  },
  {
    key: 'monitoring.burnDetection.enabled',
    kind: 'config',
    configPath: 'monitoring.burnDetection.enabled',
    // Defaults deliberately OMITTED from ConfigDefaults (shipped defaults live
    // in AgentServer); absence preserves default-ON.
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'BurnDetector',
    description: 'Per-component token-burn share/rate alerts.',
  },
  {
    key: 'monitoring.sentinelTelegramEscalation',
    kind: 'config',
    configPath: 'monitoring.sentinelTelegramEscalation',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'SentinelEscalationFlag',
    description: 'Opt-in Telegram delivery of coalesced sentinel escalations.',
  },
  // ── Triage / learning guards ──
  {
    key: 'monitoring.triage.enabled',
    kind: 'config',
    configPath: 'monitoring.triage.enabled',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'StallTriageNurse',
    description: 'Stall triage nurse (classification of stuck sessions).',
  },
  {
    key: 'monitoring.triageOrchestrator.enabled',
    kind: 'config',
    configPath: 'monitoring.triageOrchestrator.enabled',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'TriageOrchestrator',
    description: 'Orchestrates triage outcomes into recovery actions.',
  },
  {
    key: 'monitoring.failureLearning.enabled',
    kind: 'config',
    configPath: 'monitoring.failureLearning.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'FailureLearningLoop',
    description: 'Failure-Learning Loop capture + pattern surfacing (dev-gated, CMT-1438).',
  },
  {
    key: 'monitoring.correctionLearning.enabled',
    kind: 'config',
    configPath: 'monitoring.correctionLearning.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'CorrectionLearningLoop',
    description: 'Correction & preference learning sentinel.',
  },
  {
    key: 'monitoring.correctionClassReview.enabled',
    kind: 'config',
    configPath: 'monitoring.correctionClassReview.enabled',
    defaultEnabled: false,
    dryRunConfigPath: 'monitoring.correctionClassReview.dryRun',
    process: 'server',
    expectRuntime: false,
    component: 'CorrectionClassReview',
    description: 'Record-time correction class review plus correspondence-bound instance-fix admission.',
    loadBearing: true,
    criticalPath: 'correction-derived instance fixes receive a standards and development-process class review first',
    soakWindowDays: 30,
    declaredLoadBearingAt: '2026-07-19',
  },
  {
    key: 'monitoring.completionClaimVerification.enabled',
    kind: 'config',
    configPath: 'monitoring.completionClaimVerification.enabled',
    defaultEnabled: false,
    dryRunConfigPath: 'monitoring.completionClaimVerification.dryRun',
    process: 'server',
    expectRuntime: false,
    component: 'CompletionClaimVerifier',
    description: 'Observe-only completion-claim corroboration against structural TurnEvidence.',
  },
  {
    // Sub-guard: plain-boolean flag INSIDE the correctionLearning block (not
    // `.enabled`-shaped, so the generic extractor cannot see it).
    key: 'monitoring.correctionLearning.selfViolationSignal',
    kind: 'config',
    configPath: 'monitoring.correctionLearning.selfViolationSignal',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'CorrectionLearningLoop',
    description: 'Self-violation observe-only signal inside correction learning.',
  },
  {
    key: 'monitoring.apprenticeshipCycleSla.enabled',
    kind: 'config',
    configPath: 'monitoring.apprenticeshipCycleSla.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'ApprenticeshipCycleSlaMonitor',
    description: 'Observe-only overdue-apprenticeship-cycle signal.',
  },
  {
    key: 'monitoring.geminiCapacityEscalation.enabled',
    kind: 'config',
    configPath: 'monitoring.geminiCapacityEscalation.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'GeminiCapacityEscalation',
    description: 'Gemini capacity escalation monitor.',
  },
  {
    key: 'monitoring.releaseReadiness.enabled',
    kind: 'config',
    configPath: 'monitoring.releaseReadiness.enabled',
    defaultEnabled: false,
    expectedTickMs: 21_600_000,
    process: 'server',
    expectRuntime: false,
    component: 'ReleaseReadinessSentinel',
    description: 'Stalled-release watchdog (dev-gated; maintainer environments).',
  },
  {
    key: 'monitoring.promptGate.enabled',
    kind: 'config',
    configPath: 'monitoring.promptGate.enabled',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'PromptGate',
    description: 'Prompt-quality gate on outbound LLM calls.',
  },
  // ── Dev-gated observability guards (enabled omitted; gate-resolved) ──
  {
    key: 'monitoring.growthAnalyst.enabled',
    kind: 'config',
    configPath: 'monitoring.growthAnalyst.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'GrowthMilestoneAnalyst',
    description: 'Proactive growth & milestone analyst (dev-gated).',
  },
  {
    key: 'monitoring.blockerLedger.enabled',
    kind: 'config',
    configPath: 'monitoring.blockerLedger.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'BlockerLedger',
    description: 'Blocker ledger resolution pipeline (dev-gated).',
  },
  // ── Non-monitoring roots ──
  {
    key: 'scheduler.enabled',
    kind: 'config',
    configPath: 'scheduler.enabled',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: true,
    component: 'JobScheduler',
    description: 'Cron job scheduler (registration is not life: runtime carries lastTickAt/jobCount/pausedJobCount).',
  },
  {
    key: 'models.tierEscalation.enabled',
    kind: 'config',
    configPath: 'models.tierEscalation.enabled',
    defaultEnabled: false,
    dryRunConfigPath: 'models.tierEscalation.dryRun',
    process: 'server',
    expectRuntime: false,
    component: 'ModelTierEscalation',
    description: 'Model-tier escalation policy (COST-INCREASING enable).',
  },
  {
    // Test-Runner Concurrency Bound (test-runner-concurrency-bound §2.9/§4).
    // kind 'code-default': the chokepoint (vitest globalSetup) has NO config
    // enable — its authority is env + the host tuning file, so this row's
    // runtime getter serves the SERVER-PROCESS view of the resolved posture
    // (enabled = posture !== 'off'; dryRun = posture !== 'enforcing'), cached
    // OUTSIDE the getter (the registry contract forbids file I/O in getters).
    // A host-wide `INSTAR_HOST_TEST_SEMAPHORE=off` therefore grades
    // off-runtime-divergent — the spec's "sustained off grades diverged".
    // loadBearing + 14-day soak (§4): while the ratified dry-run soak runs,
    // the row grades loadBearingSoaking; if the window lapses with no flip
    // decision it becomes a LOUD load-bearing gap — the soak structurally
    // cannot drift into dry-run-forever (Close the Loop).
    key: 'intelligence.testRunnerCap',
    kind: 'code-default',
    defaultEnabled: true,
    expectedTickMs: 60_000,
    process: 'server',
    expectRuntime: true,
    component: 'HostTestRunnerSemaphore',
    description: 'Host-wide test-runner concurrency bound (vitest suite/targeted lanes; watch-only soak, then enforce).',
    loadBearing: true,
    criticalPath: 'host CPU protection — the multi-actor test-suite storm (2026-07-02 load-stall kill cascade)',
    soakWindowDays: 14,
    declaredLoadBearingAt: '2026-07-03',
  },
  {
    // Out-of-process guard (spec §2.1): config-derived states ONLY
    // (`on-unverified` at best) — the sync in-memory getter contract cannot
    // cross processes, so this entry must never carry expectRuntime.
    key: 'lifeline.driftPromoter.enabled',
    kind: 'config',
    configPath: 'lifeline.driftPromoter.enabled',
    defaultEnabled: true,
    process: 'lifeline',
    expectRuntime: false,
    component: 'LifelineDriftPromoter',
    description: 'Lifeline version-drift self-restart promoter (runs in the lifeline process).',
  },
  {
    key: 'multiMachine.secretSync.enabled',
    kind: 'config',
    configPath: 'multiMachine.secretSync.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'SecretSync',
    description: 'Cross-machine secret sync, receive side (dev-gated).',
  },
  {
    key: 'multiMachine.sessionPool.enabled',
    kind: 'config',
    configPath: 'multiMachine.sessionPool.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'SessionPool',
    description: 'Multi-machine session pool (ships dark behind stage).',
  },
  {
    key: 'multiMachine.coherenceJournal.enabled',
    kind: 'config',
    configPath: 'multiMachine.coherenceJournal.enabled',
    defaultEnabled: false,
    process: 'server',
    expectRuntime: false,
    component: 'CoherenceJournal',
    description: 'Cross-machine coherence journal (dev-gated).',
  },
  // ── Code-default guards (no config key; default-ON in code) ──
  {
    key: 'messaging.attentionTopicGuard',
    kind: 'code-default',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'AttentionTopicGuard',
    description: 'Topic-Flood Guard — per-source attention-topic circuit breaker (default-ON in code; tunable via messaging[].config.attentionTopicGuard).',
  },
  {
    key: 'messaging.topicCreationBudget',
    kind: 'code-default',
    defaultEnabled: true,
    process: 'server',
    expectRuntime: false,
    component: 'TopicCreationBudget',
    description: 'Bounded Notification Surface — last-resort budget on every auto-created topic (default-ON in code).',
  },
  // ── Stall-coverage matrix gate (framework-stall-coverage-matrix §3.4) ──
  {
    key: 'apprenticeship.stallCoverageGate.enabled',
    kind: 'config',
    configPath: 'apprenticeship.stallCoverageGate.enabled',
    defaultEnabled: true,
    dryRunConfigPath: 'apprenticeship.stallCoverageGate.dryRun',
    // Read LIVE at the gate callsite (no restart) → diverged-pending-restart
    // would lie; suppress it.
    liveConfig: true,
    process: 'server',
    expectRuntime: false,
    component: 'ApprenticeshipStallGate',
    description: 'Stall-coverage matrix gate — apprenticeship onboarding transitions verify the framework stall-coverage matrix (provisional at pending→active; full + liveness/posture/acceptance at active→complete). Ships enabled + dry-run; the enforce flip is operator-owned on named evidence.',
    // §3.4: while dry-run, the gate registers as load-bearing-SOAKING with a
    // soak deadline so an unflipped gate lapses into visible debt instead of
    // rotting ("A Dark Feature Guards Nothing" applies to this gate itself).
    loadBearing: true,
    criticalPath: 'apprenticeship onboarding sign-off (stall-coverage matrix gate)',
    soakWindowDays: 30,
    declaredLoadBearingAt: '2026-07-18',
  },
] as const;

/**
 * Boot-constructed components that match the guard shape (enabled-style
 * switch or tick loop in src/monitoring, src/messaging, src/lifeline,
 * src/core) but are DELIBERATELY not inventory guards. The lint requires
 * every candidate to appear here or in GUARD_MANIFEST — with a real reason
 * (≥12 non-whitespace chars, same bar as DARK_GATE_EXCLUSIONS).
 */
export interface NotAGuardEntry {
  component: string;
  reason: string;
}

export const NOT_A_GUARD: readonly NotAGuardEntry[] = [
  { component: 'rawTextRequestDetector', reason: 'Pure stateless predicate (high-precision pattern match) feeding the observe-only ask-for-access signal in checkOutboundMessage; no enabled flag, no runtime getter, takes no protective action — a detector that produces a signal, never a guard with posture.' },
  { component: 'GuardPostureTripwire', reason: 'The boot-transition detector OVER the guard inventory — meta-layer, not a guard itself; always-on, no enabled flag.' },
  { component: 'GuardRegistry', reason: 'Infrastructure of this feature: the runtime-getter registry the inventory reads; not a guard.' },
  { component: 'GuardPostureProbe', reason: 'Consumer of the inventory (probe family); its cadence rides SystemReviewer, not an own enabled switch.' },
  { component: 'SystemReviewer', reason: 'Probe scheduler/aggregator — operational reviewer, not a behavior-protecting guard; covered indirectly by its probes.' },
  { component: 'CompactionSentinel', reason: 'Always-on internal recovery lifecycle with no config enabled switch; recovery engine, not an operator-flippable guard.' },
  { component: 'SessionMonitor', reason: 'Event-driven session bookkeeping with no enabled switch; pure observability plumbing.' },
  { component: 'WorktreeMonitor', reason: 'Always-active worktree scan plumbing, no enabled switch, takes no protective action.' },
  { component: 'CoherenceMonitor', reason: 'Multi-machine coherence bookkeeping rides multiMachine gating; no own guard switch.' },
  { component: 'CommitmentSentinel', reason: 'Rides the commitments feature lifecycle; commitment bookkeeping, not a safety guard with an operator switch.' },
  { component: 'SleepWakeDetector', reason: 'Always-on OS sleep/wake event detector; pure signal source with no enabled switch.' },
  { component: 'PresenceProxy', reason: 'Standby heartbeat messenger; messaging-liveness feature, tuned not toggled — no guard semantics.' },
  { component: 'PromiseBeacon', reason: 'Commitment follow-through heartbeats; user-facing feature behavior, not a protective guard.' },
  { component: 'CommitmentTracker', reason: 'Commitment lifecycle store; data layer, no guard semantics.' },
  { component: 'LlmQueue', reason: 'Rate-limited LLM call queue; shared infrastructure, not an operator-flippable guard.' },
  { component: 'HelperWatchdog', reason: 'Signal-only subagent stall detector wired into SubagentTracker; no config enabled switch, consumers own actions.' },
  { component: 'DeliveryFailureSentinel', reason: 'Telegram relay recovery engine; delivery-robustness layer, always-on with the relay, no guard switch.' },
  { component: 'TemplatesDriftVerifier', reason: 'Deployed-script drift lint; CI-style verifier, not a runtime guard.' },
  { component: 'TokenLedger', reason: 'Read-only token observability (never gates); the spec class-precedent for always-on read-only features.' },
  { component: 'TokenLedgerPoller', reason: 'Background scanner feeding TokenLedger; observability plumbing.' },
  { component: 'CrashLoopPauser', reason: 'Auto-pause of runaway jobs is scheduler-internal mechanics; surfaced via scheduler.enabled + job state, not its own guard.' },
  { component: 'QuotaTrackerPoller', reason: 'Polling arm of QuotaTracker; covered by monitoring.quotaTracking.' },
  { component: 'StuckSignatureClassifier', reason: 'Pure classifier (standby honesty); signal-only, no enabled switch, no action.' },
  { component: 'MessageSentinel', reason: 'Emergency-stop message classifier; inbound-dispatch mechanics inseparable from messaging, no operator switch.' },
  { component: 'TelegramAdapter', reason: 'Platform transport adapter; messaging infrastructure, not a guard.' },
  { component: 'SlackAdapter', reason: 'Platform transport adapter; messaging infrastructure, not a guard.' },
  { component: 'WhatsAppAdapter', reason: 'Platform transport adapter; messaging infrastructure, not a guard.' },
  { component: 'IMessageAdapter', reason: 'Platform transport adapter; messaging infrastructure, not a guard.' },
  { component: 'MessageRouter', reason: 'Topic→adapter routing; messaging infrastructure, not a guard.' },
  { component: 'DeliveryRetryManager', reason: 'Delivery retry mechanics; messaging infrastructure, not a guard.' },
  { component: 'PendingRelayStore', reason: 'Durable relay queue; storage layer, not a guard.' },
  { component: 'MessageStore', reason: 'Message persistence; storage layer, not a guard.' },
  { component: 'SpawnRequestManager', reason: 'Cross-session spawn coordination; session mechanics, not a guard.' },
  { component: 'SessionManager', reason: 'Core session lifecycle engine; the thing guards act ON, not a guard.' },
  { component: 'StateManager', reason: 'Core state persistence; storage layer.' },
  { component: 'SourceTreeGuard', reason: 'Hard invariant on destructive ops against the source tree — always-on by design with NO off switch, so posture (on/off) is meaningless for it.' },
  { component: 'SafeGitExecutor', reason: 'Single-funnel for destructive git ops; hard invariant, no off switch, posture meaningless.' },
  { component: 'SafeFsExecutor', reason: 'Single-funnel for destructive fs ops; hard invariant, no off switch, posture meaningless.' },
  { component: 'UpdateChecker', reason: 'Auto-update polling; lifecycle infrastructure, not a protective guard.' },
  { component: 'SleepWakeCoordinator', reason: 'Multi-machine awake/standby lease mechanics; coordination layer, not an operator-flippable guard.' },
  { component: 'MachinePoolRegistry', reason: 'In-memory pool state from heartbeats; data layer this feature reads, not a guard.' },
  { component: 'PendingInjectStore', reason: 'Durable inject ledger; storage layer.' },
  { component: 'LifelineProbe', reason: 'Server→lifeline health probe in the probe family; rides SystemReviewer cadence.' },
  { component: 'LifelineDriftMonitor', reason: 'Version-handshake observer feeding the driftPromoter (which IS the guard, declared in the manifest).' },
  // ── lint-guard-manifest backfill (spec §2.1 "complete backfill" sweep) ──
  { component: 'A2ARedeliverySentinel', reason: 'A2A delivery-loop closer (redelivery + per-peer escalation) gated by monitoring.a2aRedelivery, default-OFF; threadline delivery-robustness mechanics, deliberately not in the protective-guard inventory.' },
  { component: 'AgentWorktreeDetector', reason: 'One-shot per-startup worktree-convention scan emitting at most one aggregated attention item; no running lifecycle or enabled switch, so posture is not expressible.' },
  { component: 'FeedbackAnomalyDetector', reason: 'In-memory rate/burst screening of feedback submissions; feedback-service input validation, not a session-protecting guard.' },
  { component: 'AccountFollowMeDetector', reason: 'Pure deterministic decision helper (WS5.2) computing which depth-zero machines to OFFER an enrollment consent for; no boot lifecycle, no enabled switch, never blocks — a computation library, not a guard.' },
  { component: 'FrameworkParitySentinel', reason: 'Parity-rules registry consumer surfacing framework-native drift; mentor/parity feature mechanics riding enabledFrameworks, not an operator-flippable protective guard.' },
  { component: 'GeminiCapacityEscalationMonitor', reason: 'Implementation file of the manifest guard monitoring.geminiCapacityEscalation.enabled — declared there under component name GeminiCapacityEscalation; this entry classifies the file-basename alias only.' },
  { component: 'HandoffSentinel', reason: 'Planned-handoff lifecycle state machine (multi-machine coordination mechanics); coordination layer, not an operator-flippable guard.' },
  { component: 'HomeostasisMonitor', reason: 'Work-velocity awareness suggesting pause prompts during long sessions; advisory session-quality feature, takes no protective action.' },
  { component: 'InputGuard', reason: 'Inbound provenance/injection screening that warns-never-blocks before messages reach sessions; messaging-ingress mechanics with no operator enabled switch.' },
  { component: 'IntentDriftDetector', reason: 'Pure deterministic analyzer over decision-journal windows (alignment scoring); computation library with no boot lifecycle or switch.' },
  { component: 'JargonDetector', reason: 'Signal-only jargon classifier feeding MessagingToneGate (the authority); pure function, never blocks, no posture.' },
  { component: 'LedgerParaphraseDetector', reason: 'Signal-only paraphrase cross-check against SharedStateLedger feeding MessagingToneGate; observability data, never blocks.' },
  { component: 'LifelineHealthWatchdog', reason: 'Lifeline-internal stuck-loop signal source for the RestartOrchestrator (the authority); always-on self-health mechanics in the lifeline process, no operator switch.' },
  { component: 'OrphanProcessReaper', reason: 'Always-on untracked-CLI-process hygiene started unconditionally at boot with no config enabled switch; on/off posture is not expressible (CompactionSentinel class).' },
  { component: 'OverlapGuard', reason: 'Work-overlap detection wrapper around WorkLedger for the intelligent-sync feature; sync mechanics, not a boot-constructed posture guard.' },
  { component: 'PeerVisibilityGuard', reason: 'Pure hygiene-signal helpers over the machine registry (improper-revocation detection); stateless functions, no lifecycle or switch.' },
  { component: 'PrincipalGuard', reason: 'Pure-logic cross-principal crediting detector consumed by the principal-coherence pipeline; library code, the observe-only wiring rides monitoring.principalCoherence.' },
  { component: 'ProactiveSwapMonitor', reason: 'Pre-limit subscription-account swap engine (subscriptionPool.proactiveSwap); quota-continuity feature lever, not a failure-protecting guard. RECLASSIFIED (swap-continuity-antithrash §6.4): its anti-thrash BRAKES and the work gate ARE guards and register in the manifest as SwapAntiThrashEngine / SwapWorkGate — this entry now scopes only the swap-optimization lever itself.' },
  { component: 'SwapLedger', reason: 'Durable JSONL decision ledger for account-swap continuity (single append chokepoint, file IO + outage accounting only); observability substrate consumed by SwapAntiThrashEngine (the manifest-declared guard), no own posture.' },
  { component: 'PromptGuard', reason: 'Prompt-injection defense helpers (filtering/output validation) for LLM conflict resolution; pure library, no boot lifecycle.' },
  { component: 'QuotaExhaustionDetector', reason: 'Post-mortem classifier of why a dead session died (pattern-matching over tmux output); pure library, no lifecycle or switch.' },
  { component: 'ReapGuard', reason: 'Stateless KEEP-check helper consulted by the single ReapAuthority before any terminate; precondition logic inside the reap path, not a posture guard itself.' },
  { component: 'RevertDetector', reason: 'Read-only git revert scan feeding the FailureLedger; failure-learning ingestion plumbing, fail-open, no operator switch.' },
  { component: 'SelfViolationDetector', reason: 'Observe-only detector arm of the correctionLearning.selfViolationSignal sub-guard, which IS declared in the manifest under component CorrectionLearningLoop.' },
  { component: 'SessionActivitySentinel', reason: 'Mid-session activity digests + completion synthesis; session observability/digest feature, takes no protective action.' },
  { component: 'SessionServerGuard', reason: 'Pure decision helper validating session-server actions; stateless validation logic, no boot lifecycle or enabled switch.' },
  { component: 'SessionSummarySentinel', reason: 'Real-time session summaries for intelligent message routing (session: "best"); routing-quality plumbing, not a protective guard.' },
  { component: 'StaleProcessGuard', reason: 'Stale-state detection helpers (version/config drift checks); meta-infrastructure library, no boot-constructed lifecycle.' },
  { component: 'StaleSessionBackstop', reason: 'Implementation file of the manifest guard monitoring.staleBackstop.enabled — declared there under component name StaleBackstop; this entry classifies the file-basename alias only.' },
  { component: 'StallDetector', reason: 'Platform-agnostic stall/promise-tracking helper embedded in messaging adapters; adapter plumbing with no own lifecycle.' },
  { component: 'StuckInputSentinel', reason: 'Always-on restart-safe recovery sweep for messages wedged at the tmux prompt; injection-delivery mechanics inseparable from session messaging, no enabled switch.' },
  { component: 'UltraSessionCapMonitor', reason: 'Mid-run ultra-token-cap watcher inside model-tier escalation; rides models.tierEscalation (declared in the manifest as ModelTierEscalation), no own switch.' },
  { component: 'WorktreeReaper', reason: 'Dormant parallel-dev-isolation orphan-worktree reaper — exported but constructed nowhere (no importer); nothing runs, so there is no posture until it is wired.' },
  { component: 'claudeForbiddenGuard', reason: 'Hard invariant enforcing Codex-only agents never invoke Claude; always-on by design with no off switch, posture meaningless (SourceTreeGuard class).' },
  { component: 'registryReplayGuard', reason: 'Pure validation of pulled registry entries (replay/epoch/unknown-key checks); stateless function, not a runtime guard.' },
] as const;

/** Lookup helpers (used by the lint's unit test and the registry reconciliation). */
export function manifestByKey(): Map<string, GuardManifestEntry> {
  const map = new Map<string, GuardManifestEntry>();
  for (const entry of GUARD_MANIFEST) map.set(entry.key, entry);
  return map;
}

export function manifestComponents(): Set<string> {
  const set = new Set<string>();
  for (const entry of GUARD_MANIFEST) if (entry.component) set.add(entry.component);
  return set;
}

export function notAGuardComponents(): Set<string> {
  return new Set(NOT_A_GUARD.map(e => e.component));
}

/**
 * G3 manifest lints (g3-dark-but-load-bearing-guards §2.1) — BOTH NEW:
 *   1. `loadBearing` ⇒ `criticalPath` is REQUIRED (a load-bearing gap with no
 *      named path is a bare row — the criticalPath must travel on every anomaly).
 *   2. `soakWindowDays > 0` ⇒ `declaredLoadBearingAt` is REQUIRED and must be a
 *      valid ISO date (else the soak clause cannot be evaluated).
 * Returns a list of human-readable violations; empty ⇒ the manifest is well-formed.
 * A unit test asserts the real GUARD_MANIFEST returns zero violations; the RUNTIME
 * fallback for a typo'd declaredLoadBearingAt lives in deriveGuardRow (falls to the
 * loud Gap — the safe, loud direction, never silently non-soaking).
 */
export function validateGuardManifest(
  manifest: readonly GuardManifestEntry[] = GUARD_MANIFEST,
): string[] {
  const violations: string[] = [];
  for (const e of manifest) {
    if (e.loadBearing && (!e.criticalPath || !e.criticalPath.trim())) {
      violations.push(`${e.key}: loadBearing is true but criticalPath is missing (criticalPath is REQUIRED when loadBearing).`);
    }
    if (typeof e.soakWindowDays === 'number' && e.soakWindowDays > 0) {
      const d = e.declaredLoadBearingAt;
      if (!d || !d.trim()) {
        violations.push(`${e.key}: soakWindowDays>0 but declaredLoadBearingAt is missing (REQUIRED to anchor the soak window).`);
      } else if (Number.isNaN(Date.parse(d))) {
        violations.push(`${e.key}: declaredLoadBearingAt "${d}" is not a valid ISO date (soak window cannot be anchored).`);
      }
    }
  }
  return violations;
}
