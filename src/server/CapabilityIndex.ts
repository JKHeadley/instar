/**
 * CapabilityIndex — single source of truth for the /capabilities self-discovery
 * surface AND the discoverability lint that PR #290 introduced.
 *
 * Before this module: /capabilities was a hand-curated 440-line object literal
 * in routes.ts, and the lint test in tests/unit/capabilities-discoverability.test.ts
 * kept a parallel hand-written INTERNAL_ALLOWLIST. Two manual surfaces had to
 * stay in sync for the discoverability promise to hold; nothing structurally
 * enforced that sync. Echo's case study (topic 11141, 2026-05-21) called out
 * the third manual edit point as the next obvious risk.
 *
 * After this module: /capabilities iterates CAPABILITY_INDEX and the lint
 * reads the same array. Adding a new top-level route prefix to routes.ts
 * fails CI until the author either adds an entry to CAPABILITY_INDEX (the
 * "this is agent-facing, surface it" choice) or adds the prefix to
 * INTERNAL_PREFIXES (the "this is operator-only, skip discovery" choice).
 * The lint test no longer carries policy in test code — it just enforces the
 * invariant that every prefix has been classified.
 *
 * Each entry has a `build(input)` function that produces the block to merge
 * into the /capabilities response. Builders are pure (no I/O beyond what
 * ctx already exposes) so /capabilities stays cheap to call on every probe.
 *
 * Spec: docs/specs/capabilities-introspection.md (PR #N — follow-up #2 of two).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SafeGitExecutor } from '../core/SafeGitExecutor.js';
import { resolveDevAgentGate } from '../core/devAgentGate.js';
import { activeAutonomousJobs, DEFAULT_MAX_CONCURRENT_AUTONOMOUS } from '../core/AutonomousSessions.js';
import type { SecretDrop } from './SecretDrop.js';
import type { RouteContext } from './routes.js';

/** Inputs every capability builder receives. Pure data — no closures. */
export interface CapabilityBuildInput {
  ctx: RouteContext;
  /** Names of files under .claude/scripts/ — already enumerated by the handler. */
  scripts: string[];
  /** The SecretDrop instance — required for the `secrets` block's pending count. */
  secretDrop: SecretDrop;
}

/** A single capability surfaced in the /capabilities response. */
export interface CapabilityEntry {
  /** JSON key under which this capability appears in the response body. */
  readonly key: string;
  /** Top-level route prefixes this capability owns. Drives the lint. */
  readonly prefixes: readonly string[];
  /** Human-friendly one-line description (for docs + telemetry). */
  readonly description: string;
  /** Produce the block to merge into the response. */
  readonly build: (input: CapabilityBuildInput) => unknown;
}

// ── Top-level capability entries ─────────────────────────────────────────

export const CAPABILITY_INDEX: readonly CapabilityEntry[] = [
  // E2E-PAIRING: EXEMPT — capability classification metadata only (no new endpoint
  // behavior); the subscription-pool routes already have integration + e2e tests
  // (P1.1–P2.1), and the capabilities-discoverability unit lint is the coverage for
  // this classification. Graduated from INTERNAL_PREFIXES once the quota-aware
  // scheduler (P1.3) + mobile enrollment wizard (P2.1) + dashboard tab (P2.2) made
  // it user-usable (the maturity-honesty bar the INTERNAL note set).
  {
    key: 'subscriptionPool',
    prefixes: ['/subscription-pool'],
    description: 'Subscription & Auth Standard — a multi-account subscription pool (N logins of the same provider) with live per-account quota (5h + weekly utilization + reset dates, measured burn), reset-date-optimal account selection, a hard session-continuity guarantee (a session that hits its account quota resumes on another account via --resume, never dies), proactive PRE-LIMIT swap (move a session off an account before it walls, at a lag-aware threshold — covers untagged sessions on the default login), and a mobile-first enrollment wizard (start a login, surface the public code/URL, auto-reissue an expired code). The registry stores login LOCATION (config home), never tokens. Backs the dashboard Subscriptions tab. Single-account pools are a no-op; auto-swap of live sessions is opt-in (subscriptionPool.autoSwapOnRateLimit reactive; subscriptionPool.proactiveSwap pre-limit).',
    build: ({ ctx }) => ({
      configured: !!ctx.subscriptionPool,
      accounts: ctx.subscriptionPool ? ctx.subscriptionPool.size() : 0,
      quotaPoller: !!ctx.quotaPoller,
      scheduler: !!ctx.quotaAwareScheduler,
      proactiveSwap: !!ctx.proactiveSwapMonitor,
      enrollmentWizard: !!ctx.enrollmentWizard,
      endpoints: [
        'GET /subscription-pool',
        'POST /subscription-pool',
        'GET /subscription-pool/:id',
        'PATCH /subscription-pool/:id',
        'DELETE /subscription-pool/:id',
        'POST /subscription-pool/poll',
        'GET /subscription-pool/:id/quota',
        'POST /subscription-pool/swap',
        'GET /subscription-pool/proactive-swap',
        'POST /subscription-pool/proactive-swap/check',
        'POST /subscription-pool/enroll',
        'GET /subscription-pool/pending-logins',
        'POST /subscription-pool/enroll/:id/cancel',
        'POST /subscription-pool/enroll/:id/complete',
        'POST /subscription-pool/enroll/reissue-expired',
      ],
    }),
  },
  {
    key: 'credentialRepointing',
    prefixes: ['/credentials'],
    description: 'Live credential re-pointing (WS5.2) — manual levers that MOVE a pool account\'s OAuth credential between config-home "slots" without restarting the sessions reading them (the staged §2.3 exchange), plus the ledger census + the single secret-scrub audit chokepoint. POST /credentials/swap exchanges two slots\' credentials live; POST /credentials/set-default flips which account ~/.claude serves (CMT-1337 zero-touch default flip); POST /credentials/restore-enrollment tears down to the enrollment layout, parking any identity-incoherent blob one-directionally (never exchanged into a healthy slot). GET /credentials/locations is the ledger read (slot ↔ account, since, lastVerifiedAt, quarantine, journal tail, mode); GET /credentials/rebalancer is the autonomous-balancer surface (503 in Increment A). All levers are DETECTIVE controls — operator notification + audit + param-validate + per-pair cooldown + a §0.g force budget on force:true. No token material ever exits any /credentials/* surface (the CredentialAuditEmit scrub chokepoint). Ships DARK behind subscriptionPool.credentialRepointing.enabled — every lever 503s/no-ops while disabled (byte-for-byte today\'s behavior).',
    build: ({ ctx }) => ({
      configured: !!ctx.credentialRepointing,
      enabled: resolveDevAgentGate(ctx.config.subscriptionPool?.credentialRepointing?.enabled, ctx.config),
      endpoints: [
        'GET /credentials/locations',
        'GET /credentials/rebalancer',
        'POST /credentials/swap',
        'POST /credentials/set-default',
        'POST /credentials/restore-enrollment',
      ],
    }),
  },
  {
    key: 'guardPosture',
    prefixes: ['/guards'],
    description: 'Guard Posture (GUARD-POSTURE-ENDPOINT-SPEC) — read every machine\'s safety-guard flags with HONEST verification-graded states: on-confirmed (live runtime confirms) / on-unverified (config-on only, grey not green) / on-stale (dead tick loop) / on-dry-run (watching but toothless) / off classified dark-default vs diverged-from-default (the load-shed signature — the only off that alerts) / diverged-pending-restart (disk edit not yet live) / errored / missing (expected runtime never registered) / off-runtime-divergent (runtime contradicts an on-config — the in-memory load-shed class). ?scope=pool accounts for EVERY registered machine by name (classified failure rows, never silent omission); the Machines tab shows last-known posture with age even for a dark peer (heartbeat piggyback + durable store). Read-only, always-on (deliberately no enabled gate — an off-switch on the guard-visibility surface would itself be an invisible disabled guard). When asked "are my guards on?" / "why didn\'t the watchdog fire on machine X?" / after any incident load-shed → read this, never guess. To re-enable a guard via PATCH /config, send the guard\'s FULL config block (one-level-deep merge erases sibling tuning).',
    build: ({ ctx }) => ({
      configured: true,
      runtimeEnriched: !!ctx.guardRegistry,
      pool: !!ctx.listPoolMachines,
      endpoints: ['GET /guards', 'GET /guards?scope=pool'],
    }),
  },
  {
    key: 'judgmentProvenance',
    prefixes: ['/judgment-provenance'],
    description: 'Judgment-call decision provenance (ownership-gated-spawn-and-judgment-within-floors §3.5 + llm-decision-quality-meter §5.2 — the Decision Provenance & Outcome Review standard). Every judgment call the ownership layer makes (SpawnAdmission verdicts, duplicate-reconciler intended-owner determinations) AND every ENROLLED LLM decision the router-settlement seam records (correlation-id-keyed, content-class-enveloped, volume-class-valved) is durably logged — machine-local under .instar/state/judgment-provenance/ (0700/0600, gitignored, backup-excluded, 14-day retention, NEVER HTTP-served raw: a hardcoded NEVER_SERVED_PREFIXES deny in the file routes covers read/download/edit/link incl. symlink evasion). GET /judgment-provenance serves REDACTED rows only (write-time credential-shape scrub + omission of the machine-local full context); ?limit / ?sinceHours filter; ?scope=pool merges peers\' redacted rows as clamped untrusted data. The log is constructed UNCONDITIONALLY at boot on every agent, single-machine included (FD9) — a 503 here means construction FAILED (see server log), never "single-machine so not built". When asked "why did the system decide machine X owns this conversation?" / "what did the duplicate healer see?" / "what context did that gate judge?" → read this, never guess.',
    build: ({ ctx }) => ({
      configured: !!ctx.judgmentProvenance,
      endpoints: ['GET /judgment-provenance', 'GET /pool/duplicate-reconciler', 'GET /pool/ownership-view'],
    }),
  },
  {
    key: 'decisionQuality',
    // P10: the /decision-quality routes are now registered in routes.ts
    // (GET /decision-quality + POST /decision-quality/grade-pass), so the
    // discoverability lint's "every declared prefix exists as a route" invariant
    // holds with this prefix present (structure, not memory, closed the gap).
    prefixes: ['/decision-quality'],
    description: 'LLM-Decision Quality Meter (llm-decision-quality-meter §5.5 — ACT-1193/ACT-1194): the QUALITY meter beside the cost meter — per LLM decision-point over a window: decisions made, outcomes known, grade distribution (right/wrong/unknown/expired), grade-by-rule/rung/evidence-strength breakdowns (proof-like vs heuristic never conflated; insufficient-evidence marker below the minimum sample), attribution columns (model/framework/prompt_id), census debt (wired/pending/exempt + pending-ref-dead + wired-but-silent + exempt-but-active flags), and the honest counters (orphanOutcomes/joinMiss/droppedByBudget + the four annotation-rejection classes). GET /decision-quality is the read surface (Bearer; pure indexed SQLite; ?sinceHours; ?scope=pool merges MACHINE-TAGGED rows — per-machine framework routing makes per-machine quality genuinely distinct data); POST /decision-quality/grade-pass runs ONE bounded deterministic grading pass (cursor keyset, idempotent, zero LLM spend — the hourly llm-decision-grading job template drives it, ships enabled:false). Both routes 503 when the seam is DARK on this agent (provenance.uniformSeam resolves off — dev-gated: LIVE on a development agent, DARK on the fleet; dryRun defaults TRUE even on dev) — say so honestly rather than guessing. When the operator asks "is this gate performing / does it need a bigger model or a prompt change?" → read the meter, never guess.',
    build: ({ ctx }) => ({
      configured: resolveDevAgentGate(ctx.config.provenance?.uniformSeam?.enabled, ctx.config),
      dryRun: ctx.config.provenance?.uniformSeam?.dryRun !== false,
      endpoints: ['GET /decision-quality', 'POST /decision-quality/grade-pass'],
    }),
  },
  {
    key: 'benchmarkDivergence',
    prefixes: ['/benchmark-divergence'],
    description: 'Benchmark-Divergence Detector (benchmark-divergence-detector — Increment A of the benchmark-feedback loop; parent standard Decision Provenance & Outcome Review): the observe-only detector comparing each enrolled decision point\'s REAL per-model grade-rate (quality-meter settled grades over a rolling matured-day window, pool-collected across every machine on the serving-lease holder) against the benchmark\'s PREDICTED pass-rate from the git-tracked mirror — CI-aware on BOTH sides (Wilson half-widths, so a 10-case battery cannot manufacture divergence), precondition-FIRST (a stale/missing mirror or a drifted/unverifiable prompt template suppresses divergent AND aligned — a stale benchmark never blames or credits a model), direction-split (divergent-better leads with "is the grade-rate inflated?", never "promote this model"). Every finding is advisory:true (Signal vs. Authority) and content-free (correlation-id POINTERS into the meter, never raw decision context). GET /benchmark-divergence is the read surface (Bearer; ?scope=pool merges peers\' clamped findings, questions regenerated locally); POST /benchmark-divergence/analyze triggers one lease-gated, rate-limited, idempotent pass (the daily benchmark-divergence-analysis job template drives it, ships enabled:false); GET /benchmark-divergence/rollup-aggregates is the peer collection route (serving peer clamps the range). All three 503 when the detector is DARK on this agent (benchmarkDivergence resolves off — dev-gated: LIVE-in-dryRun on a development agent, DARK on the fleet) — say so honestly rather than guessing. When the operator asks "is the benchmark still right about model X?" / "why does this gate underperform its bench score?" → read the findings, never guess.',
    build: ({ ctx }) => ({
      configured: resolveDevAgentGate(ctx.config.benchmarkDivergence?.enabled, ctx.config),
      dryRun: ctx.config.benchmarkDivergence?.dryRun !== false,
      endpoints: [
        'GET /benchmark-divergence',
        'POST /benchmark-divergence/analyze',
        'GET /benchmark-divergence/rollup-aggregates',
      ],
    }),
  },
  {
    key: 'conversationIdentity',
    prefixes: ['/conversations'],
    description: 'Durable Conversation Identity (durable-conversation-identity §8) — the read-only registry surface behind channel-agnostic conversation ids. Every conversation has ONE durable numeric identity: a Telegram topic IS its positive id (pass-through, never registered); a non-Telegram conversation (Slack channel/thread) is minted a stable NEGATIVE id at first inbound, so durable state (commitments, memory, notices) can attach to it and survive restarts. A negative topicId anywhere in state is a minted conversation id, not an error. GET /conversations lists entries + the alias table; GET /conversations/:id resolves one id (unknown negative → honest 404 "never minted on this machine"); GET /conversations/resolve?key=…|?sessionKey=… is the forward lookup that mints NOTHING; GET /conversations/health carries entry counts, origins, quarantine + snapshot-suspension state, and the growth tripwire. Recording is always-on foundation (kill-switch: conversationIdentity.recording.enabled=false degrades to legacy in-memory hashing); DELIVERY to minted ids is dev-gated (conversationIdentity.followThrough, dryRun-first). When asked "what is this negative topic id?" / "which Slack conversation is -N?" → read /conversations/:id, never guess.',
    build: () => ({
      configured: true,
      endpoints: [
        'GET /conversations',
        'GET /conversations/:id',
        'GET /conversations/resolve',
        'GET /conversations/health',
      ],
    }),
  },
  {
    key: 'doorwayRegistry',
    prefixes: ['/doorways'],
    description: 'Doorway/Model Knowledge Registry (DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC §D5) — the read-only merged map from each doorway (Claude Code, Codex, Gemini, a paid API key, …) to the top models it can currently reach: canonical topModels (git-tracked, with pricing — authoritative for routing) overlaid with this machine\'s read-validated live reachability. D5 two-state contract: 200 with scanState:"never-run" (registry present, no scan yet — live fields reachable:null/probeStatus:"never-scanned") then 200 merged once a scan runs; 503 code:"registry-unavailable-no-instar-source" (a non-instar-source install carries no manifest) or code:"registry-corrupt" (present but unparseable) — never a fabricated empty map. The recurring doorway-scan job that keeps it current ships OFF by default (job manifest enabled:false; maintenance.doorwayScan tunes it). When asked "what models can I reach?" / "is my model map current?" / "which doorways are live?" → read GET /doorways, don\'t guess.',
    build: () => ({
      configured: true,
      endpoints: ['GET /doorways'],
    }),
  },
  {
    key: 'spawnLimiter',
    prefixes: ['/spawn-limiter'],
    description: 'Fork-bomb prevention — host-wide concurrent-LLM-subprocess cap (the SIMPLE design, docs/specs/forkbomb-prevention-simple.md). A SAFETY FLOOR that ships ON for every agent (never dark): a host-local counting semaphore bounds how many `claude -p`/`codex exec` subprocesses run AT ONCE across every compliant Instar process on the host (default 8), the chokepoint for the 2026-06-20 OOM fork-bomb. GET /spawn-limiter reports the live holder count, the cap, available slots, saturation, the live concurrent-poller count (P3 bounded ingress), and the acquire budget. Tune via intelligence.spawnCap.* or env (INSTAR_HOST_SPAWN_MAX / INSTAR_SPAWN_ACQUIRE_MS / INSTAR_SPAWN_WAITERS_MAX). When asked "are we capped against a fork-bomb?" / "how many LLM spawns are running right now?" → read this.',
    build: () => ({
      configured: true,
      endpoints: ['GET /spawn-limiter'],
    }),
  },
  {
    key: 'selfActionGovernor',
    prefixes: ['/self-action-governor'],
    description: 'Unified self-action backpressure — the SelfActionGovernor (docs/specs/unified-self-action-backpressure.md, Increment B). ONE in-process admission chokepoint every registered self-triggered action (reaper age-kill, external-hog kill, proactive account-swap, beacon notify/liveness) rides via admit(), keyed on a controller id: per-target + census-scaled total count ceilings, rate buckets, P19 brakes, a bounded coalescing queue, durable admission state that survives restarts (a crash/bounce never refills a runaway loop\'s count budget), and an ALWAYS-ALLOW audited principal lane (a human action always wins). Ships OBSERVE-ONLY on every class (records would-deny verdicts, blocks nothing); the per-class enforce flip is the operator\'s later FD8 action. GET /self-action-governor is a lock-free scrubbed read of per-class mode/counters/deciding-sub-mechanism aggregates (`?scope=pool` merges pool-shared class counters across machines). Kill switch: intelligence.selfActionGovernor.emergencyDisable (read live; the flip itself is audited + surfaced). When asked "why did my respawn get held / my swap get queued / my notify get folded?" → read this route\'s per-class reasons.',
    build: ({ ctx }) => ({
      configured: !!ctx.selfActionGovernor,
      endpoints: ['GET /self-action-governor'],
    }),
  },
  {
    key: 'testRunnerLimiter',
    prefixes: ['/test-runner-limiter'],
    description: 'Test-Runner Concurrency Bound — the spawn cap\'s sibling for vitest roots (docs/specs/test-runner-concurrency-bound.md). A per-machine ticket counter bounds how many test SUITES run at once across every actor on the host (full suites one-at-a-time by default; small targeted runs get a roomier ≤6-slot lane, each clamped to ≤4 workers) — the structural answer to the 2026-07-02 test-storm load-stall kill cascade. Ships WATCH-ONLY (dry-run posture, 14-day soak): it logs would-blocks but admits every run until the enforce flip. GET /test-runner-limiter reports cap/targetedCap/posture/ttlSignalArmed, live holders per lane, per-lane saturation, admitted-open (lock-wedge) runs, the recent event tail, and a skip-reason histogram — cap + posture resolve through the SAME resolvers the chokepoint uses (env → host tuning file → code default), never from config (no-lie constraint). POST /test-runner-limiter/prune is the recovery lever: forces a full reclaim pass (dead/reused-pid + TTL-expired holders) instead of hand-editing the holders JSON. When asked "why is my test run waiting?" / "did the limiter block something?" / a git push rejected that might be CONTENTION not red tests → read the GET route first. Kill switch: env INSTAR_HOST_TEST_SEMAPHORE=off (config intelligence.testRunnerCap is NOT the chokepoint lever).',
    build: () => ({
      configured: true,
      endpoints: ['GET /test-runner-limiter', 'POST /test-runner-limiter/prune'],
    }),
  },
  {
    key: 'multiMachinePool',
    prefixes: ['/pool'],
    description: 'Multi-Machine Session Pool status — which machine holds the router + every machine\'s nickname, hardware, online status, load, and clock-skew. Backs the Machines dashboard tab and "where is this running?" / "move this to <nickname>". Single-machine until >1 paired.',
    build: ({ ctx }) => ({
      configured: !!ctx.machinePoolRegistry,
      endpoints: ['GET /pool', 'PATCH /pool/machines/:id'],
    }),
  },
  {
    key: 'releaseReadiness',
    prefixes: ['/release-readiness'],
    description: 'Release-readiness watchdog (instar-dev / maintainer environments). Surfaces a stalled release as one deduped, age-escalating Attention item. Null on installs with no analyzable instar repo.',
    build: ({ ctx }) => ({
      configured: !!ctx.releaseReadinessSentinel,
      endpoints: [
        'GET /release-readiness',
        'POST /release-readiness/tick',
        'POST /release-readiness/rollback',
        'POST /release-readiness/enable',
      ],
    }),
  },
  {
    key: 'greenPrAutoMerge',
    prefixes: ['/green-pr-automerge'],
    description: 'Green-PR auto-merge watcher (green-pr-automerge-enforcement + mergerunner-auto-arm-handoff) — lands a green, mergeable, non-held PR this agent authored, surviving session death (Phase 7 becomes machinery). Default mergeStrategy:auto ARMS GitHub native auto-merge and hands the wait off to GitHub (confirmed on a later reconciliation tick); mergeStrategy:admin is the legacy synchronous poll+merge. Off fleet-wide (deliberate-fleet-default), armed per dev agent with expectedGhLogin, repo-gated. Pool-visible rollback kill-switch (Bearer) that ALSO --disable-autos in-flight armed merges; PIN-gated re-arm + pool-disarm; conversational-hold assist (a HOLD also disables an armed PR — a label alone does NOT). GET reports armedCount + armed[]. Null on installs with no analyzable instar repo + safe-merge, or when disabled.',
    build: ({ ctx }) => ({
      configured: !!ctx.greenPrAutoMerger,
      endpoints: [
        'GET /green-pr-automerge',
        'POST /green-pr-automerge/tick',
        'POST /green-pr-automerge/rollback',
        'POST /green-pr-automerge/enable',
        'POST /green-pr-automerge/hold',
        'POST /green-pr-automerge/pool-disarm',
      ],
    }),
  },
  {
    key: 'parallelWork',
    prefixes: ['/parallel-work'],
    description: 'Parallel-Work Awareness — a cross-topic read index over the Topic-Intent layer: every topic, its current focus, high-specificity tags, and whether a session is live on it. Lets the agent see what all its hands are doing across topics/sessions (the overlap-councilor read surface; the proactive ParallelWorkSentinel is Phase B, ships dark). Signal-only; never gates.',
    build: ({ ctx }) => ({
      configured: !!ctx.parallelActivityIndex,
      endpoints: ['GET /parallel-work/activities'],
    }),
  },
  {
    key: 'autonomousHeartbeat',
    prefixes: ['/autonomous-heartbeat'],
    description: 'AutonomousProgressHeartbeat — a hedged, change-gated, sparse liveness BACKSTOP that posts ONE purely-observational line when an autonomous run has gone silent on the user for a long stretch while its terminal output is STILL changing. NOT the suppressed PromiseBeacon "still on it" filler that HONEST-PROGRESS-MESSAGING removed — it fires only on a long user-silence gate (≥25m) AND a corroborated recent output change (read from ActiveWorkSilenceSentinel\'s already-computed snapshot — a liveness signal, NOT a progress claim), with a per-topic cooldown, a widening per-run backoff + hard cap, and the shared one-voice lease. Signal-only; never gates. Dev-gated dark + dryRun-first → 503 on the fleet.',
    build: ({ ctx }) => ({
      enabled: resolveDevAgentGate(ctx.config.monitoring?.autonomousHeartbeat?.enabled, ctx.config),
      endpoints: ['GET /autonomous-heartbeat'],
    }),
  },
  {
    key: 'growthAnalyst',
    prefixes: ['/growth'],
    description: 'Growth & Milestone Analyst — composes InitiativeTracker rollout stages + staleness, ApprovalLedger approve-vs-change, and CorrectionLedger recurrence into one digest with explicit notify-rules (R1 promotion-ready, R2 incubation-expired-unproven, R3 initiative-stalling, R4 spec-pattern, R5 correction-pattern). A TIGHT incubation window whose expiry is itself the trigger, so a feature is never silently left behind; promotion requires real proof-of-life, never elapsed time alone. Ships dark (monitoring.growthAnalyst.enabled) and is compute + read-only — no Telegram sending in this slice. Null/503 when disabled.',
    build: ({ ctx }) => ({
      configured: !!ctx.growthMilestoneAnalyst,
      endpoints: [
        'GET /growth/digest',
        'GET /growth/findings',
        'GET /growth/status',
        'POST /growth/tick',
      ],
    }),
  },
  {
    key: 'blockerLedger',
    prefixes: ['/blockers'],
    description: 'Blocker Ledger — the resolution-workflow + memory layer completing Principle 1 ("almost every blocker is a false blocker — work it through"). Turns a detected blocker into a gated pipeline (candidate → authority-checked → access-requested → dry-run → live-run → resolved | true-blocker) with structural evidence-of-work at every terminal so it cannot be gamed into deferral-laundering. `resolved` requires a confined, id-referencing playbook + a successful live-run; `true-blocker` requires a closed-taxonomy reason + a recorded failed self-fetch/dry-run + a post-attempt access-request + a Tier-1 B17 LLM-authority PASS, and is stored as a decaying hypothesis re-tested on a cadence. Signal-only: it records/structures and never blocks a message (B16/B17 keep that authority); the one judgment (the true-blocker settle) routes through the B17 authority. Ships dark (monitoring.blockerLedger.enabled) → null/503 when disabled.',
    build: ({ ctx }) => ({
      configured: !!ctx.blockerLedger,
      endpoints: [
        'GET /blockers',
        'GET /blockers/:id',
        'POST /blockers',
        'POST /blockers/:id/advance',
        'POST /blockers/:id/settle',
      ],
    }),
  },
  {
    key: 'agentReadiness',
    prefixes: ['/agent-readiness'],
    description: 'Agent-Readiness Scoring (EXO 3.0 task-decomposition matrix) — score a task or workflow on its coordination-vs-judgment ratio to decide whether it is a good agent candidate. Coordination work (routing, approvals, scheduling, status-tracking) is agent-ready; judgment work (ambiguity, exceptions, relationships) stays human. Deterministic + advisory — answers a question, never gates.',
    build: () => ({
      configured: true, // pure scorer behind a dynamic import — no ctx dependency
      endpoints: ['POST /agent-readiness/score'],
    }),
  },
  {
    key: 'agentPassport',
    prefixes: ['/passport'],
    description: 'Agent Digital Passport (EXO 3.0) — the agent\'s identity (name + routing fingerprint), trust level, and ORG-INTENT constraints packaged into one portable passport, plus a deterministic peer compliance check ("is this action permitted for this passport?"). Advisory — the caller decides; never gates.',
    build: () => ({
      configured: true, // built from identity/trust/intent already on ctx paths — no hard ctx dependency
      endpoints: ['GET /passport', 'POST /passport/verify'],
    }),
  },
  {
    key: 'apprenticeshipProgram',
    prefixes: ['/apprenticeship'],
    description: 'Apprenticeship Program — instance registry, evidence-backed independence ladder, and lifecycle gates for onboarding agent frameworks. Each onboarding is a tracked instance (overseer / mentor / mentee). Ladder transitions are adjacent, require evidence, and retain append-only history. Gate and ladder verdicts are audited to logs/apprenticeship-decisions.jsonl.',
    build: ({ ctx }) => ({
      configured: !!ctx.apprenticeshipProgram || !!ctx.apprenticeshipCycleStore,
      endpoints: [
        'GET /apprenticeship/instances',
        'GET /apprenticeship/instances/:id',
        'GET /apprenticeship/instances/:id/role-coverage',
        'GET /apprenticeship/cycles',
        'GET /apprenticeship/cycles/overdue',
        'GET /apprenticeship/cycles/integrity',
        'GET /apprenticeship/cycles/:id',
        'POST /apprenticeship/instances',
        'POST /apprenticeship/instances/:id/transition',
        'POST /apprenticeship/instances/:id/rung-transition',
        'POST /apprenticeship/instances/:id/can-start',
        'POST /apprenticeship/instances/:id/can-complete',
        'POST /apprenticeship/cycles',
        'POST /apprenticeship/cycles/:id/close',
      ],
    }),
  },
  {
    key: 'telegram',
    prefixes: ['/telegram'],
    description: 'Telegram messaging adapter (bidirectional)',
    build: ({ ctx, scripts }) => {
      const hasTelegramConfig = ctx.config.messaging.some(
        (m) => m.type === 'telegram' && m.enabled,
      );
      const hasTelegramReplyScript = scripts.includes('telegram-reply.sh');
      return {
        configured: hasTelegramConfig,
        replyScript: hasTelegramReplyScript,
        adapter: !!ctx.telegram,
        bidirectional:
          hasTelegramConfig && hasTelegramReplyScript && !!ctx.telegram,
      };
    },
  },
  {
    key: 'imessage',
    prefixes: ['/imessage'],
    description: 'iMessage adapter + AppleScript send pipeline',
    build: ({ ctx }) => {
      const hasIMessageConfig =
        ctx.config.messaging?.some((m) => m.type === 'imessage' && m.enabled) ??
        false;
      return {
        configured: hasIMessageConfig,
        adapter: !!ctx.imessage,
        connected: ctx.imessage?.getConnectionInfo().state === 'connected',
        endpoints: ctx.imessage
          ? [
              'GET /imessage/status',
              'POST /imessage/validate-send/:recipient — validate + get send token (Layer 3)',
              'POST /imessage/reply/:recipient — confirm delivery with token (called by imessage-reply.sh)',
              'GET /imessage/chats',
              'GET /imessage/chats/:chatId/history',
              'GET /imessage/search?q=...',
              'GET /imessage/log-stats',
            ]
          : [],
      };
    },
  },
  {
    key: 'scheduler',
    prefixes: ['/jobs'],
    description: 'Cron-based job scheduler',
    build: ({ ctx }) => {
      let jobCount = 0;
      let jobSlugs: string[] = [];
      if (ctx.scheduler) {
        const jobs = ctx.scheduler.getJobs();
        jobCount = jobs.length;
        jobSlugs = jobs.map((j) => j.slug);
      }
      return {
        enabled: ctx.config.scheduler.enabled,
        jobCount,
        jobSlugs,
      };
    },
  },
  {
    key: 'relationships',
    prefixes: ['/relationships'],
    description: 'Relationship registry — context for personalized interactions',
    build: ({ ctx }) => {
      const relationshipsDir = ctx.config.relationships?.relationshipsDir;
      let relationshipCount = 0;
      if (relationshipsDir && fs.existsSync(relationshipsDir)) {
        try {
          relationshipCount = fs
            .readdirSync(relationshipsDir)
            .filter((f) => f.endsWith('.json')).length;
        } catch {
          /* ignore */
        }
      }
      return {
        enabled: !!ctx.config.relationships,
        count: relationshipCount,
      };
    },
  },
  {
    key: 'feedback',
    prefixes: ['/feedback'],
    description: 'Feedback channel to upstream maintainers',
    build: ({ ctx }) => ({ enabled: !!ctx.config.feedback?.enabled }),
  },
  {
    key: 'publishing',
    prefixes: ['/publish', '/published'],
    description: 'Public web pages via Telegraph (PUBLIC content)',
    build: ({ ctx }) => ({
      enabled: !!ctx.publisher,
      pageCount: ctx.publisher?.listPages().length ?? 0,
      warning:
        'Telegraph pages are PUBLIC — anyone with the URL can view them.',
      endpoints: ctx.publisher
        ? [
            'POST /publish — publish markdown as a public Telegraph page',
            'GET /published — list all published pages',
            'PUT /publish/:pagePath — edit a published page',
          ]
        : [],
    }),
  },
  {
    key: 'privateViewer',
    prefixes: ['/view', '/views'],
    description: 'Private auth-gated HTML views (the safe sharing surface)',
    build: ({ ctx }) => ({
      enabled: !!ctx.viewer,
      viewCount: ctx.viewer?.list().length ?? 0,
      endpoints: ctx.viewer
        ? [
            'POST /view — create a private auth-gated HTML view',
            'GET /views — list all private views',
            'GET /view/:viewId — render a private view (HTML)',
            'PUT /view/:viewId — update a view',
            'DELETE /view/:viewId — delete a view',
          ]
        : [],
    }),
  },
  {
    key: 'tunnel',
    prefixes: ['/tunnel'],
    description: 'Cloudflare tunnel for remote access to private viewer + API',
    build: ({ ctx }) => ({
      enabled: !!ctx.tunnel,
      running: ctx.tunnel?.isRunning ?? false,
      url: ctx.tunnel?.url ?? null,
      type: ctx.config.tunnel?.type ?? null,
    }),
  },
  {
    key: 'users',
    prefixes: [],
    description: 'Multi-user registry — counts only; no prefix because user routes live under other prefixes',
    build: ({ ctx }) => {
      let userCount = 0;
      const usersFile = path.join(ctx.config.stateDir, 'users.json');
      if (fs.existsSync(usersFile)) {
        try {
          const users = JSON.parse(fs.readFileSync(usersFile, 'utf-8'));
          if (Array.isArray(users)) userCount = users.length;
        } catch {
          /* ignore */
        }
      }
      return { count: userCount };
    },
  },
  {
    key: 'secrets',
    prefixes: ['/secrets'],
    description:
      'Secret Drop — secure one-time-link credential intake from users',
    build: ({ secretDrop }) => ({
      // Secret Drop — surfaced explicitly because /capabilities is the
      // documented self-discovery primitive. Agents that don't see this
      // block here will reach for unsafe channels (chat paste, env vars).
      enabled: true,
      pending: secretDrop.listPending().length,
      endpoints: [
        'POST /secrets/request — create a one-time submission link',
        'GET /secrets/pending — list pending submissions',
        'POST /secrets/retrieve/:token — retrieve a submitted secret (one-time read)',
        'DELETE /secrets/pending/:token — cancel a pending request',
      ],
      retrievalHint:
        'ALWAYS retrieve via `node .instar/scripts/secret-drop-retrieve.mjs TOKEN field-name` (use `--names` to discover fields). It streams the value to stdout and NEVER prints the response body. Raw curl against /secrets/retrieve dumps the secret into the Bash tool transcript — do not use it.',
    }),
  },
  {
    key: 'topicMemory',
    prefixes: ['/topic'],
    description: 'Conversation memory keyed by Telegram topic',
    build: ({ ctx }) => ({
      enabled: !!ctx.topicMemory,
      stats: ctx.topicMemory?.stats() ?? null,
      endpoints: ctx.topicMemory
        ? [
            'GET /topic/search?q=...&topic=N&limit=20',
            'GET /topic/context/:topicId?recent=30',
            'GET /topic/context/:topicId?assembled=true&prompt=...',
            'GET /session/context/:topicId?prompt=...&job=...',
            'GET /topic/list',
            'GET /topic/stats',
            'POST /topic/summarize { topicId }',
            'POST /topic/summary { topicId, summary, messageCount, lastMessageId }',
          ]
        : [],
    }),
  },
  {
    key: 'monitoring',
    prefixes: ['/monitoring'],
    description: 'Runtime monitoring — quotas, watchdogs, degradations, etc.',
    build: ({ ctx }) => ctx.config.monitoring,
  },
  {
    key: 'evolution',
    prefixes: ['/evolution'],
    description: 'Evolution proposals + learnings + gaps + actions',
    build: ({ ctx }) => ({
      enabled: !!ctx.evolution,
      subsystems: ['proposals', 'learnings', 'gaps', 'actions'],
    }),
  },
  {
    key: 'initiatives',
    prefixes: ['/initiatives'],
    description: 'Initiative & project tracker — what we are working on, plus graduated feature rollouts (auto-populated from approved specs). Check this for "what are we working on" — never answer from memory.',
    build: ({ ctx }) => {
      const tracker = (ctx as { initiativeTracker?: { list?: () => Array<{ status: string }> } }).initiativeTracker;
      if (!tracker?.list) return { enabled: false };
      const items = tracker.list();
      return {
        enabled: true,
        activeCount: items.filter(i => i.status === 'active').length,
        endpoints: [
          'get /initiatives — all initiatives (what are we working on)',
          'get /initiatives/digest — what needs a decision / is stale / ready to advance',
          'get /initiatives/:id — one initiative',
          'get /projects — project rollups',
        ],
      };
    },
  },
  {
    key: 'autonomy',
    prefixes: ['/autonomy'],
    description: 'Autonomy profile — how much freedom the agent has',
    build: ({ ctx }) =>
      ctx.autonomyManager
        ? {
            enabled: true,
            profile: ctx.autonomyManager.getProfile(),
            endpoints: [
              'GET /autonomy — full dashboard with profile, resolved state, summary, elevations',
              'GET /autonomy/summary — natural language summary',
              'POST /autonomy/profile { profile, reason } — set profile level',
              'PATCH /autonomy/notifications — update notification preferences',
              'GET /autonomy/history — profile change history',
            ],
          }
        : { enabled: false },
  },
  {
    key: 'git',
    prefixes: ['/git'],
    description: 'Git state — repo, remote, sync job status + hints',
    build: ({ ctx }) => {
      const projectDir = ctx.config.projectDir;
      const hasGitRepo = fs.existsSync(path.join(projectDir, '.git'));
      let hasRemote = false;
      let gitSyncJobEnabled = false;
      if (hasGitRepo) {
        try {
          const remote = SafeGitExecutor.readSync(['remote'], {
            cwd: projectDir,
            stdio: 'pipe',
            operation: 'src/server/CapabilityIndex.ts:git.build',
          })
            .toString()
            .trim();
          hasRemote = remote.length > 0;
        } catch {
          /* no remote */
        }
      }
      if (ctx.scheduler) {
        const gitJob = ctx.scheduler
          .getJobs()
          .find((j: { slug?: string }) => j.slug === 'git-sync');
        gitSyncJobEnabled = !!(gitJob as { enabled?: boolean })?.enabled;
      }
      return {
        inRepo: hasGitRepo,
        hasRemote,
        gitSyncJob: gitSyncJobEnabled,
        autoSyncing: hasGitRepo && hasRemote && gitSyncJobEnabled,
        agentType: ctx.config.agentType || 'standalone',
        hint:
          hasGitRepo && hasRemote && gitSyncJobEnabled
            ? 'Git sync is active — your state is automatically committed and pushed hourly.'
            : hasGitRepo && hasRemote
              ? 'Git repo with remote exists but git-sync job is not enabled. Enable it in jobs.json.'
              : hasGitRepo
                ? 'Git repo exists but no remote configured. Add one with `git remote add origin <url>`.'
                : 'No git repo. For standalone agents, run `instar git init`. For project-bound, initialize the parent repo.',
      };
    },
  },
  {
    key: 'dispatches',
    prefixes: ['/dispatches'],
    description: 'Inter-machine dispatch queue (pull/apply tasks)',
    build: ({ ctx }) => ({
      enabled: !!ctx.config.dispatches?.enabled,
      autoDispatch: !!ctx.autoDispatcher,
    }),
  },
  {
    key: 'updates',
    prefixes: ['/updates'],
    description: 'Auto-update channel (npm pull + migrator)',
    build: ({ ctx }) => ({ autoUpdate: !!ctx.autoUpdater }),
  },
  {
    key: 'playbook',
    prefixes: [],
    description:
      'Playbook context manifest — CLI-driven, no HTTP prefix surface',
    build: ({ ctx }) => {
      const playbookDir = path.join(ctx.config.stateDir, 'playbook');
      const initialized = fs.existsSync(playbookDir);
      let itemCount = 0;
      let hasManifest = false;
      if (initialized) {
        const manifestPath = path.join(playbookDir, 'context-manifest.json');
        hasManifest = fs.existsSync(manifestPath);
        if (hasManifest) {
          try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            itemCount = Array.isArray(manifest.items) ? manifest.items.length : 0;
          } catch {
            /* corrupt manifest */
          }
        }
      }
      return {
        initialized,
        itemCount,
        hasManifest,
        commands: [
          'instar playbook init — initialize the playbook system',
          'instar playbook doctor — health check',
          'instar playbook status — manifest overview',
          'instar playbook list — all context items',
          'instar playbook add — add a context item',
          'instar playbook assemble — preview trigger-based assembly',
          'instar playbook evaluate — run lifecycle (score, decay, dedup)',
          'instar playbook mount — import context from another agent',
          'instar playbook search — find items by tag',
        ],
        hint: initialized
          ? `Playbook active with ${itemCount} context items. Run 'instar playbook doctor' to verify health.`
          : "Playbook not initialized. Run 'instar playbook init' to set up adaptive context engineering.",
      };
    },
  },
  {
    key: 'attentionQueue',
    prefixes: ['/attention'],
    description: 'User-attention queue (signal needs/reviews)',
    build: () => ({
      enabled: true,
      hint: 'Use POST /attention to signal important items to the user.',
    }),
  },
  {
    key: 'commitments',
    prefixes: ['/commitments'],
    description: 'CommitmentTracker — lifecycle for agent promises',
    build: () => ({
      enabled: true,
      endpoints: [
        'GET /commitments — list commitments (filterable)',
        'GET /commitments/:id — fetch a single commitment',
        'POST /commitments — open a new commitment',
        'PATCH /commitments/:id — update status/details',
        'POST /commitments/:id/deliver — mark delivered',
        'POST /commitments/:id/withdraw — withdraw the commitment',
        'POST /commitments/:id/resume — resume a paused commitment',
        'GET /commitments/active-context — assemble active-commitment context',
      ],
    }),
  },
  {
    key: 'semantic',
    prefixes: ['/semantic'],
    description: 'Semantic memory — successor to deprecated /memory',
    build: () => ({
      enabled: true,
      endpoints: [
        'POST /semantic/remember — store a memory',
        'GET /semantic/recall/:id — fetch a memory by id',
        'GET /semantic/search?q=... — semantic search',
        'GET /semantic/search/hybrid?q=... — hybrid (vector + keyword) search',
        'POST /semantic/connect — link two memories',
        'GET /semantic/explore/:id — graph traversal from a memory',
        'POST /semantic/verify/:id — mark a memory verified',
        'POST /semantic/supersede — replace one memory with another',
        'GET /semantic/stale — list stale memories',
        'GET /semantic/stats — store statistics',
        'GET /semantic/context — assembled context for a prompt',
      ],
    }),
  },
  {
    key: 'tokens',
    prefixes: ['/tokens'],
    description: 'TokenLedger — read-only token-usage observability',
    build: () => ({
      enabled: true,
      endpoints: [
        'GET /tokens/summary — aggregate token usage',
        'GET /tokens/sessions — per-session token usage',
        'GET /tokens/by-project — usage grouped by project',
        'GET /tokens/orphans — sessions with no project binding',
      ],
    }),
  },
  {
    key: 'codexUsage',
    prefixes: ['/codex'],
    description: 'Codex usage — the codex `/status` rate-limit windows (5h + weekly) read from the on-disk rollout stream; no interactive TUI. Read-only.',
    build: () => ({
      enabled: true,
      endpoints: [
        'GET /codex/usage — freshest codex account rate-limit snapshot (primary 5h + secondary weekly windows; used/remaining percent, resets, plan, reached-type)',
      ],
    }),
  },
  {
    key: 'geminiCapacity',
    prefixes: ['/gemini'],
    description: 'Gemini capacity — live view of whether Gemini calls are currently deferred by the capacity policy (quota/rate-limit) and for how long. The escalation monitor (observe-only, ships OFF behind monitoring.geminiCapacityEscalation) raises one attention item per long block. Read-only.',
    build: () => ({
      enabled: true,
      endpoints: [
        'GET /gemini/capacity — live capacity gate: { enabled, blocked, remainingMs, deferredUntil, reason }; 503 when the escalation monitor is disabled',
      ],
    }),
  },
  {
    key: 'featureMetrics',
    prefixes: ['/metrics'],
    description: 'FeatureMetricsLedger — read-only per-feature LLM observability: per gate/sentinel cost + hit-rate, so tuning the LLM checks is evidence-based. Phase 1a (the funnel tap that feeds it is Phase 1b). Never gates.',
    build: () => ({
      enabled: true,
      endpoints: [
        'GET /metrics/features — per-feature rollup (calls, tokens incl. tokensCached, fired/no-op, fire-rate, p50/p95 latency, wait-stats) + feature×model breakdown (byModel, totals.byModel), per-framework usageCoverage, unlabeled token/call shares; ?sinceHours= / ?feature= filters',
      ],
    }),
  },
  {
    key: 'routingSpend',
    prefixes: ['/routing-spend'],
    description: 'Routing Control Room spend VIEW (Increment A) — READ-ONLY reporting: the immutable token record priced ON READ against a reviewed price manifest, plus every metered paid-door key with its caps and honest not-live/$0 state. Gates nothing, books nothing (the money ledger + O(1) gate + PIN cap controls are Increment B). Dev-gated (live on a development agent, dark on the fleet).',
    build: () => ({
      enabled: true,
      endpoints: [
        'GET /routing-spend/summary — priced spend rollup per door/model + totals; ?grain=hour|day|month|total, ?sinceHours=; honest $0/not-live-yet + loud unpricedTokens',
        'GET /routing-spend/caps — every metered key with its caps + committed ($0 in Increment A) + goLiveState (not-live)',
      ],
    }),
  },
  {
    key: 'approvalLedger',
    prefixes: ['/approvals'],
    description: 'Approval-as-Data ledger — every operator approval recorded as durable, signed data (approved-as-is vs approved-with-change with the why, vs rejected) + per-class agreement ratios. Tracks approvals wherever they occur (spec, chat, other). Read-only observability; the ratio is a signal, never a gate. The OPERATOR is the authoritative source of mode+divergences — never self-classify their intent.',
    build: ({ ctx }) => ({
      enabled: !!ctx.approvalLedger,
      endpoints: [
        'POST /approvals — record an operator decision (mode + divergences operator-sourced; inconsistent rows 400)',
        'GET /approvals?limit=N&decisionClass=X&surface=Y — list recorded decisions, newest first',
        'GET /approvals/summary — per-class { total, approvedAsIs, ratio, streak, autoApprovalEligible, divergenceCounts } + bySurface breakdown',
      ],
    }),
  },
  {
    key: 'topicOperator',
    prefixes: ['/topic-operator'],
    description: 'Verified per-topic operator binding (Know Your Principal #898) — the principal whose decisions the agent enacts in a topic, established ONLY from the authenticated sender uid (a content name can never become the operator by construction; the "Caroline" identity-bleed mode is structurally impossible). Decoupled from /topic-bindings: a topic can have a verified operator with no project binding. Feeds the cross-principal guard and the session-start <topic-operator> injection.',
    build: ({ ctx }) => ({
      enabled: !!ctx.topicOperatorStore,
      endpoints: [
        'POST /topic-operator — bind a topic operator from the AUTHENTICATED sender { topicId, platform?, uid (required), displayName? }; a blank uid is refused (a content name is never accepted)',
        'GET /topic-operator — all bound operators (names + uids)',
        'GET /topic-operator/:topicId — one topic\'s verified operator, or null when unbound',
        'GET /topic-operator/session-context?topicId=N — the <topic-operator> session-start injection block ({ present:false } when unbound)',
      ],
    }),
  },
  {
    key: 'coordinationMandate',
    prefixes: ['/mandate'],
    description: 'Coordination Mandate — deny-by-default authority gate for autonomous agent-to-agent actions. The operator\'s bounded, expiring, revocable mandate (issued from the dashboard behind their PIN) is the authorizer, never the agent. Every decision (allow AND deny) lands in a hash-chained, tamper-evident audit. With no mandate issued, every evaluation denies.',
    build: ({ ctx }) => ({
      enabled: !!ctx.coordination,
      endpoints: [
        'POST /mandate/evaluate — check an intended A2A action { action, params, agentFp, mandateId } → { decision, reason } (call BEFORE acting; a deny means stop)',
        'GET /mandate — list mandates (each with live authorshipValid)',
        'GET /mandate/:id — one mandate + verification status',
        'GET /mandate/audit?limit=N — the chained decision audit (chain.ok:false = tampering — surface it)',
        'POST /mandate/issue — PIN-GATED (operator only; agent Bearer token is refused)',
        'POST /mandate/:id/revoke — PIN-GATED (the operator kill switch)',
        'POST /mandate/:id/grants — PIN-GATED: sign user→agent floor-action grant(s) into a mandate { grants:[{floorAction,grantedTo,authorizedBy,expiresAt}] } (expiresAt MUST be <= mandate.expiresAt); re-signs so authProof covers them. The dashboard Mandates tab carries the phone-friendly form for this (pick person + action + duration + PIN) — point operators THERE, never at a terminal',
        'GET /permissions/users — registered users carrying a Slack identity ({ users: [{slackUserId,name,orgRole}] }); feeds the grant form person picker',
      ],
    }),
  },
  {
    key: 'authorizationRequest',
    prefixes: ['/authorization-requests'],
    description: 'Operator Authorization Request — agent proposes → operator approves one-tap. Instead of making the operator hand-build a mandate, the agent PRE-FILLS a structured grant request and the operator approves it with their PIN on a dead-simple "Approvals waiting for you" card. requester ≠ authorizer is preserved (a pending request confers ZERO authority; only the PIN issues the grant, via the existing signed MandateStore path; the agent can never approve its own request). The operator-facing card is SERVER-authored from the structured proposal + the registered user\'s real name — never agent free-text. Ships dev-enabled / fleet-dark.',
    build: ({ ctx }) => ({
      enabled: !!(ctx.authorizationRequests && ctx.authorizationRequests.enabled),
      endpoints: [
        'POST /authorization-requests — propose a grant (Bearer; confers no authority) { createdByAgent, proposal:{floorAction,grantedToSlackUserId,durationMs}, reason? }. Allowed floorActions: prod-deploy, money-movement, credential-access, destructive-data, external-send (grant-authority excluded). durationMs ∈ [60000, 86400000]',
        'GET /authorization-requests?status=pending — list (each row carries the server-rendered headline + createdOnMachine)',
        'GET /authorization-requests/:id — one request with its server-rendered display',
        'POST /authorization-requests/:id/approve — PIN-GATED (operator only): issues the grant via the signed MandateStore path; point operators at the dashboard Mandates tab "Approvals waiting for you" card, never a terminal',
        'POST /authorization-requests/:id/deny — PIN-GATED (operator only); denyReason required',
        'POST /authorization-requests/:id/withdraw — the proposing agent withdraws its own pending request',
      ],
    }),
  },
  {
    key: 'reviewExchange',
    prefixes: ['/review-exchange'],
    description: 'ReviewExchange — the autonomous code-review protocol (coordination-mandate spec §7 G2.3). One mutual, mandate-gated sign-off of a review artifact between the two agents named in a mandate: owner delivers the package over Threadline, peer returns an authenticated verdict, and BOTH sign-offs are evaluated through the mandate gate (sign-code-review authority) before acceptance. Linear states: proposed → delivered → verdict-recorded → complete (or changes-requested). Deny-by-default inherited: no mandate → every sign-off refuses.',
    build: ({ ctx }) => ({
      enabled: !!ctx.coordination,
      endpoints: [
        'POST /review-exchange — create { mandateId, artifact, packageRef, packageSha256, parties:[ownerFp,peerFp] } (content-addressed; sha fixed at creation)',
        'GET /review-exchange — list exchanges',
        'GET /review-exchange/:id — one exchange with its signatures + audit hashes',
        'POST /review-exchange/:id/delivered — record the Threadline delivery evidence',
        'POST /review-exchange/:id/peer-verdict — record the peer\'s authenticated verdict; "approve" is their sign-off → mandate-gated (deny → 403)',
        'POST /review-exchange/:id/sign — the owner\'s countersignature → mandate-gated; completes the mutual exchange',
      ],
    }),
  },
  {
    key: 'feedbackInbox',
    prefixes: ['/feedback-inbox'],
    description: 'Feedback-inbox drainer (feedback-factory-migration Q2b, Option-B receiving end) — read-only status of the cloud Blob-inbox → durable canonical FeedbackStore mover on the operated machine. Ships dark (feedbackFactory.receiverPersistence.enabled + Blob token env required); 503 when dark.',
    build: ({ ctx }) => ({
      enabled: !!ctx.inboxDrainer,
      endpoints: [
        'GET /feedback-inbox/status — { running, drained, duplicates, quarantined, errors, ticks, lastTickAt, lastDrainAt, lastError } (read-only counters)',
      ],
    }),
  },
  {
    key: 'feedbackFactoryProcessing',
    prefixes: ['/feedback-factory'],
    description: 'Feedback-factory PROCESSING (feedback-factory-migration §191) — the clustering/triage side of the operated instance. The InboxDrainer fills the canonical store; this clusters it. Dev-gated dark (feedbackFactory.processing) — LIVE on a development agent, 503 on the fleet. The cadenced feedback-factory-process built-in job (off by default, tier-1 supervised) drives the trigger. Appends LOCAL JSONL only — no external action, never force-closes a curated cluster.',
    build: ({ ctx }) => ({
      enabled: !!ctx.feedbackProcessing,
      endpoints: [
        'GET /feedback-factory/stats — { total, byStatus, clusterCount, dispatchCount, lastWriteAt } over the canonical store (read-only)',
        'POST /feedback-factory/process — TRIGGER one clustering pass over the canonical store (appends local JSONL; idempotent + forward-only) → { processed, metrics, stats }',
      ],
    }),
  },
  {
    key: 'cutoverReadiness',
    prefixes: ['/cutover-readiness'],
    description: 'Cutover-READINESS checker (coordination-mandate spec §7 G2.4, decision 1A) — everything UP TO the cutover door, never the door. Composes the two objective conditions from REAL durable state: the persisted import IntegrityReport (integrity-gate-pass) and the durable zero-divergence parity window with a freshness bound (parity-zero-divergence). The flip itself is the operator\'s manual click; there is NO fire-cutover route by design.',
    build: ({ ctx }) => ({
      enabled: !!ctx.cutoverReadiness,
      endpoints: [
        'GET /cutover-readiness — { ready, door:"manual-operator-click", integrity, parity, importDryRun } from durable state (read-only)',
        'POST /cutover-readiness/parity-pass — TRIGGER a server-side live parity check (fetch+compare server-side; the body contributes nothing); records the pass into the durable window',
        'POST /cutover-readiness/import-dryrun — TRIGGER a server-side import REHEARSAL (live source fetch → AS-IS import into an in-memory target → integrity gate over readback); zero durable data writes; NEVER greens the canonical integrity condition',
        'GET /cutover-readiness/import-dryrun — the last rehearsal\'s verdict (read-only, informational — not a `ready` input)',
        'POST /cutover-readiness/integrity-pass — TRIGGER the REAL pre-click integrity pass (live fetch → AS-IS import into a PERSISTED shadow, run off the event loop in a child process → integrity gate); records the verdict to the CANONICAL integrity path, so a passing report GREENS the integrity leg (and a failing one flips it closed). Load-bearing on `ready`; the cutover flip itself stays the operator\'s manual click',
      ],
    }),
  },
  {
    key: 'resourceLedger',
    prefixes: ['/resources'],
    description: 'Per-agent ResourceLedger — read-only CPU/memory + rate-limit-event observability (mirrors TokenLedger). Phase A persists rate-limit events (breaker trips + session-sentinel detections) across restarts; Phase B continuously samples CPU% + RSS of the agent server + its spawned sessions. Never gates.',
    build: ({ ctx }) => ({
      enabled: !!ctx.resourceLedger,
      endpoints: [
        'GET /resources/summary?sinceHours=N — current + windowed CPU%/RSS per source (agent-server, each session, aggregate) + sample count (Phase B)',
        'GET /resources/samples?sinceHours=N&limit=N&source=X — recent raw CPU/mem samples, newest first (Phase B)',
        'GET /resources/rate-limits?sinceHours=N — durable rate-limit-event count + rate (breaker trips headline; session-sentinel detections separate) + recent events (Phase A)',
      ],
    }),
  },
  {
    key: 'frameworkIssues',
    prefixes: ['/framework-issues'],
    description: 'Framework-Onboarding Mentor System — read-only issue-ledger observability (never gates)',
    build: ({ ctx }) => ({
      enabled: !!ctx.frameworkIssueLedger,
      endpoints: [
        'GET /framework-issues — bucket-tagged behavioral issues logged while onboarding a framework',
        'GET /framework-issues/playbook?targetFramework=X — generalizable lessons from prior frameworks, impact-ranked',
        'GET /framework-issues/capture-stats — Stage-B auto-capture funnel (runs vs observations written)',
        'GET /framework-issues/observability — bucket-distribution + leak/probable-loop/extracted counts (§15)',
        'POST /framework-issues/:id/promote — playbook lifecycle (candidate→extracted needs a non-Echo attestation)',
      ],
    }),
  },
  {
    key: 'mentorOnboarding',
    prefixes: ['/mentor'],
    description: 'Framework-Onboarding Mentor job — dormant by default (mentor.enabled=false); never gates',
    build: ({ ctx }) => ({
      enabled: !!ctx.mentorRunner,
      endpoints: [
        'GET /mentor/status — mentor mode + mentee framework (off by default)',
        'POST /mentor/tick — run one mentor heartbeat (returns {ran:false,reason:"disabled"} until enabled)',
      ],
    }),
  },
  {
    key: 'dashboardLiveInsights',
    prefixes: ['/insights'],
    description: 'Dashboard Live-LLM-Insights — the per-page Insight Strip: a plain-English headline + supporting lines over a dashboard page\'s own data, an LLM insight routed through the shared nature-router (FAST lane), cached + awareness-only (never gates, never mutates)',
    build: ({ ctx }) => ({
      // DEV-GATED: resolve through the funnel so the capability report matches the
      // construction gate — LIVE on a dev agent, DARK on the fleet.
      enabled: resolveDevAgentGate(ctx.config.dashboard?.liveInsights?.enabled, ctx.config),
      endpoints: [
        'GET /insights — every registered page\'s Insight Strip (the cross-page digest surface)',
        'GET /insights/:page — one page\'s Insight Strip',
        'GET /insights/status — content-free posture (enabled/dryRun/ttl/pageCount)',
      ],
      hint: 'Dev-gated dark (dashboard.liveInsights.enabled); routes 503 when dark. dryRun:true (dev default) serves the deterministic floor; a deliberate dryRun:false activates the LLM insight. Point the user at the dashboard Insights tab, not curl.',
    }),
  },
  {
    key: 'failureLearning',
    prefixes: ['/failures'],
    description: 'Failure-Learning Loop — instar dev-process failure forensics (which spec/tool produced a failure; what process gaps recur)',
    build: ({ ctx }) => ({
      // DEV-GATED (CMT-1438): resolve through the funnel so the capability report
      // matches the construction gate — LIVE on a dev agent, DARK on the fleet.
      enabled: resolveDevAgentGate(ctx.config.monitoring?.failureLearning?.enabled, ctx.config),
      endpoints: [
        'GET /failures — list failure records (filter by source/category/initiative/attribution)',
        'GET /failures/:id — one record',
        'GET /failures/analysis — rates by build-skill / category, coverage (answers "why do features keep breaking?")',
        'GET /failures/insights — discovered process-gap insights (once the analyzer ships)',
        'POST /failures — agent-diagnosed one-tap (requires X-Instar-Request; cite an existing initiativeId)',
      ],
      hint: 'Ships OFF; when disabled these routes 503. Scoped to instar self-hosting (toolchain attribution is repo-local).',
    }),
  },
  {
    key: 'correctionLearning',
    prefixes: ['/preferences', '/corrections'],
    description: 'Correction & Preference Learning Sentinel — turns repeated corrections into durable, structurally-injected preferences (Slice 1a) and records distilled, scrubbed correction/preference patterns (Slice 1b). The Preferences dashboard tab surfaces both read-only (Slice 2). SIGNAL-ONLY; never blocks/rewrites a message. Ships OFF (monitoring.correctionLearning.enabled).',
    build: ({ ctx }) => ({
      enabled: ctx.config.monitoring?.correctionLearning?.enabled === true,
      endpoints: [
        'GET /preferences/session-context — structured block of active learned preferences (503 when disabled; { present:false } when none)',
        'GET /corrections — list distilled, scrubbed correction/preference records (toApiView strips raw text; pagination: ?limit, ?before=<ISO> keyset cursor, ?since=<ISO> lower-bound, ?kind, ?status)',
        'GET /corrections/:id — one record (scrubbed_summary + metadata only)',
        'POST /corrections — agent-diagnosed one-tap (requires X-Instar-Request: 1)',
        'POST /corrections/analyze — 3-pronged recurrence gate + closed-loop tick (driven by the off-by-default correction-analyzer job); response includes routed.overflow + routed.rateLimited',
      ],
      hint: 'Ships OFF; when disabled these routes 503. The session-start hook fetches /preferences/session-context on every boot and injects the <auto-learned-preference> block. The /corrections API never serves raw learning text. The Preferences dashboard tab is the human read surface (plain-language preferences + scrubbed corrections).',
    }),
  },
  {
    key: 'skipLedger',
    prefixes: ['/skip-ledger'],
    description: 'Skip-ledger — workload-aware idempotency',
    build: () => ({
      enabled: true,
      hint: 'Use GET /skip-ledger to avoid re-processing items in jobs.',
    }),
  },
  {
    key: 'projectMap',
    prefixes: ['/project-map'],
    description: 'Project map — file/structure self-awareness',
    build: ({ ctx }) => ({
      enabled: !!ctx.projectMapper,
      hasSavedMap: ctx.projectMapper?.loadSavedMap() !== null,
      endpoints: ctx.projectMapper
        ? [
            'GET /project-map — full project structure (JSON, ?format=markdown, ?format=compact)',
            'POST /project-map/refresh — regenerate the project map',
          ]
        : [],
    }),
  },
  {
    key: 'cartographer',
    prefixes: ['/cartographer', '/conformance'],
    description: 'Cartographer doc-tree — semantic codebase map with git-hash staleness',
    build: ({ ctx }) => ({
      enabled: !!ctx.cartographer,
      endpoints: ctx.cartographer
        ? [
            'GET /cartographer/tree — full doc-tree (nodes with summaries + staleness)',
            'GET /cartographer/node?path=… — a single node',
            'GET /cartographer/stale — nodes whose summary has drifted from the code',
            'GET /cartographer/health — node count + staleness + freshness backlog (spec #2)',
            'POST /cartographer/node/refresh {path,summary} — inline-refresh one node\'s summary (spec #2; 503 unless freshnessSweep enabled)',
            'GET /cartographer/navigate?query=…&maxDepth=&maxResults= — minimal relevant subtree for a query: paths to scope a sub-agent to (spec #5; deterministic, observe-only)',
            'GET /conformance/coverage — per-standard enforcement-coverage of docs/STANDARDS-REGISTRY.md (spec #3; filters ?family=/?kind=/?status=gap; X-Instar-Request:1; 503 unless conformanceAudit enabled)',
            'GET /conformance/coverage/health — coverage summary: counts by enforcementKind, enforced ratio, gap + dangling-ref counts (spec #3)',
          ]
        : [],
    }),
  },
  {
    key: 'contextHierarchy',
    prefixes: ['/context'],
    description: 'Context hierarchy + dispatch table',
    build: ({ ctx }) => ({
      enabled: !!ctx.contextHierarchy,
      segments:
        ctx.contextHierarchy
          ?.listSegments()
          .map((s) => ({ id: s.id, tier: s.tier, exists: s.exists })) ?? [],
      endpoints: ctx.contextHierarchy
        ? [
            'GET /context — list all context segments with status',
            'GET /context/dispatch — dispatch table (when X, load Y)',
            'GET /context/:segmentId — load a specific context segment',
          ]
        : [],
    }),
  },
  {
    key: 'workingMemory',
    prefixes: [],
    description:
      'Working memory assembler — surfaced through /context/working-memory',
    build: ({ ctx }) => ({
      enabled: !!ctx.workingMemory,
      endpoints: ctx.workingMemory
        ? [
            'GET /context/working-memory?prompt=...&jobSlug=...&sessionId=... — token-budgeted context assembly from all memory layers',
          ]
        : [],
    }),
  },
  {
    key: 'canonicalState',
    prefixes: ['/state', '/projects'],
    description: 'Canonical state — quick-facts, anti-patterns, projects',
    build: ({ ctx }) => ({
      enabled: !!ctx.canonicalState,
      endpoints: ctx.canonicalState
        ? [
            'GET /state/quick-facts — fast answers to common questions',
            'POST /state/quick-facts — add/update a quick fact',
            'GET /state/anti-patterns — things NOT to do',
            'POST /state/anti-patterns — record a new anti-pattern',
            'GET /state/projects — all known projects',
            'POST /state/projects — register a project',
            'GET /state/summary — compact state summary',
          ]
        : [],
    }),
  },
  {
    key: 'coherence',
    prefixes: ['/coherence', '/topic-bindings'],
    description: 'Coherence gate — pre-action verification + topic bindings',
    build: ({ ctx }) => ({
      enabled: !!ctx.coherenceGate,
      endpoints: ctx.coherenceGate
        ? [
            'POST /coherence/check — pre-action coherence verification',
            'POST /coherence/reflect — generate self-reflection prompt',
            'GET /topic-bindings — list topic-project bindings',
            'POST /topic-bindings — bind a topic to a project',
          ]
        : [],
    }),
  },
  {
    key: 'responseReview',
    prefixes: ['/review'],
    description: 'Response-review pipeline + coherence proposals',
    build: ({ ctx }) => ({
      enabled: !!ctx.responseReviewGate,
      endpoints: ctx.responseReviewGate
        ? [
            'POST /review/evaluate — evaluate agent response before delivery',
            'POST /review/test — dry-run test of review pipeline',
            'GET /review/history — review audit log (filterable, 30-day retention)',
            'DELETE /review/history?sessionId=X — delete history for session (DSAR)',
            'GET /review/stats — reviewer effectiveness metrics (per-period, per-recipient)',
            'GET /coherence/proposals — patch proposal queue',
            'POST /coherence/proposals — submit a new proposal',
            'POST /coherence/proposals/:id/approve — approve a proposal',
            'POST /coherence/proposals/:id/reject — reject a proposal',
            'GET /coherence/health — coherence evolution dashboard',
            'GET /review/health — reviewer health and anomaly detection',
            'POST /review/canary — run canary tests with known-bad messages',
            'POST /review/canary-battery/run — run the daily context-laundering canary battery (503 while the conversational-context feature is dark)',
          ]
        : [],
    }),
  },
  {
    key: 'externalOperationSafety',
    prefixes: ['/operations', '/sentinel', '/trust'],
    description:
      'External operation gate + message sentinel + adaptive-trust profile',
    build: ({ ctx }) => ({
      enabled: !!ctx.operationGate,
      sentinel: !!ctx.sentinel,
      adaptiveTrust: !!ctx.adaptiveTrust,
      endpoints: ctx.operationGate
        ? [
            'POST /operations/classify — classify an operation (risk level)',
            'POST /operations/evaluate — full gate evaluation (proceed/show-plan/suggest-alternative/block)',
            'GET /operations/log — recent operation history',
            'GET /operations/permissions/:service — service permissions',
            'POST /sentinel/classify — test message classification',
            'GET /sentinel/stats — sentinel classification stats',
            'GET /trust — full trust profile',
            'GET /trust/summary — compact trust summary',
            'POST /trust/grant — explicitly grant trust',
            'GET /trust/elevations — pending elevation suggestions',
            'GET /trust/changelog — recent trust changes',
          ]
        : [],
    }),
  },
  {
    key: 'featureGuide',
    prefixes: [],
    description:
      'Context-triggered capability suggestions (no own routes; meta-guidance)',
    build: () => ({
      description:
        'Context-triggered capability suggestions. Use these proactively when context matches.',
      triggers: FEATURE_GUIDE_TRIGGERS,
    }),
  },
  {
    key: 'discovery',
    prefixes: ['/features'],
    description: 'FeatureRegistry — opt-in feature discovery + per-user state',
    build: ({ ctx }) =>
      ctx.featureRegistry
        ? {
            enabled: true,
            featureCount: ctx.featureRegistry.getAllDefinitions().length,
            summaries: ctx.featureRegistry.getSummaries(),
            evaluator: ctx.discoveryEvaluator
              ? { active: true, ...ctx.discoveryEvaluator.getStatus() }
              : { active: false },
            endpoints: [
              'GET /features — full feature registry (definitions + per-user state)',
              'GET /features/:id — single feature details with valid transitions',
              'GET /features?state=undiscovered,aware — filter by discovery state',
              'GET /features/summary — lightweight summaries only',
              'POST /features/evaluate-context — evaluate context for feature surfacing',
              'GET /features/evaluator-status — evaluator rate-limit and cache status',
            ],
          }
        : { enabled: false },
  },
  {
    key: 'autonomousSessions',
    prefixes: ['/autonomous'],
    description: 'Multi-session autonomy — concurrent per-topic autonomous jobs (list / start-gate / stop)',
    build: ({ ctx }) => {
      const maxConcurrent =
        ctx.config.autonomousSessions?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_AUTONOMOUS;
      const active = activeAutonomousJobs(ctx.config.stateDir);
      return {
        maxConcurrent,
        activeCount: active.length,
        activeTopics: active.map((j) => j.topic ?? 'legacy'),
        endpoints: [
          'GET /autonomous/sessions — list all autonomous jobs (topic, goal, iteration, paused)',
          'GET /autonomous/can-start?priority= — cap + quota gate to consult before starting a new job',
          'POST /autonomous/stop-all — stop every autonomous job ("stop everything")',
          'POST /autonomous/sessions/:topic/stop — stop one topic\'s job',
          'POST /autonomous/evaluate-completion — independent /goal-style judge: is a verifiable condition met?',
          'POST /autonomous/native-goal/set — delegate completion to the framework native /goal (injects /goal <condition>)',
          'POST /autonomous/native-goal/clear — clear the native /goal for a topic',
        ],
      };
    },
  },
];

// ── Feature-guide triggers (large static payload; isolated for readability) ──

const FEATURE_GUIDE_TRIGGERS: ReadonlyArray<{ context: string; action: string }> = [
  { context: 'User mentions a document, file, or report', action: 'Render it as a private view (POST /view) — beautiful HTML accessible on any device. If tunnel is running, shareable remotely.' },
  { context: 'User wants to share something publicly', action: 'Publish via Telegraph (POST /publish). Always warn the user it is publicly accessible.' },
  { context: 'User mentions someone by name', action: 'Check relationships (GET /relationships). Use context to personalize interactions. Offer to start tracking if not found.' },
  { context: 'User has a recurring task', action: 'Create a scheduled job in .instar/jobs.json. Explain it will run automatically.' },
  { context: 'User repeats a workflow', action: 'Create a skill in .claude/skills/. It becomes a slash command for future sessions.' },
  { context: 'User is debugging CI or deployment', action: 'Check CI health (GET /ci) for GitHub Actions status.' },
  { context: 'User asks about past events or prior conversations', action: 'Search topic memory (GET /topic/search?q=...), get topic context (GET /topic/context/:topicId), check memory, review activity logs.' },
  { context: 'User frustrated with a limitation', action: 'Check for updates (GET /updates). Check dispatches (GET /dispatches/pending). The fix may already exist.' },
  { context: 'User asks to remember something', action: 'Write to .instar/MEMORY.md. Explain it persists across sessions.' },
  { context: 'Something needs user attention later', action: 'Queue in attention system (POST /attention). More reliable than hoping they see a message.' },
  { context: 'Job processes a list of items', action: 'Use skip ledger (POST /skip-ledger/workload) to avoid re-processing on next run.' },
  { context: 'About to deploy, push, or modify files outside project', action: 'Run coherence check FIRST (POST /coherence/check). Verify you are in the right project for the current topic.' },
  { context: 'Working on a topic tied to a specific project', action: 'Check topic-project binding (GET /topic-bindings). If unbound, bind it (POST /topic-bindings) to prevent cross-project confusion.' },
  { context: 'Unsure what project this is or what files exist', action: 'Check project map (GET /project-map?format=compact) for spatial awareness — project type, key files, deployment targets.' },
  { context: 'About to call an external service API (email, calendar, messaging)', action: 'Evaluate through operation gate FIRST (POST /operations/evaluate). The gate classifies risk and decides proceed/show-plan/suggest-alternative/block.' },
  { context: 'User says to stop, cancel, or abort', action: 'MessageSentinel intercepts these automatically. For manual classification: POST /sentinel/classify.' },
  { context: 'User says "you don\'t need to ask me about X"', action: 'Grant trust explicitly (POST /trust/grant). Trust persists across sessions.' },
  { context: 'User asks about autonomy, trust level, approval settings, or how much freedom the agent has', action: 'Show autonomy summary (GET /autonomy/summary). Present in natural language — never show CLI commands.' },
  { context: 'User says "go autonomous", "handle everything yourself", "I trust you", or wants less friction', action: 'Set autonomy profile (POST /autonomy/profile { profile: "autonomous", reason: "..." }). Confirm the implications conversationally first.' },
  { context: 'User says "supervise everything", "ask me first", "I want to approve", or wants more control', action: 'Set autonomy profile (POST /autonomy/profile { profile: "cautious" or "supervised", reason: "..." }).' },
  { context: 'User wants to undo an evolution change or revert agent self-modification', action: 'Check evolution proposals (GET /evolution/proposals?status=implemented), then PATCH the proposal status back. Explain what happened and what was reverted.' },
  { context: 'User asks to adjust memory warning thresholds or stop memory alerts', action: 'Update thresholds (PATCH /monitoring/memory/thresholds with {warning, elevated, critical}). Check current state (GET /monitoring/memory).' },
  { context: 'User asks about Instar features, architecture, multi-user, or multi-machine setup', action: 'STOP — do NOT answer from memory. Run GET /capabilities first, then check `instar --help` for CLI commands, then GET /context/dispatch for the full context map. Answer ONLY from what these return.' },
  { context: 'User says to update, install latest version, or apply updates', action: 'Run POST /updates/apply immediately. Do NOT explain how to update — just do it. If you want to enable auto-updates, set updates.autoApply to true in .instar/config.json.' },
  { context: 'Agent learns a lesson, discovers a pattern, or user teaches something worth remembering', action: 'Add it to the Playbook manifest (instar playbook add). Context items persist across sessions and get assembled based on triggers. This is more structured than MEMORY.md — items have triggers, scores, and lifecycle management.' },
  { context: 'Session context feels stale or irrelevant', action: 'Run instar playbook evaluate to score items, decay stale ones, and deduplicate. Then check instar playbook status.' },
  { context: 'Another agent wants to share context', action: 'Use instar playbook mount to import their manifest with integrity verification. Only global-scoped items are accepted.' },
  { context: 'User mentions other AI agents, wants to collaborate with other agents, or asks about multi-agent communication', action: 'Check if Threadline relay is enabled (GET /threadline/status). If not enabled, explain: you have the ability to connect to a secure agent network where you can discover and message other AI agents in real time. Offer to enable it conversationally. If enabled, use threadline_discover and threadline_send.' },
  { context: 'User asks what you can do, your features, or capabilities you have not used yet', action: 'Include Threadline relay in your capability overview if not yet enabled. Explain it lets you join a network of agents for real-time secure communication — available but waiting for their go-ahead.' },
];

// ── Internal-only prefixes (intentionally NOT surfaced in /capabilities) ──

/**
 * Top-level route prefixes that are intentionally invisible to agents in
 * the /capabilities response. Each entry is a deliberate "skip" with a
 * one-line reason. The discoverability lint verifies that every prefix in
 * routes.ts is either claimed by a CAPABILITY_INDEX entry OR allowlisted
 * here — never both, never neither.
 */
export const INTERNAL_PREFIXES: ReadonlyArray<{ prefix: string; reason: string }> = [
  { prefix: 'mcp', reason: 'Dynamic MCP Lifecycle (DYNAMIC-MCP-LIFECYCLE-SPEC) — ships dark/experimental behind sessions.dynamicMcp.enabled (the routes 503 when off); the agent learns it via the CLAUDE.md awareness section, not /capabilities, until it matures past dark' },
  { prefix: 'users', reason: 'POST /users/allow-test-identity (silent-loss-refusal-conservation §2.D) — a dashboard-PIN-gated route that mints a signed allow-marker for a legitimate user whose id collides with a known test-identity marker; operator/support-only, not an agent-invokable conversational capability' },
  { prefix: 'a2a', reason: 'same-machine agent-to-agent transport — peers discover each other via AgentRegistry, not /capabilities' },
  { prefix: 'health', reason: 'basic liveness check, no auth' },
  { prefix: 'ping', reason: 'synchronous noop, used by tunnel/lifeline probes' },
  { prefix: 'whoami', reason: 'internal identity probe (sentinel/relay layer 1c)' },
  { prefix: 'capabilities', reason: 'the discovery endpoint itself — surfacing would recurse' },
  { prefix: 'internal', reason: 'internal-only IPC namespace' },
  { prefix: 'pastes', reason: 'internal Claude Code paste-callback receiver' },
  { prefix: 'listener', reason: 'internal heartbeat/listener wiring' },
  { prefix: 'live-test', reason: 'dev-only live-user-channel-proof harness (POST /live-test/multi-machine-capstone, GET /live-test/artifacts) — dev-gated + dark behind monitoring.liveTestRunner; an internal self-test surface, never an agent/user capability' },
  { prefix: 'events', reason: 'internal SSE/event-stream' },
  { prefix: 'config', reason: 'global config CRUD used by setup/migrator' },
  { prefix: 'status', reason: 'legacy status endpoint, superseded by /capabilities' },
  { prefix: 'shared-state', reason: 'legacy state primitive, superseded by canonicalState' },
  { prefix: 'backups', reason: 'backup listing is operator-only, not agent-facing' },
  { prefix: 'intelligence', reason: 'GET /intelligence/routing — operator/observability read of per-component framework routing; the capability itself is surfaced to agents via the CLAUDE.md template, not /capabilities' },
  { prefix: 'episodes', reason: 'legacy episode log, replaced by topicMemory' },
  { prefix: 'reflection', reason: 'legacy reflection log, replaced by topicMemory' },
  { prefix: 'serendipity', reason: 'operator review surface, not agent-facing' },
  { prefix: 'permissions', reason: 'Slack org permission gate (Slice 0) — dark/observe-only; registration/decision/scenario routes are operator/internal, not a user-surfaced capability until the enforce path ships' },
  { prefix: 'system-review', reason: 'legacy system review log, replaced by responseReview' },
  { prefix: 'system-reviews', reason: 'legacy system review log, replaced by responseReview' },
  { prefix: 'systems', reason: 'legacy systems registry, replaced by canonicalState.projects' },
  { prefix: 'memory', reason: 'deprecated (Deprecation/Sunset headers) → /semantic' },
  { prefix: 'messaging', reason: 'alternative surface for /telegram, /imessage, etc.' },
  { prefix: 'messages', reason: 'legacy direct message access' },
  { prefix: 'providers', reason: 'legacy provider registry, replaced by autonomy' },
  { prefix: 'quota', reason: 'operator-only quota observability' },
  { prefix: 'watchdog', reason: 'operator-only watchdog state' },
  { prefix: 'telemetry', reason: 'operator-only telemetry plumbing' },
  { prefix: 'homeostasis', reason: 'operator-only homeostasis state' },
  { prefix: 'agents', reason: 'surfaced via threadline discovery' },
  { prefix: 'delivery-queue', reason: 'operator-only relay queue observability' },
  { prefix: 'prompt-gate', reason: 'operator-only prompt-gate observability' },
  { prefix: 'scope-coherence', reason: 'operator-only scope-coherence observability' },
  { prefix: 'human-as-detector', reason: 'operator-only observability — the heat map of human-caught guardian failures; the agent-facing payoff is the silent capture + future evolution use, not a discoverable endpoint' },
  { prefix: 'topic-intent', reason: 'operator-only observability — per-topic captured facts/decisions + the capture-loop funnel; the agent-facing payoff is the silent session-start briefing + ArcCheck, not a discoverable endpoint' },
  { prefix: 'topic-profile', reason: 'operator/dashboard read-write surface for the per-topic profile (model/thinking/framework pins, TOPIC-PROFILE-SPEC §12). The agent-facing surface is CONVERSATIONAL — "use codex here" / "pin this topic to Fable" via the propose-confirm ingress, documented in the CLAUDE.md template (which explicitly says NEVER instruct the user to type /topic) — not this HTTP route, which backs the dashboard + power-user /topic command. Same class as topic-intent: not a discoverable agent endpoint.' },
  { prefix: 'spec', reason: 'build-time tool — the standards-conformance gate checks a draft spec against the constitution; used during spec authoring, not a discoverable runtime capability' },
  { prefix: 'usher', reason: 'operator-only observability — the mid-task re-surface signal pull surface + its precision metrics; signal-only, the agent-facing payoff is the future gated injection (rung 5), not a discoverable endpoint' },
  { prefix: 'rate-limit', reason: 'operator-only rate-limit-sentinel observability — agent-facing surface is the sentinel’s own notices' },
  { prefix: 'action-claim', reason: 'internal Stop-hook ingest for the action-claim follow-through sentinel (dark by default, messaging.actionClaim.enabled) — the hook posts here; the agent-facing payoff is the silent follow-through commitment, not a discoverable endpoint' },
  { prefix: 'slack', reason: 'surfaced via messaging adapters' },
  { prefix: 'whatsapp', reason: 'surfaced via messaging adapters' },
  { prefix: 'flows', reason: 'surfaced inside `evolution` subsystems' },
  // NOTE: `initiatives` is intentionally NOT suppressed. The Graduated Feature
  // Rollout standard (GRADUATED-FEATURE-ROLLOUT-SPEC §4.5) requires the agent to
  // reach for /initiatives reflexively for "what are we working on" — the prior
  // suppression ("surfaced inside evolution subsystems") left the tracker
  // un-discoverable, which is why it was never used. Surfaced directly now.
  { prefix: 'triage', reason: 'surfaced inside `evolution` subsystems' },
  { prefix: 'intent', reason: 'surfaced inside `evolution` subsystems' },
  { prefix: 'self-knowledge', reason: 'surfaced inside `capability-map`' },
  { prefix: 'capability-map', reason: 'separate self-knowledge surface with its own discovery path' },
  { prefix: 'build', reason: 'operator-only build endpoint' },
  { prefix: 'sessions', reason: 'operator/dashboard session surface (listing/streaming/refresh stay dashboard-facing). ONE agent-facing verb exists — POST /sessions/:name/remote-close, the relayed operator close (REMOTE-SESSION-CLOSE-SPEC §2.4) — surfaced via the CLAUDE.md template (Multi-Machine Session Pool section) rather than graduating the prefix: a deliberate pass, no new top-level prefix.' },
  { prefix: 'worktrees', reason: 'AgentWorktreeReaper read-only report (reclaimable stale worktrees) — operational observability the agent READS, like /sessions/reap-log; not a user-invokable capability' },
  { prefix: 'processes', reason: 'McpProcessReaper read-only report (reclaimable leaked MCP-server procs + per-proc keep/reap verdict) — operational observability the agent READS, like /worktrees/agent-reaper; not a user-invokable capability' },
  { prefix: 'orphaned-work', reason: 'OrphanedWorkSentinel read-only snapshot (agent worktrees with uncommitted work whose owning session died — the silent-uncommitted-death backstop) — operational observability the agent READS, like /worktrees/agent-reaper; dev-gated dark, 503 on the fleet; not a user-invokable capability' },
  { prefix: 'external-hog', reason: 'ExternalHogSentinel status (GET) + the PIN-gated arm / Bearer disarm (POST) for the external-hog zombie auto-kill sentinel — operational observability the agent READS + an operator PIN action, like /green-pr-automerge; dev-gated dark, 503 on the fleet; surfaced via the CLAUDE.md agent-awareness section, not a user-invokable capability' },
  { prefix: 'playwright-profiles', reason: 'dev-gated Playwright profile↔accounts registry; surfaced to agents via the CLAUDE.md template + the session-start boot block (503 on the fleet), not /capabilities — same class as intelligence/topic-profile' },
  { prefix: 'pr-leases', reason: 'dev-gated parallel-hand PR-push lease (stops two of my own sessions racing one branch); a PreToolUse git-push guard consults it and the CLAUDE.md template documents it — internal coordination machinery, 503 on the fleet, not a user-invokable capability' },
  { prefix: 'sleep', reason: 'SleepController read-only verdict (agent hard-sleep decision + which guard holds it awake) — operational observability the agent READS; not a user-invokable capability' },
  { prefix: 'gemini-loop', reason: 'GeminiLoopRunner (need-gem-002) multi-turn loop-driver — the dark, developmentAgent-gated mechanism the apprenticeship machinery uses to drive a Gemini mentee across turns. 503 on the fleet (dark); not a general user-invokable capability yet. Reclassify under apprenticeshipProgram if/when it graduates live.' },
  { prefix: 'ci', reason: 'operator-only CI status surface' },
  { prefix: 'session', reason: 'single-session context surfaced via topicMemory endpoints' },
  { prefix: 'identity', reason: 'identity files surfaced via the top-level `identity` field of the response' },
  { prefix: 'hooks', reason: 'hook listing surfaced via the top-level `hooks` field of the response' },
  { prefix: 'threadline', reason: 'surfaced via discovery (threadline-relay feature)' },
  { prefix: 'mesh', reason: 'machine-to-machine MeshRpc transport (§L0 Session Pool) — Ed25519-signed, recipient-bound peer commands; never an agent/user capability. (GET /mesh/rope-health — U4.5 rope-health read surface — shares this prefix; it is agent-surfaced via the CLAUDE.md template proactive trigger + the rope-health-digest job rather than discovery.)' },
  { prefix: 'mesh-selfheal', reason: 'G3 lease-gated-spawn promotion-evidence surface (MESH-SELF-HEAL-SPEC §3.3) — read-only soak ledger (would-have-prevented-duplicate / would-have-cleared-stale-binding + promotion recommendation) the agent READS for the dark-feature graduation loop; operational observability like /worktrees/agent-reaper, not a user-invokable capability' },
  { prefix: 'session-pool', reason: 'session-pool rollout-gate E2E results (§Rollout) — operator observability for a dark feature, not a conversational capability' },
  { prefix: 'write-admission', reason: 'standby-write reconciliation status surface (docs/specs/standby-write-reconciliation.md P2-6/F9) — read-only per-domain admission counters + recent typed refusals + the event-loop-lag gauge the agent READS to answer "are writes hanging or being refused?"; dev-gated dark (503 on the fleet, dry-run first) and agent-surfaced via the CLAUDE.md "Write Admission" awareness section rather than discovery — operational observability like /mesh-selfheal and /worktrees/agent-reaper, not a user-invokable capability' },
];

// ── Public helpers ───────────────────────────────────────────────────────

/**
 * Map every top-level route prefix to its CapabilityIndex key (for entries
 * that claim prefixes). Lint uses this to verify routes.ts has full coverage.
 */
export function buildPrefixToKeyMap(): Map<string, string> {
  const m = new Map<string, string>();
  for (const entry of CAPABILITY_INDEX) {
    for (const prefix of entry.prefixes) {
      // Strip leading slash for symmetry with route extraction.
      const normalized = prefix.startsWith('/') ? prefix.slice(1) : prefix;
      m.set(normalized, entry.key);
    }
  }
  return m;
}

/** Set of all prefixes that should NOT appear in /capabilities. */
export function buildInternalPrefixSet(): Set<string> {
  return new Set(INTERNAL_PREFIXES.map((e) => e.prefix));
}

/** Iterate the index and produce the full capability-block object. */
export function buildAllCapabilityBlocks(
  input: CapabilityBuildInput,
): Record<string, unknown> {
  const blocks: Record<string, unknown> = {};
  for (const entry of CAPABILITY_INDEX) {
    blocks[entry.key] = entry.build(input);
  }
  return blocks;
}
