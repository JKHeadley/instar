---
approved: true
review-convergence: internal-adversarial-2026-05-27 (single-reviewer conformance pass against the six Instar standards — no-manual-work, structure>willpower, signal-vs-authority, near-silent, 3-tier-testing, migration-parity — plus a gameability/spam-risk sweep. /spec-converge not run: the branded skill is not installed on this checkout. Resolved: Layer A migration path is migrateAutonomousStopHookTopicKeyed (marker+fingerprint; bump the capability marker to ship; customized hooks left untouched). Open product decision surfaced to Justin: default enabled:true + attended-gate scope, given his explicit "tell me why it stopped" mandate weighed against the near-silent standard; shadow-mode `continue`-accuracy risk mitigated by attended-gate + 30min dedup.)
---

# Spec — Notify-on-Stop (a stopped session always says why)

## Problem

Justin's standing requirement, verbatim: *"sessions that continue on reliably OR that make sure they send a telegram message explaining why they stopped (which should be for a VERY good reason)."*

Today neither half is guaranteed:

1. **Autonomous terminal exits are silent to the user.** `autonomous-stop-hook.sh` ends a run on completion-promise, completion-condition, duration-expiry, or emergency-stop — and in every case it writes the reason to **stderr** (`echo ... >&2`) and `exit 0`. stderr lands in the terminal, which the user cannot see. The user is told nothing. The agent is *supposed* to send a final report itself, but that's willpower, not structure — and the 2026-05-27 incident is exactly what happens when it doesn't.

2. **Unjustified mid-task stops are detected but not surfaced.** The `UnjustifiedStopGate` runs in `shadow` mode on Echo (and ships `off` → `shadow` → `enforce` graduated fleet-wide). In `shadow` mode the gate *evaluates* every Stop and can classify it as `continue` (the session stopped when it should have kept going) — but shadow mode **cannot block**, so the session goes silent anyway. The gate sees the silent stall and does nothing the user can observe. (Until Task 1 / PR #432, the gate's router hook was ESM-crashed, so it saw nothing at all — that's fixed; this spec makes the *seeing* actionable.)

The result both times: a session stops mid-work and the user finds out only by noticing the silence. That is the failure class this spec closes structurally.

## Goal

Every session stop is one of two things, never a silent third:
- **Continued** — the gate (in `enforce`) blocks an unjustified stop and the session keeps going; OR
- **Explained** — the user gets exactly one brief, plain-English Telegram saying *why* it stopped.

…without re-introducing notification spam (every Stop-hook fire is a turn-end; most are routine "I answered, now I'm waiting for you" pauses that must stay silent).

## Design — two layers, sharing one delivery discipline

Both layers route through the **existing** `SentinelNotifier` delivery discipline (`src/monitoring/SentinelNotifier.ts`): log-always + Telegram, coalesced within a short window, sent to the single reused system (lifeline) topic — never a new topic per event. We do **not** fork a second notification path. (This is the post-2026-05-22 topic-spam fix; reusing it is mandatory per the near-silent + signal-vs-authority standards.)

### Layer A — deterministic autonomous-exit notice (always-on)

When `autonomous-stop-hook.sh` takes a **terminal** exit, before `exit 0`, send one Telegram to the run's `report_topic` stating which terminal condition fired and a one-line summary:

| Terminal condition | Message shape (ELI16, plain) |
|---|---|
| completion-promise / completion-condition met | "✅ Autonomous run on *<goal>* finished — <reason>. <N> iterations, <elapsed>." |
| duration expired | "⏰ Autonomous run on *<goal>* hit its time limit (<duration>) and stopped. Here's where it got to: <last-status>." |
| emergency-stop | "🛑 Autonomous run on *<goal>* was emergency-stopped." |

- Deterministic, no LLM — these conditions are already computed in the hook.
- Idempotent: the state file is removed in the same terminal branch, so the notice fires once per run.
- Routed via the same `telegram-reply.sh` the hook's recovery-note path already uses (no new transport).
- **Always-on** (not behind the escalation flag): an autonomous run ending is inherently a user-relevant event, and there is exactly one per run — no spam risk.

### Layer B — intelligent unjustified-stop notice (gate-fed)

Extend the `/internal/stop-gate/evaluate` route. After the decision is computed, feed a `StopGateNotifier` (a thin sibling that *delegates to* the same coalescing/system-topic sink as `SentinelNotifier`, or `SentinelNotifier` itself via a new `escalate`-style entrypoint). Notify **only** on the genuinely-stuck classifications, **only** for sessions that are unattended:

Notify-worthy decision set (the session is going quiet and shouldn't be):
- `decision === 'continue'` **in `shadow` mode** — the gate believes the stop was unjustified but cannot block it, so the session silently stalls. THE core incident case.
- `decision === 'escalate'` (`U_AMBIGUOUS_INSUFFICIENT_SIGNAL`) — the gate cannot tell if the stop was justified; surface it.

Explicitly NOT notify-worthy (stay silent):
- `decision === 'allow'` with any allow rule (e.g. legitimate completion, or a normal "awaiting user" turn-end) — routine.
- `decision === 'continue'` **in `enforce` mode** — the session is being *blocked and continued*, not stopped; no notice needed.
- `decision === 'force_allow'` (continue-ceiling) — the operator already has the stuck-state flag; covered by aggregates, not a per-event ping.
- `failOpen` (authority/LLM unavailable) — transient; log-only (DegradationReporter already covers it). Notifying here would spam on every turn during an LLM outage.

**Spam controls (all required):**
1. **Attended-session gate.** Notify only when the session is **unattended**. Heuristic: `autonomousActive` (already in the hot-path) OR no inbound user message on the session's topic within the last *N* minutes (default 10). An interactive session where the user is present doesn't need a ping — the user sees the silence directly. *(Convergence question for reviewers: is `autonomousActive` alone sufficient for v1, deferring the "recent-inbound" half? Leaning yes — simplest correct MVP.)*
2. **Per-session dedup.** At most one notice per session per cooldown window (default 30 min). The Stop hook can fire repeatedly; we never re-ping the same stalled session.
3. **Coalescing.** Multiple distinct sessions stalling within the `SentinelNotifier` coalesce window flush as one consolidated message (existing behavior).
4. **Config + default.** New `monitoring.notifyOnStop` config block: `{ enabled: bool, unattendedOnly: bool, dedupWindowMs, cooldownMs }`. **Default `enabled: true`** — Justin explicitly asked to be told; this is the rare case where notify-default-on is correct. The attended-gate + dedup keep it near-silent in practice. (Distinct from `sentinelTelegramEscalation`, which stays default-off for housekeeping sentinels.)

The notice text is fixed-template, plain-English, with the session's last-known activity and a "want me to dig in?" CTA — never raw logs or internal reasoning (tone-gate still applies on the system-topic sender).

## Why this is the right level (signal vs authority)

The Stop-hook router is a brittle, low-context thin client — it must not decide *whether to alarm the user*. The server's evaluate route has the full decision, the mode, the session's attended-state, the dedup ledger, and the wired Telegram sink. The classification intelligence and the notify decision both live where the context is. The hook stays dumb. (Per `feedback_signal_vs_authority` + `feedback_fix_at_the_right_level`.)

## Migration parity

- **Layer A** is a change to `autonomous-stop-hook.sh`, an agent-installed file. Per Migration Parity: the autonomous skill's hook is installed by the skills machinery; the change ships to existing agents via the skill-content migration path (`PostUpdateMigrator`, scoped to the default-skill allowlist) — NOT install-if-missing. Add an idempotent `migrate…` step or confirm the hook is in the always-overwrite set.
- **Layer B** is server-side `src/` (route + new `StopGateNotifier` + config defaults). Config defaults added via `migrateConfig()` with existence checks. No agent-file change beyond config.
- Agent-awareness: add notify-on-stop to the CLAUDE.md template (it's a behavior the agent + user should know exists).

## Test plan (all three tiers — non-negotiable)

- **Unit:** (a) `StopGateNotifier` decision matrix — one assertion per row of the notify-worthy / not-worthy table above, both sides of every boundary. (b) dedup-window + cooldown logic. (c) attended-gate logic. (d) Layer A: hook emits the correct message per terminal branch (shellcheck + a bats-style or node-driven harness piping a synthetic transcript). (e) wiring-integrity: the evaluate route actually constructs and calls the notifier (not null, not a no-op).
- **Integration:** full HTTP `POST /internal/stop-gate/evaluate` in shadow mode with a `continue` decision on an `autonomousActive` session → asserts the notifier sink received exactly one coalesced message; a second immediate call → asserts dedup suppresses it; an `allow` decision → asserts silence.
- **E2E (the "feature is alive" test):** production init path → server up → drive a synthetic unjustified-stop through the real route → assert a Telegram-bound sink fired (mock transport, real wiring). Plus a live test-as-self pass on a real session before merge (per the test-as-self standard).

## Rollback

- Layer A: revert the hook change (one file).
- Layer B: `monitoring.notifyOnStop.enabled = false` kills it instantly with no redeploy; full revert is route + notifier + config.

## Out of scope (tracked elsewhere)

- Turning the gate from `shadow` → `enforce` fleet-wide (separate graduated-rollout decision).
- False-blocker interceptor (Task 3), self-propagation harness (Task 4).
