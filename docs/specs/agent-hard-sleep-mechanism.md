---
title: Agent hard-sleep — the stop+wake mechanism (Stage B, slice 2)
slug: agent-hard-sleep-mechanism
status: approved
review-convergence: 2026-05-31T04:30:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the delegated deploy mandate. Justin directed building
  Stage B now, in-session (topic 16782, 2026-05-31). This slice ships the stop+wake
  MECHANISM but DARK + dry-run (monitoring.agentSleep.enabled defaults false; the live
  requestSleep that writes the sleep-request flag only fires when enabled && !dryRun).
  Because it can stop the serving process, the *enablement* — not this dark ship — is
  the reviewed gate: turn it on first on a test agent with Justin watching, per the
  spec's "ships OFF + a dry-run would-stop log first." Flagged in the PR per
  cross-agent discipline. Builds on the merged slice-1 SleepController
  (docs/specs/agent-hard-sleep-controller.md).
---

# Agent hard-sleep — the stop+wake mechanism

## Problem

Slice 1 (SleepController) decides, dark + dry-run, when it is safe for a deeply-idle
agent to sleep. This slice wires the MECHANISM that acts on a `would-sleep` verdict:
stop the server to near-zero footprint, and respawn it on the next message without
losing that message. This is the high-risk half — the supervisor's auto-respawn of a
down server is load-bearing, and the lifeline is the single always-on ear. Done
wrong, an agent never wakes. So the whole handshake reuses the proven
`restart-requested.json` lifecycle rather than inventing a new one.

## The handshake (mirrors restart-requested.json)

Three file flags under `state/`, all consumed by the supervisor's existing
health-check loop (alongside `checkRestartRequest()`):

1. **`sleep-requested.json`** — written by the SleepController in LIVE mode when its
   verdict is `would-sleep` (the `requestSleep` consumer, unwired in slice 1).
   `checkSleepRequest()` validates it, then STOPS the server's tmux session and sets
   an internal `slept` state. Crucially, while `slept`:
   - the health loop does NOT treat the absent server as `serverDown` and does NOT
     auto-respawn it (the one real change to load-bearing supervisor behavior — gated
     behind `slept` so a genuine crash still auto-recovers);
   - a `state/slept-marker.json` records `{ sleptAt, version }` so a fresh supervisor
     boot (or the fleet watchdog) recognizes "intentionally asleep", not "crashed".
2. **`wake-requested.json`** — written by the lifeline when a wake trigger fires.
   `checkWakeRequest()` clears `slept`, calls `spawnServer()` (the same fresh-spawn
   the restart path uses), and removes the slept marker.
3. The SleepController clears `sleep-requested.json` semantics via its existing
   once-per-episode latch; the supervisor consumes each flag on read (like restart).

## Wake triggers (the lifeline, the always-on ear)

The lifeline stays up while the server sleeps (it is cheap). It writes
`wake-requested.json` on any of:

- **An inbound Telegram message.** The lifeline FIRST durably buffers the message
  (the existing PendingRelay / message-ledger path — zero loss), writes
  `wake-requested.json`, then polls the server's `/health` until healthy and forwards
  the buffered message via the existing replay path. User-facing contract: an
  immediate "waking up…" ack, then the real reply once up — identical UX to a
  compaction pause. Wake latency = cold server boot (~30–45s observed).
- **An agent-to-agent ping** (Threadline) — same buffer-then-wake path.
- **A scheduled job due.** The scheduler's next-fire becomes a wake timer the
  lifeline arms before sleep (the `nextScheduledJobAt` SleepController already
  computes — wired live in this slice). The lifeline writes `wake-requested.json`
  shortly before the fire time.

## Interactions / hard constraints

- **Multi-machine lease.** The SleepController already refuses to sleep while this
  machine holds the serving lease (slice 1 guard). This slice adds: a slept machine
  must have released/handed off the lease first; and a slept standby must still be
  able to take the lease (wake on a lease-acquisition signal).
- **Fleet watchdog.** The out-of-process watchdog must read `slept-marker.json` and
  treat a slept agent as healthy (NOT force-restart it as down). This is the single
  most important safety wire — without it the watchdog fights the sleep.
- **Observability while asleep.** `GET /health` must remain answerable — the lifeline
  serves a minimal `{ state: 'asleep', sleptAt }` health on the server's behalf so
  monitors and the dashboard see "asleep", not "down".
- **Scheduled jobs.** Covered by the wake-timer above; a job must never be silently
  missed because the server was asleep.

## Decision points (signal vs authority)

The `would-sleep → stop` action IS an authority (it stops the serving process). It is
gated exactly like the SessionReaper: positive proof of deep idle (slice 1's verdict
with all guards), KEEP-awake on any ambiguity, ships OFF + a dry-run "would-stop" log
first, and never sleeps a lease-holder without a handoff. The SleepController's
dry-run already produces the evidence to validate this before enablement.

## Implementation status (this slice)

Built + tested in this slice:
- `SleepController.sleepRequestWriter` — live-mode `requestSleep` writes the
  TTL-stamped `sleep-requested.json`.
- `ServerSupervisor` — `checkSleepRequest` (stop server + enter `slept` + write
  `slept-marker.json`), `checkWakeRequest` (respawn + clear), the health-loop
  `slept` short-circuit (suppresses auto-respawn), and the boot-time slept-marker
  read (a rebooted supervisor — or one bounced by the fleet watchdog — stays asleep).
- `TelegramLifeline.requestWakeIfSlept` (via the pure `writeWakeRequestIfSlept`
  helper) — an inbound message writes `wake-requested.json`; the existing
  forward-retry queue replays the buffered message once the server is healthy.

Enablement-gated refinements (the dark mechanism is safe without them — they
improve behavior once sleep is turned ON): a fuller relay/forward-queue in-flight
signal; the scheduler next-fire wake timer (so a cron job due during sleep wakes
the server — `nextScheduledJobAt` is currently conservative-null); the lifeline
serving a minimal `{state:'asleep'}` on `/health` so the fleet watchdog and the
dashboard read "asleep" rather than "down" (today the boot-stay-asleep marker is the
brick-defense). <!-- tracked: topic-16782 -->

## Testing

Unit + regression (this slice): `ServerSupervisor-sleep-wake.test.ts` (sleep stops +
marks + slept; no-request no-op; expired-request ignored; wake respawns + clears;
wake-when-not-slept no-op; idempotent re-sleep; boot marker signal),
`agentSleepWake.test.ts` (marker→wake-request, no-marker→no-op), `SleepController`
`sleepRequestWriter` (TTL-stamped flag). Regression: the existing
`ServerSupervisor-handshake` / `supervisor-health-check` / `supervisor-cpu-starvation`
suites stay green — the `slept` short-circuit is the only loop-flow change and is a
no-op unless a sleep-request was honored. A full live two-stage lifecycle (actual
stop → real inbound → respawn → replay) is the enablement validation on a test agent.

## Rollback

Dark + dry-run by default (`monitoring.agentSleep.enabled` + the slice-1 `dryRun`).
`enabled:false` keeps the server always-up (today's behavior). The supervisor's
`slept`-gated branch is a no-op unless a `sleep-requested.json` is ever written, which
only the live SleepController does.
