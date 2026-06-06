---
bump: minor
---

## What Changed

PR 2 of the June-15 interactive-only readiness arc (PR 1 = #873). The
provider substrate could route INTERNAL intelligence calls onto the
subscription lane, but Instar's other headless surface — full agentic
`claude -p` one-shots for scheduled jobs, mentor loops, dispatch actions,
`POST /sessions/spawn`, and Threadline A2A cold replies — still billed the
Agent SDK pot with no reroute. This PR adds the reroute at the single funnel
those spawns share (`SessionManager.spawnSession`'s headless branch,
claude-code only): under `intelligence.subscriptionPath.mode` `force` (or
`auto` when the shared credit decision says subscription), the spawn
launches an INTERACTIVE claude session instead — same tmux session, same
watchdogs/reaper semantics, same `--allowedTools`/`--strict-mcp-config`
flags (spliced for parity), wide-pane geometry, with the prompt delivered
via the existing ready-wait + guarded-inject machinery. Because an
interactive REPL never exits, each rerouted task carries a deterministic
completion sentinel (`INSTAR_JOB_COMPLETE_<id>`) the monitor reaps as
SUCCESS (job history records success, not timeout), plus a hard
`maxLifetimeMinutes` backstop (default 45). Safety gates from the 5-reviewer
convergence: a rerouted-session concurrency cap (`maxRerouted`, default 3) +
memory-pressure pre-spawn gate (auto → degradation-reported headless
fallback; force → loud refusal); subscription-quota backpressure on the A2A
(`SpawnRequestManager`) and pipe (`PipeSessionSpawner`) surfaces so peer
traffic cannot rate-limit the operator's own account; force-mode pipe
refusal that falls through to the rerouted A2A path; a paste-escape
sanitizer in the tmux inject path; per-slug double-run guard + boot-time
reconciliation so a restart can't double-execute a mid-flight job; an F6
recurrence cap so a silently-dead reroute escalates instead of hiding behind
its own fallback; a persisted `Session.launchLane` field surfaced in
`GET /sessions` and the reap-log (the soak's machine-checkable criterion);
a new CI lint (`lint-no-unfunneled-headless-launch`) that fails any future
direct `buildHeadlessLaunch` callsite outside the funnel; three
factory-bypass intelligence fallbacks in server.ts routed through the
factory (carrying breaker + router); and the CLAUDE.md awareness block
corrected (+ a new migration that reaches already-deployed agents).
Everything ships dark: mode `off` (the fleet default) is pinned
byte-for-byte to today's argv by test at every touched callsite.

## What to Tell Your User

After June 15, the one-shot commands I use for background jobs and
agent-to-agent replies start drawing from a prepaid credit pot — and when it
empties, they'd just fail. I already have a switch (from the last release)
that can move my internal thinking onto normal interactive sessions; this
release teaches that SAME switch to also cover my scheduled jobs and
agent-to-agent replies. It also adds the guardrails that make flipping it
safe: caps so rerouted work can't overload the machine or eat your
subscription's rate window (other agents messaging me can never crowd out
YOUR conversations), a marker system so finished jobs are recorded as
successes, restart protection so a job can't accidentally run twice, and a
visible label on every session showing which billing lane it used — so when
we run the full-day proof, "everything ran on the subscription lane" is
something you can check, not something you have to take my word for.
Nothing changes at this release — the switch is still OFF everywhere.

## Summary of New Capabilities

- `intelligence.subscriptionPath.mode` now governs headless job/A2A/dispatch
  spawns too (claude-code only): `force` → interactive sessions with a
  completion sentinel + lifetime backstop; `auto` → credit-driven, with
  loud, capped fallback.
- New config knobs: `subscriptionPath.maxRerouted` (concurrent rerouted
  sessions, default 3), `subscriptionPath.maxReroutedLifetimeMinutes`
  (default 45).
- `Session.launchLane` (`headless` | `rerouted-interactive`) in
  `GET /sessions` and the reap-log — machine-checkable billing-lane audit.
- Quota backpressure on A2A + pipe spawn admission when the reroute is
  active (wired to the same QuotaTracker gate jobs already use).
- Per-slug job double-run guard + boot reconciliation of rerouted job
  sessions.
- CI funnel lint: direct `buildHeadlessLaunch` use outside the allowlist
  fails the build.

## Evidence

5-reviewer adversarial convergence (correctness/wiring, security/cost,
ops/scale, standards/lessons, spec-vs-reality — ALL initially BLOCK; every
finding folded into the spec, `docs/specs/june15-headless-spawn-reroute.md`
+ `.eli16.md`). 56+ new tests across all three tiers: 43 unit
(`headless-spawn-reroute` 23 incl. argv pins both sides / completionMode
both sides / cap + lifetime + sanitizer + reconciliation;
`subscription-quota-gates` 8; `lint-no-unfunneled-headless-launch` 4;
`PostUpdateMigrator-subscriptionPathScope` 5; `job-scheduler-double-run-
guard` 3), 1 integration (`sessions-launch-lane` — launchLane through the
real route pipeline), 4 e2e (`june15-headless-spawn-reroute` — production-
mirroring construction: force spawn has no `-p` + wide pane, sentinel
completes as success through the real monitor, launchLane via real HTTP,
default-off invariance). Funnel lint clean on the tree + self-tested both
ways. Silent-fallback ratchet held at 458.
