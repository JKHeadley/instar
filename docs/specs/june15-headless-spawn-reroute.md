---
title: Headless Spawn Reroute — June-15 Interactive-Only Readiness (PR 2)
status: converged
created: 2026-06-05
owner: echo
parent-spec: docs/specs/provider-substrate-live-wiring.md
parent-principle: "Framework-Agnostic — and Framework-Optimizing"
eli16-overview: june15-headless-spawn-reroute.eli16.md
review-convergence: "2026-06-06T04:05:00Z"
convergence-panel: "5-angle adversarial (correctness/wiring BLOCK→folded F1–F6; security/cost BLOCK→folded S1–S4; ops/scale BLOCK→folded O1–O4; standards/lessons BLOCK→folded F1–F6; spec-vs-reality BLOCK→census corrected T4/T8/+2b). All findings incorporated 2026-06-05 eve."
approved: true
approved-by: "Justin (topic 9984, 2026-06-05 — explicit post-convergence approval after reviewing the published convergence report: 'fantastic! you have my approval if needed. please continue!' — on top of the standing June-15 directive and his 2026-05-15-locked spec 04 Rule 1)"
approved-date: "2026-06-05"
---

# Headless Spawn Reroute (June-15 readiness, PR 2)

**Driving authority:** same as PR 1 (#873): `specs/provider-portability/
04-anthropic-path-constraints.md` Rule 1 (subscription floor mandatory,
locked by Justin 2026-05-15) + Justin's 2026-06-05 directive in topic 9984.
Tracked as **CMT-1112** (reopened from falsely-auto-delivered CMT-1105).

## Problem

PR 1 wired the INTERNAL intelligence funnel (sentinels/gates/extractors →
`buildIntelligenceProvider`) onto the subscription path. But Instar's other
headless-spawn surface — full agentic one-shots launched as `claude -p`
sessions in tmux — still bills the Agent SDK pot post-June-15 with no
reroute. Grounded callsite census (2026-06-05, vs main @ #873):

| # | Trigger | Callsite | Path |
|---|---------|----------|------|
| 1 | Scheduled jobs | `JobScheduler.ts:838` | `SessionManager.spawnSession()` → `buildHeadlessLaunch()` (SessionManager:1308) |
| 2 | Mentor loop A/C | `AgentServer.ts:2192, 2461` | same SessionManager path |
| 2b | Mentee-receiver | `AgentServer.ts:1782` | same (census addition from review — symmetric to Class 2, auto-covered by the funnel) |
| 3 | Dispatch executor | `DispatchExecutor.ts:572` | same |
| 4 | Upgrade notify | `UpgradeNotifyManager.ts:139` | same shape — but the class is NOT instantiated anywhere in production `src/` today (defined + unit-tested only). Listed as dormant, not live traffic; auto-covered if ever wired. |
| 5 | POST /sessions/spawn | `routes.ts:4496` | same |
| 6 | Threadline A2A cold | `ThreadlineRouter.ts:872` → `SpawnRequestManager:599` | same, with `--session-id` pinning |
| 7 | Pipe sessions | `PipeSessionSpawner.ts:303` | direct `buildHeadlessLaunch()` + shell (NO SessionManager) |
| 8 | Factory-bypass fallbacks | `reflect.ts:368`, `server.ts:3100/3236/4932` | direct `new ClaudeCliIntelligenceProvider` (server.ts lines re-verified vs v1.3.331) |

Classes 1–6 (incl. 2b) funnel through ONE site:
`SessionManager.spawnSession()`'s headless branch. That is the leverage
point (~70%+ of live spawn traffic). Adapter-level `claude -p` construction
(`ClaudeCliIntelligenceProvider`, `agenticSessionHeadless`) is the internal
intelligence funnel PR 1 already routes — out of scope here by design.

## Design

### The core switch (Class 1–5)

`SessionManager.spawnSession()`, headless branch, framework `claude-code`
only: when `intelligence.subscriptionPath.mode` is `force` (and `auto` under
SDK-pot pressure, same shared `decideSdkVsSubscription` from PR 1), the
spawn is rerouted onto the interactive path. **This is a control-flow fork,
not a launch-spec swap** (correctness review F3): the headless branch today
delivers the prompt atomically as the `-p` argv positional and returns right
after `tmux new-session` — it has NO ready-wait or inject machinery. The
reroute delegates to the `spawnInteractiveSession`-style delivery chain
(`handleReadyAndInject` → `waitForClaudeReadyWithRetry` → guarded inject),
inheriting its ~90s ready-gate worst-case latency per spawn (acceptable:
jobs/A2A are not latency-critical, and the alternative is billing failure).
The session keeps the same name, `jobSlug`, watchdogs, and reaper semantics.

**Launch-option parity (F4 — load-bearing):** the headless path splices
`--allowedTools` and `--strict-mcp-config --mcp-config {}` via
`claudeHeadlessExtraFlags` (frameworkSessionLaunch.ts:583); the interactive
claude builder supports neither. Both flags are valid interactive flags and
`claudeHeadlessExtraFlags` is gated only on `framework === 'claude-code'` —
the reroute calls it and splices into the interactive argv. Without this, a
rerouted MCP-restricted job (jobs pass `disableProjectMcp: job.mcpAccess ===
'none'`; the mentor loop passes `disableProjectMcp: true`) re-introduces the
documented ~4.5-min OAuth-remote-MCP boot hang. Parity asserted by test.

**Job-result integrity (F1 consequence):** `JobScheduler` finalizes from the
`sessionComplete` event (`result: status === 'killed' ? 'timeout' : …`,
JobScheduler.ts:1109). A rerouted job MUST flip `sessionComplete` on the
completion signal below — otherwise every rerouted job burns its full
duration budget and records `timeout`, corrupting run history. A wiring test
asserts a rerouted job records `success` on normal completion, and (F5) that
a rerouted mentor spawn leaves `running` within the timeout.

**Pane geometry (F6):** the rerouted tmux block sets `-x 200 -y 50` (the
interactive default) — `detectClaudePrompt` reads the last lines for the
`❯`/status markers and was tuned for the wide pane; the headless block's
80×24 default makes ready/idle detection flaky.

**Completion detection is the crux — the MECHANISM exists, the SIGNAL does
not.** Headless sessions signal completion by process exit; interactive ones
don't exit. `SessionManager.detectCompletion()` (pattern scan over captured
pane, already consulted at SessionManager:888) is the existing mechanism —
but its default `completionPatterns` (`Config.ts:816`: "has been
automatically paused" / "Session ended" / "Interrupted by user") are
session-DEATH phrases an interactive REPL never prints on task completion.
Relying on them alone means rerouted sessions are NEVER reaped and pile onto
the 5h window. So the reroute supplies its own deterministic signal: the
injected prompt instructs the model to print a sentinel line
(`INSTAR_JOB_COMPLETE <sessionId-suffix>`) as its final output, and the
rerouted session's record carries BOTH the **net-new field
`completionMode: 'pattern'`** (no such field exists today — new state the
monitor loop learns to read) AND a per-session `completionPattern` set to
that sentinel. Belt-and-suspenders: a hard `maxLifetimeMinutes` on rerouted
sessions (default 45, configurable) bounds the leak when the model phrases
its finish differently — on expiry the session is killed + the timeout is
DegradationReporter-reported. Both sides of the new field get
decision-boundary tests: `'pattern'` → reap on sentinel/lifetime;
default/unset → today's exit-based behavior, byte-for-byte.

- Decision boundary tests must cover BOTH sides: `off`/non-claude → byte-for-
  byte `buildHeadlessLaunch` argv (pin test, like PR 1's); `force` → zero
  `-p` in argv, interactive spec + injection.
- `auto` consults the same TTL-cached credit reader registered at boot
  (PR 1's `bootRegistration`), via the shared pure decision function — the
  routing layers cannot drift.
- Codex/Gemini frameworks: UNTOUCHED (the lever is Anthropic-billing-specific;
  their headless paths don't draw the Anthropic SDK pot).

### A2A cold spawns (Class 6) — continuity constraint

Cold A2A spawns pin `--session-id <uuid>` persisted in `ThreadResumeMap`; an
interactive session created via the reroute must preserve resume continuity.
`buildInteractiveLaunch` supports `sessionId` (used by conversation respawns)
— the reroute carries the SAME flag through, so the transcript lands at the
pinned UUID and `claude --resume <uuid>` keeps working. A wiring-integrity
test proves: rerouted cold spawn → transcript exists at the pinned UUID →
resume works. If any gap appears live, class 6 falls back to headless under
`auto` (degradation-reported), and only `force` insists.

### Explicit non-goals (PR 3+ if soak data demands)

- **PipeSessionSpawner (Class 7):** structurally isolated (no SessionManager,
  raw argv + shell). Under `force` it gets the simple change only: refuse to
  spawn + DegradationReporter event + route the reply through the normal A2A
  path (which IS rerouted). Full pool/SessionManager integration is out.
  <!-- tracked: CMT-1112 -->
- **Class 8 fallback constructions:** wrapped with the same router logic the
  factory uses (EASY, in scope — four small callsites).
- Fleet default flip <!-- tracked: CMT-1112 -->, the 24h soak itself
  <!-- tracked: CMT-1112 -->, pool permission-hardening
  <!-- tracked: CMT-1112 -->.

### Structural guards (Structure > Willpower — review findings F2/F5/F6)

- **Funnel lint (F5):** `buildHeadlessLaunch` is exported and directly
  callable — nothing today stops a FUTURE callsite from silently
  re-introducing `claude -p` SDK-pot traffic outside the reroute. PR 2 ships
  a lint (mirroring `scripts/lint-no-unfunneled-topic-creation.js`) that
  refuses direct `buildHeadlessLaunch` imports/calls outside an allowlist
  (`SessionManager.ts` + the deliberately-isolated `PipeSessionSpawner.ts`),
  wired into the standard lint chain so a bypass fails CI.
- **Agent Awareness correction + NEW migration (F2):** PR 1's CLAUDE.md
  template block scopes the lever to "internal background LLM calls
  (sentinels, gates, extractors)" — after PR 2 that wording is factually
  incomplete (the same key now covers jobs/A2A/dispatch/upgrade-notify
  spawns). PR 2 edits the template block AND adds a NEW idempotent
  `PostUpdateMigrator` migration with a DIFFERENT content-sniff (the
  existing `/providers/registry` sniff is already satisfied on deployed
  agents and cannot be reused) so the corrected wording reaches the
  deployed fleet, not just fresh inits.
- **Auto-fallback recurrence cap (F6):** the Class-6 `auto` fallback to
  headless is self-healing — a continuity gap that silently falls back on
  EVERY cold spawn would look fine while defeating the reroute entirely.
  The fallback counts per rolling window; recurrence past the cap raises
  ONE escalated DegradationReporter event ("class-6 reroute is dead, not
  transiently degraded"), so the self-heal cannot mask a dead reroute.

### Verification map (F1)

| Truth | Test |
|---|---|
| V1 `off`/unset → byte-for-byte today's headless argv at every touched callsite | unit argv pin (PR 1 pattern) |
| V2 `force` (claude-code) → spawn argv contains zero `-p`; interactive spec + injected prompt | unit on the launch decision + integration on spawnSession |
| V3 completionMode both sides: `'pattern'` reaps on detectCompletion; unset keeps exit semantics | unit decision-boundary pair |
| V4 A2A continuity: rerouted cold spawn lands transcript at pinned UUID; `--resume` works | wiring-integrity test |
| V5 Non-claude frameworks byte-for-byte untouched under every mode | unit pin |
| V6 **e2e aliveness (the spawn-path "200 not 503")**: production-mirroring boot + `mode: force` + a REAL `spawnSession()` job spawn → live tmux argv has no `-p`, pane shows an interactive REPL, session reaches pattern-completion via the real `detectCompletion()` and is reaped | `tests/e2e/june15-headless-spawn-reroute.test.ts` |
| V7 funnel lint: a fixture file calling `buildHeadlessLaunch` outside the allowlist fails the lint | lint self-test |

### Ops/scale gates (review findings O2–O4; O1 = the completion sentinel above)

- **O2 (memory envelope):** each held REPL is ~200–500MB RSS
  (SessionManager.ts:86). Headless one-shots exit in seconds; rerouted
  REPLs linger — worst case `maxSessions` (10) × 500MB = 2–5GB, the exact
  2026-06-05 laptop-meltdown class. The `subscriptionPath.maxRerouted` cap
  (S1) bounds concurrency ACROSS classes (jobs + A2A + mentor — A2A/mentor
  spawns carry no `jobSlug` and today are bounded only by the global
  `maxSessions`), AND the reroute branch adds a memory-pressure pre-spawn
  gate: under elevated/critical host pressure it refuses to reroute (under
  `auto` → degradation-reported headless fallback; under `force` → the
  spawn queues/denies loudly rather than melting the host).
- **O3 (restart reconciliation / double-execution):** after a server
  restart, a rerouted job REPL is still ALIVE in tmux (boot purge keeps
  alive sessions) but `JobScheduler.activeRunIds` (in-memory Map) is lost,
  and `triggerJob` has no per-slug already-running guard — the same slug
  can re-trigger on its next cron tick while the orphan REPL still runs:
  double execution, double billing. PR 2 ships (a) a per-slug guard in
  `triggerJob` (skip + log when a live session with that `jobSlug`
  exists), and (b) boot-time reconciliation of rerouted job sessions
  (adopt-or-kill, mirroring PR 1's pool orphan recovery). A
  restart-recovery test proves a mid-run rerouted job is not
  double-executed.
- **O4 (positive lane observability):** DegradationReporter covers only
  degraded paths; the soak needs a HAPPY-path marker. PR 2 adds a
  persisted `Session.launchLane: 'headless' | 'rerouted-interactive'`
  field, surfaced in `GET /sessions` and the reap-log, plus a
  transition-only log line at the reroute decision (mirroring PR 1's
  `onRoute`). The soak's success criterion — **zero `launchLane:
  'headless'` claude-code spawns under `force`** — becomes machine-
  checkable from `/sessions`, not inferable from reap reasons.

### Security/cost gates (review findings S1–S4)

- **S1 (HIGH — quota backpressure):** jobs are already load-shed
  (`scheduler.canRunJob = quotaTracker.canRunJob`, server.ts:3431, gating on
  the REAL subscription 5h window) — but `SpawnRequestManager` (A2A cold
  spawns) and `PipeSessionSpawner` check only session-count/memory, ZERO
  quota awareness. Rerouted, they'd point uncapped peer-driven traffic at
  the operator's primary account: a peer-triggered rate-limit DoS that
  blocks the USER's own conversations. PR 2 injects
  `quotaTracker.shouldSpawnSession(priority)` into both paths (deny/queue on
  `!allowed`, degradation-reported) and adds a concurrency ceiling for
  rerouted A2A+pipe sessions (`subscriptionPath.maxRerouted`, default 3 —
  analogous to `maxParallelJobs ?? 2`).
- **S2 (MED — paste-escape injection):** `rawInject` (SessionManager:3106)
  wraps prompts in bracketed-paste `\x1b[200~…\x1b[201~` but never strips an
  EMBEDDED `\x1b[201~` from prompt content — a job/A2A prompt containing
  that byte sequence forges a paste boundary and submits extra REPL turns
  (the headless `-p` argv path was immune; InputGuard only scans
  topic-bound sessions). Fix shipped in PR 2: strip `/\x1b\[20[01]~/g`
  inside `rawInject` before wrapping.
- **S3 (MED — MCP-boot hang parity):** headless splices
  `--strict-mcp-config --mcp-config {}` (claudeHeadlessExtraFlags,
  frameworkSessionLaunch.ts:583) to avoid the documented OAuth-remote-MCP
  boot hang; `buildInteractiveLaunch` has no equivalent. PR 2 threads
  `disableProjectMcp` into the interactive builder so rerouted sessions
  don't re-introduce the hang.
- **S4 (LOW — pinned mechanics):** force-mode pipe refusal MUST return
  `{spawned: false, reason}` from inside `spawn()` (NOT a skip at the
  eligibility gate) — that is the only shape where the DegradationReporter
  event fires AND control falls through (server.ts:8604/8626) to the
  rerouted A2A path. Verified: only `spawned === true` short-circuits.

## Safety / review gates

- Default-off invariance: `off` (fleet default) is byte-for-byte today's
  argv at EVERY touched callsite, pinned by test.
- No double-wrap: the factory already wraps breaker→router (PR 1); the
  SessionManager reroute is launch-spec-level, not provider-level — assert
  no path constructs a router around a router.
- DegradationReporter on every refused/degraded spawn (force-mode pipe
  refusal, auto-mode fallback) — no silent path changes.
- 3-tier tests (Testing Integrity) + 5-reviewer adversarial panel before
  merge, same as PR 1.

## ELI16 overview

See `june15-headless-spawn-reroute.eli16.md` (sibling).
