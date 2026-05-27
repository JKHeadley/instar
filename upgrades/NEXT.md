# Instar Upgrade Guide — NEXT

<!-- bump: minor -->

This release lands a batch of work that accumulated since v1.3.26: the Failure-Learning Loop, the Framework-Onboarding Mentor system, Graduated Feature Rollout, the SessionReaper, multi-machine seamlessness groundwork, the feedback-factory TypeScript port, threadline notification-routing fixes, and a set of reliability fixes. The headline new capabilities ship OFF or dormant; nothing below requires action unless noted.

## What Changed

**Failure-Learning Loop (instar self-hosting; ships OFF).** When something we built breaks later, it can be captured and traced back to the spec / initiative / project AND the dev toolchain that produced it; an analyzer surfaces process-gap patterns and opens human-approved tracked fixes, then verifies whether each fix reduced that failure class. The loop can never change the process on its own (it only ever opens a tracked Action + a draft Initiative — never anything the autonomous evaluator acts on). Gated behind `monitoring.failureLearning.enabled` (default false). Endpoints: `GET /failures`, `GET /failures/:id`, `GET /failures/analysis`, `GET /failures/insights`, `POST /failures/analyze`, `POST /failures`.

**Framework-Onboarding Mentor system (ships dormant).** A read-only issue ledger plus a dormant mentor loop for onboarding other agent frameworks. Endpoints: `GET /framework-issues`, `GET /framework-issues/playbook`, `GET /framework-issues/capture-stats`, `GET /framework-issues/observability`, `POST /framework-issues/:id/promote`, `GET /mentor/status`, `POST /mentor/tick`. Dormant by default (`mentor.enabled` false) — `POST /mentor/tick` returns `{ran:false,reason:"disabled"}` until enabled.

**Graduated Feature Rollout.** The initiative board now self-populates from approved+merged specs, and a twice-weekly driver recommends promotion (dark → live → default-on) without auto-advancing. "What are we working on?" is answered from the live board.

**SessionReaper (ships OFF + dry-run).** A pressure-aware reaper of idle-but-alive sessions, with a positive-evidence classifier that never reaps a working session. Observability at `GET /sessions/reaper`. Default off; dry-run logs would-reap, kills nothing.

**Threadline notification routing.** Parentless conversations + housekeeping notices route to a single silent hub topic (never a topic-per-event); "open this" is a deterministic intercept. Adds `POST /threadline/hub/bind`.

**Multi-machine seamlessness (groundwork).** Fenced-lease leader resolution, a live-tail buffer + redaction + fenced outbox, the Channel Seamlessness Contract for the Telegram adapter, and seamlessness observability — foundations for cross-machine continuity.

**Feedback-factory TypeScript port (internal).** The dedup fingerprinter, Jaccard title-similarity primitives, lifecycle state machine, receiver submit handler, and dispatch request handlers were ported to TS (Phase 1). Internal plumbing; no agent-facing behavior change yet.

**Reliability fixes.** Built-in scheduled jobs load again (the agentmd frontmatter allowlist now accepts scheduling vocabulary like `schedule`/`priority`/`model`); the standards-conformance gate auto-invokes at spec-review and got a real review budget; the Codex intelligence-provider runs judgment calls in a clean scratch dir; the `/build` stop-hook is session-scoped; several threadline reply/commitment-surfacing fixes.

## What to Tell Your User

- A batch of infrastructure shipped. The headline new capabilities (Failure-Learning Loop, SessionReaper, the Mentor system) all ship **off by default** and mature deliberately on the initiative board — nothing changes day-to-day until they're turned on.
- Background jobs that had quietly stopped loading are running again, automatically.
- Ask "what are we working on?" and your agent answers from the live initiative board, not memory.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Failure-Learning Loop | Ships off; enable `monitoring.failureLearning.enabled`. `GET /failures/analysis` answers "why do features keep breaking?" |
| Framework-Onboarding Mentor | Dormant; `GET /mentor/status`, `GET /framework-issues` |
| Graduated Feature Rollout | Automatic; `GET /initiatives` shows the live board |
| SessionReaper | Ships off+dry-run; `GET /sessions/reaper` observability |
| Threadline hub routing | Automatic; `POST /threadline/hub/bind` ties a conversation to a topic |
| Multi-machine seamlessness | Groundwork; not yet user-facing |

## Evidence

Each feature shipped through the converged-spec → /instar-dev gate with a side-effects artifact + trace, and merged with green CI (type-check, build, integration, e2e, unit shards). The Failure-Learning Loop's by-construction authority guard is asserted by a test (the loop creates zero EvolutionProposals with autonomous mode on). SessionReaper and Graduated Feature Rollout were validated live. This guide was assembled to unstick a release backlog that had silently accumulated since v1.3.26 — itself a process-hygiene lesson now being explored under the "Release Hygiene" topic.
