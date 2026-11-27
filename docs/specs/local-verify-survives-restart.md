---
title: "Local verify survives lifeline restarts; interrupted runs are counted and resume first"
slug: "local-verify-survives-restart"
author: "echo"
parent-principle: "Structure beats Willpower"
eli16-overview: "docs/specs/local-verify-survives-restart.eli16.md"
tier: 1
issue: "docs/issues/local-verify-killed-by-update-restart.md (Echo Bugs record topic 10000000869; work topic 130446)"
---

## Problem (measured 2026-10-26)

PR 2350 sat first in the local-verify line from 20:59 PDT with zero finished attempts. The audit log (`.instar/logs/local-verify.jsonl`) and the server and lifeline logs show:

1. **04:44Z and 05:37Z** — update restarts (v1.3.1439, v1.3.1440). Both waited for the running `main` verify (`restart hold re-check — attempting restart` fired only after it ended). The existing restart hold (`LocalVerifyService.restartHolds`, registered on the AutoUpdater) works.
2. **06:23:53Z** — PR 2350's run, 23 minutes in, was cancelled with reason `shutdown`. No update was pending (`auto-updater.json`: `pendingUpdate: null`). The lifeline log shows `[Lifeline][DriftPromoter] firing self-restart: diff=20, reason=drift-auto-promote` at that second. The drift promoter restarts the lifeline when it is ≥ 20 patches behind the server; the lifeline's `quiesceEverything()` calls `supervisor.stop()`, which sends Ctrl-C to the server's tmux session. The server's shutdown cancels the verify. The drift promoter's clean-window check knows nothing about server work, so the verify's restart hold was never consulted.
3. **After each restart** a `main` verify is re-queued at boot (debounce skipped at boot, `main` entries are not persisted) and, with main health `main-suspect` after the lease-epoch gap, `decideStart` gives `main` priority. The PR goes back behind it.
4. **`shutdown()` un-counts the killed run** (`attempts` decremented), so the queue shows `attempts: 0` however many runs died. The starved signal is clock-only (3 h) and its `onStarved` seam is not wired in `server.ts`, so it only ever reached the audit log.

## Fix

### A. A lifeline-only restart leaves the server running

`RestartRequest` gains `keepServer?: boolean`, resolved by the orchestrator as `req.keepServer ?? restartKeepsServer(bucket)`: the lifeline-only buckets `versionSkew` (drift auto-promote, a 426 handshake) and `plannedUpgrade` (the coordinated signal the updater, the server and the migrator write when the LIFELINE must move onto the current code) keep the server; `watchdog` (server unhealthy, an external signal) stops it as before. The drift promoter also sets the flag explicitly. The orchestrator passes the resolved request to `quiesce(req)`; `quiesceEverything({ keepServer })` settles everything synchronous first (timers, registry entry, lock, and `ServerSupervisor.detach()` for a keep-server restart) before its first await, because the orchestrator bounds quiesce to one second. `detach()` stops the health checks and sets a terminal `detached` flag that every supervisor path to the server checks on entry AND again after each of its waits (a probe in flight, the restart timer, the circuit breaker, a restart or sleep request, a `stop()` or graceful restart already in its graceful wait, a `start()` still probing, the delayed child kill), so nothing acts on the server after the lifeline let go. The one exception is deliberate: `stop({ evenIfDetached: true })`, the orchestrator's winning stop request.

The next lifeline's `ServerSupervisor.start()` adopts a server whose tmux session is alive. If the session answers `/health`, as today; if it is alive but not answering (busy, event loop stalled under load — the 23-minute verify was exactly that kind of work), it is ADOPTED and supervised, and the health loop's process-alive rules decide, never `start()`. Only a session that is gone by the end of the probes (the P1 dying-session race, `launchctl kickstart -k`) falls through to a spawn.

A stop request that arrives while a keep-server restart is already in flight is suppressed as usual (one restart at a time), but its server policy wins: if it lands during the telemetry wait, quiesce itself stops the server; later, the orchestrator clears the persist hard-kill timer and runs a separately budgeted stop phase (`stopServer` dep → `supervisor.stop({ evenIfDetached: true })`, 10 s: the 3 s graceful wait plus a bounded force-kill) before exit — so a `launchctl bootout` or watchdog trip landing in that window cannot leave a server running with no lifeline to adopt it.

Why it is safe: the lifeline-only buckets ask the LIFELINE to reload its code; they are not a request to restart the server. When the updater also asked for a server restart (it writes `restart-requested.json` and the lifeline signal back to back, without waiting), that restart stays the supervisor's duty: the successor's `start()` reads the file (maintenance wait, `pendingUpdateVersion`) and its health loop performs it — the division of responsibility is unchanged, only the needless Ctrl-C from the lifeline's own exit is gone. The server's tmux session lives in the shared tmux server (its own process group, started independently of the lifeline's launchd job; verified on the Studio), so the lifeline's exit does not reach it. What this does NOT cover: an operator restart of the lifeline (`instar lifeline restart`, SIGTERM) and a watchdog trip still stop the server — a deliberate restart wins over a verify; those runs are now counted and resumed first (B, C).

### B. An interrupted run is counted and can raise the alarm

- `shutdown()` keeps the attempt, increments `interruptions` on the entry, sets `resumeFirst`, and audits `interrupted` (with how long it ran). An unclean exit found at boot (`inFlight` marker) also increments `interruptions` and sets `resumeFirst`, beside its existing error-retry accounting (one retry, then an `error` record — the retry ceiling is kept; the alarm is raised BEFORE such a drop).
- Both fields persist in `queue.json` and are validated on read. A push while the entry waits keeps `resumeFirst` (the restart, not the PR, lost the turn) and `starvedRaised`; `interruptions` start over with the new head.
- `decideStarved` raises at once when `interruptions ≥ INTERRUPTION_LIMITS.starvedAfter` (2), with `reason: 'interrupted'`; the clock rule is unchanged (`reason: 'waited'`). `checkStarved` considers the oldest entry, every entry with an interruption, and the entry in flight; restored entries are checked at the end of `restoreQueue`, before anything can start them. Still once per entry (`starvedRaised`, persisted the moment it flips).
- The starved signal is wired: when no `onStarved` is given, `buildLocalVerifyService` sends it to `hooks.signal` as `local-verify:starved:<pr>`, and `server.ts` turns that (via `localVerifyAttentionItem`) into a plain-language attention item ("PR #N cannot finish its check") through `upsertAttentionItem`, so a later queue episode of the same PR reopens the item instead of being hidden behind a resolved one. One signal per PR per stay in the queue.

### C. An interrupted PR goes first after the restart

`decideStart` (fair share): when any ready PR entry has `resumeFirst` and `main` is not known red, it starts next — before a waiting `main` verify and before other PRs, whether or not a `main` verify is queued. `resumeFirst` is cleared when the entry starts, so it jumps at most once per interruption. With `main` red the repair path keeps priority, as today. `FairShareState.mainRed` is new; `pump()` fills it from the main-health snapshot.

Resuming mid-run is not attempted: the lanes run in parallel inside one run, so a partial result has no reusable unit smaller than the whole run.

## Decision points touched

- `RestartOrchestrator` → `quiesce` — modify: a lifeline-only restart (versionSkew, plannedUpgrade) no longer stops the server; a competing stop request still does.
- `ServerSupervisor.start()` — modify: an alive-but-not-answering session is adopted, never killed from `start()`; a gone session still spawns.
- `decideStarved` — modify: a second trigger (interruptions) beside the clock. Signal only.
- `decideStart` — modify: an interrupted PR first unless main is red. Ordering only; nothing is refused.

## Tests

- Unit: `tests/unit/localVerify/LocalVerifyService.test.ts` (shutdown counts the attempt; interruptions persist and restore; the second interruption alarms at boot before a `main` observation can start the entry; the in-flight entry is checked; a second unclean exit alarms before its drop; a push keeps `resumeFirst`; interrupted PR ahead of a boot-time `main` in suspect; not with `main` red; cleared on start), `tests/unit/localVerify/mainHealth.test.ts` (`decideStart` with `resumeFirst`, anywhere among ready PRs), `tests/unit/lifeline/RestartOrchestrator.test.ts` (bucket defaults; explicit flag wins; a competing stop request during quiesce or persist stops the server; two keep requests do not), `tests/unit/lifeline/drift-restart-keeps-server.test.ts` (`detach()` touches no session; a probe in flight at detach cannot act; `stop({ evenIfDetached })`; lifeline wiring pinned against source), `tests/unit/supervisor-kickstart-race.test.ts` (dying session → spawn; alive-but-busy → adopt).
- Integration: `tests/integration/local-verify-routes.test.ts` — `GET /local-verify` across a simulated restart shows the entry counted, interrupted, and started ahead of the boot-time `main` verify.
- E2E: `tests/e2e/lifeline-keep-server-adoption.test.ts` — a real tmux session + a real loopback `/health`: the same pane pid survives detach and a fresh supervisor's `start()`; an alive-but-not-answering session is adopted; a gone session spawns. `tests/e2e/local-verify-lifecycle.test.ts` — the production-built service delivers the starved signal to `hooks.signal` as `local-verify:starved:<pr>`.

## Rollback

Revert the PR. No state migration: the two new `queue.json` fields are optional and an older server ignores unknown fields.

## Review changes (round 1 — GPT-6 Astra and Gemini 4 Argon, spec + code; reports in `docs/specs/reports/local-verify-survives-restart-*-r1-*.md`)

Accepted:
- Successor `start()` could kill an alive-but-busy server after its probes failed (Astra spec #1): adopt-and-supervise; only a gone session spawns. Unit + e2e.
- A twice-interrupted PR started by a `main` observation before the first tick never alarmed (Astra spec #2 / code #3): restored entries are checked at the end of restore, and the in-flight entry is part of `checkStarved`.
- A second unclean exit dropped the entry before its alarm (Astra spec #3 / code #4, Argon spec #3 / code #6): the alarm is raised before the drop; the retry ceiling stays.
- The spec's claim about version-skew / planned-upgrade restarts was wrong (Astra spec #4): those are lifeline-only too and now keep the server by bucket default; the operator/watchdog path is honestly out of scope and counted instead.
- Quiesce reached `detach()` only after an await inside a one-second budget, and a probe/timer in flight could still act (Astra spec #5 / code #2, Argon spec #4): synchronous teardown first; `detached` fences every path that can reach the server; regression test for a pending probe.
- A stop request during a keep-server quiesce was swallowed (Astra code #1, Argon code #2): the suppressed request's server policy wins; the server is stopped before exit; four orderings tested.
- `decideStart` looked only at the first ready PR (Argon code #3): any ready `resumeFirst` PR.
- `starvedRaised` carried across a push contradicted a per-head key (Astra code #5, Argon spec #1 / code #4): the key is per PR (`local-verify:starved:<pr>`) and the alarm is once per stay in the queue; `resumeFirst` is carried across the push, `interruptions` start over.
- `checkStarved` did not persist the flag it flipped (Argon code #1 / spec #2): persisted at once.
- The one red assertion and the over-claimed test descriptions (Astra spec #6 / code #6, Argon code #5): fixed; the e2e section above now says what each test proves.
- `starvedSignalKey` helper (Argon spec #5): inlined.

Round 2 (reports `*-r2-*`; Argon spec: ready; Astra spec: ready with changes; Astra code: not ready; Argon code: ready with changes) — accepted:
- The persist hard-kill timer could fire during the competing stop's 3 s graceful wait (Astra P1): the timer is cleared before a separately budgeted stop phase; tested with a persist that exhausts its budget and a slow stop.
- A stop request arriving during the telemetry wait only took effect after persist (Argon code #2): quiesce now receives `keepServer: false` in that case; the override flag is reset with the in-flight request on every deferral.
- `stop()`, graceful restart and a probing `start()` re-check `detached` after their waits; the delayed child-process kill too (Astra spec #3 / code #2). `start()` no longer clears the fence.
- `resumeFirst` with no ready `main` verify (Astra spec #5 / code #4, Argon code #1): checked before the no-main early return.
- A resolved attention item hid a later episode of the same PR (Astra spec #2 / code #3): starved items go through `upsertAttentionItem` (mapping extracted to `localVerifyAttentionItem`, unit-tested).
- "Server already current" was the wrong premise for the planned-upgrade bucket (Astra spec #4): reworded above; a test pins that adoption keeps a pending `restart-requested.json` as the supervisor's duty.
- Untracked test files (Argon code #3): they are committed with the change.

Declined, with reason:
- A two-stop lifecycle at the e2e tier THROUGH `buildLocalVerifyService` (Astra code #6): the production seams call `gh` for the PR view and spawn the real verifier against GitHub, so that path cannot run in a test without the seams the unit tier already uses; the two-stop lifecycle is proven on the real service class with fake process seams (unit) and the real-process half (server survives, successor adopts) at e2e with a real tmux session.
