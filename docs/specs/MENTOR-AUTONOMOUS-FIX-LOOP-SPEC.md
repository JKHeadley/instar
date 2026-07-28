---
title: Mentor Autonomous-Fix Loop — the "just be Echo" guardian
status: approved
review-convergence: converged
approved: true
approval-basis: >
  Direct user directive (Justin, 2026-05-29, topic 13435). After I verified that
  the automated mentor job only OBSERVES + LOGS (it assigns the mentee a task and
  captures findings to a read-only ledger, but never fixes anything), Justin said:
  "Yes, just make sure all the fixing is done by an opus model just like you're
  running now it should replicate exactly what you've been doing in this thread.
  In fact, if it could just be you taking on that job that would be ideal." That
  resolves the one open design decision (full auto-fix vs propose) in favour of
  full auto-fix, performed by an Opus session that is an Echo clone.
eli16-overview: MENTOR-AUTONOMOUS-FIX-LOOP-SPEC.eli16.md
date: 2026-05-29
---

# Mentor Autonomous-Fix Loop — the "just be Echo" guardian

## Problem

The Framework-Onboarding mentor heartbeat (`runMentorTick`) OBSERVES and LOGS. Each
cycle it spawns a tool-less haiku session to compose a check-in, runs Stage-B
forensics over the mentee's signals, and captures findings to a read-only issue
ledger. It never FIXES anything: the "watch the experience and fix what's broken
as shipped code" half of the dogfooding loop is done by a developer by hand.

Justin's intent is that the automated job do the WHOLE loop — assign the mentee a
real task, observe both the Telegram UX and the mentee's internals, and fix every
issue it finds as a proper fleet PR — with all fixing done by an Opus model, "just
be you taking on that job."

## Design

Add a config-gated GUARDIAN execution path to the mentor heartbeat. When
`mentor.autonomousFix.enabled` is true, the heartbeat stops running the haiku
observe-pipeline and instead keeps ONE full-tool **Opus** session alive on the
manual dogfooding loop. The spawned session IS an Echo clone: it runs one full
cycle (health-check → assign → observe → fix-as-PR → report) and exits; the
guardian — not the session — starts the next cycle on its own heartbeat.

### Components

1. **`MentorAutonomousGuardian` (pure)** — `runAutonomousGuardian(deps)` runs the
   gate sequence and spawns. Every side-effect (the spawn, the alive-check, the
   goal builder) is injected, so the gate logic is unit-tested with no
   SessionManager / tmux / LLM. `buildAutoloopGoal(params)` is the deterministic
   default goal-prompt that encodes the loop and the discipline.

2. **`MentorOnboardingRunner` branch** — `tick()` routes to `autonomousTick()`
   when `autonomousFix.enabled`, regardless of `mode` (mode gates only the haiku
   pipeline). The runner wires the injected guardian services and advances the
   per-day + min-interval counters when a cycle actually spawns.

3. **`AgentServer` wiring** — `spawnLoopSession` spawns a full-tool session
   (`allowedTools` omitted → Echo's default toolset; `model` from config → opus;
   a deterministic `mentor-autoloop-<ts>` name; `maxDurationMinutes` from
   `maxCycleMinutes`). `loopSessionAlive` matches any running session whose name
   carries the prefix. `buildAutoloopGoal` is parameterized from config.

### Gate sequence (load-bearing order)

`enabled → budget → single-instance → min-interval → spawn`.

- **enabled** — ships dark; a disabled config never spawns or spends.
- **budget** — fail-closed BEFORE any spawn (the mentor per-day round cap).
- **single-instance** — at most ONE loop session. A cycle (assign → observe →
  fix-as-PR → report) outlives many heartbeat ticks, so this gate is what stops a
  15-minute heartbeat from spawn-storming expensive Opus sessions: if a loop
  session is alive, the tick is a deliberate no-op (`reason: 'loop-active'`).
- **min-interval** — a floor before respawning after a cycle ends, so a
  fast-finishing or fast-failing cycle cannot busy-loop.

A spawn that throws surfaces as `reason: 'spawn-failed'` with the underlying error
in `GET /mentor/status .lastResult.error` — never a silent no-op.

### The goal prompt

`buildAutoloopGoal` encodes one full cycle: (1) health-check the mentee and
recover it self-healingly if it is down; (2) assign one real instar task over
Telegram; (3) observe both the Telegram UX and the mentee's internals; (4) fix any
issue as a proper fleet PR through the full ship gate; (5) report honestly,
including anything skipped or still failing. It carries the same
verify-before-you-claim, no-narrated-tool-calls discipline a developer uses, and
ends with "one cycle, then exit" so the session never spawns a copy of itself. A
host may override it via `mentor.autonomousFix.goalTemplate`.

## Safety

- Ships **dark**: `mentor.autonomousFix.enabled` defaults false. Opt-in per agent.
- The expensive Opus session spawns only behind all four gates, so it never
  idle-burns or spawn-storms.
- The spawned Echo ships fixes through the SAME structural ship gate as an
  interactive developer (husky pre-commit, the instar-dev gate, CI branch
  protection). Those gates do not care whether the author is interactive or
  autonomous, so an autonomous fix cannot land code that fails CI.
- `maxCycleMinutes` bounds a runaway cycle.

## Migration parity

`mentor.autonomousFix` is added to `ConfigDefaults` (`SHARED_DEFAULTS`), so
`migrateConfig`'s `applyDefaults` deep-merge adds the dark sub-block to existing
agents on update (existence-checked, never overwriting an operator's choice). The
CLAUDE.md mentor section gains an autonomous-fix-loop paragraph in both new-agent
generation and `migrateClaudeMd` (a content-sniffed paragraph for agents that
already have the section). No new job is needed: the existing
`mentor-onboarding` heartbeat drives the guardian.

## Testing

- **Tier 1 unit** — `MentorAutonomousGuardian.test.ts`: every gate, both sides,
  gate-order, spawn-failure surfacing, and the goal-prompt assembly.
  `MentorOnboardingRunner.test.ts`: the branch routes to the guardian (not the
  observe-pipeline) regardless of mode; single-instance; counter advancement;
  the unwired-spawner clear error; the dark default.
- **Tier 2 integration** — `mentor-routes.test.ts`: `POST /mentor/tick` routes to
  the guardian over HTTP and respects single-instance.
- **Tier 3 E2E** — `mentor-onboarding-lifecycle.test.ts`: the REAL AgentServer on
  the production init path spawns (via a spy SessionManager) with the OPUS model,
  the full tool grant, the autoloop name, and the real dogfooding-loop prompt —
  proving the feature is alive in production wiring with no real spawn.
- **Migration parity** — `ConfigDefaults.test.ts`: an existing mentor block gains
  the dark `autonomousFix` on update, idempotently.
