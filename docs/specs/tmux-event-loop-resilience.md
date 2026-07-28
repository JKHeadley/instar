---
title: "tmux Event-Loop Resilience — never block the server loop on a slow shared tmux server"
slug: "tmux-event-loop-resilience"
author: "echo"
parent-principle: "Structure beats Willpower"
review-convergence: "2026-06-22T07:29:44.034Z"
review-iterations: 2
review-completed-at: "2026-06-22T07:29:44.034Z"
review-report: "docs/specs/reports/tmux-event-loop-resilience-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
approved: true
single-run-completable: true
frontloaded-decisions: 7
cheap-to-change-tags: 0
contested-then-cleared: 2
---

# tmux Event-Loop Resilience

## Problem statement

The instar server makes **synchronous** `tmux` subprocess calls (`execFileSync(tmuxPath, …)` in
`SessionManager` — session polling, health, pane capture, has-session) **on its event loop**. All
instar agents on a host share **one per-user tmux server** (one socket — that is why
`tmux list-sessions` shows every agent's sessions). When that shared tmux server is slow — degraded
over a long runtime, a busy multi-agent machine, or another agent starting up — each synchronous
`tmux` call **blocks the entire event loop for many seconds**.

Observed (2026-06-22 incident, ~17h): Echo's loop blocked ~15s out of every ~66s. Effects:
- `/health` returns 000 during each block → the dashboard shows **Disconnected**, **0 sessions**,
  topics unresponsive. The `ServerSupervisor` force-restarts after ~6 consecutive `/health` failures
  (~60s); because a sync-spawn block burns **~0 CPU**, its CPU-starvation restart-defer does NOT
  engage, so it can force-restart the server *mid-block* — and the restart re-runs full session
  reconciliation (more sync tmux calls against the same slow server). A second amplifier: the
  `on('wake')` recovery handler itself runs synchronous blocking tmux + tunnel + WAL ops on every
  wake — so each false wake triggers *more* blocking ops against the slow server.
- A blocked sync-spawn wait burns **~0 CPU in the parent**, so `SleepWakeDetector` (even after
  #1240's per-process-CPU check, whose discriminator is `cpuBusyRatio >= 0.5`) **misreads it as
  "Wake detected after ~15s sleep"** — 934 false events over 17h, each firing the full wake-recovery
  cascade. #1240 caught CPU-*spinning* blocks; a ~0-CPU I/O-wait block falls straight through.

A process `sample` proved the loop in `node::SyncProcessRunner::Run` → `__posix_spawn` with `tmux`
the dominant child. The acute incident was mitigated by restarting the shared tmux server, but the
**fragility is structural**: any future contention re-triggers it.

## Proposed design

**Increment 1 (the interim bound — all parts ship together so no signal is silently dropped):**
(A) the hot path never blocks the loop, (B) the detector recognizes the block, (C-signal) the block
is surfaced loudly-but-bounded. **Increment 2 (the root bound):** (D) per-agent tmux socket
isolation. Increment 1 is honestly labeled an *interim mitigation* — it stops one agent flapping but
does not yet unshare the resource; Increment 2 is the actual Bounded-Blast-Radius fix.

### (A) Async, cache-fed hot path — the server loop never blocks on tmux

1. **Request/health/dashboard routes are CACHE-SERVED, never issue a live tmux call.** `/sessions`,
   `/health`, pane-stream reads already have the non-blocking `getCachedRunningSessions()` path;
   Increment 1 makes that the ONLY path for request routes. A burst of dashboard polls can therefore
   never fan out N live `tmux` subprocesses onto a degraded server.
2. **Only the single serialized monitor tick (and explicit operator actions) issue live tmux calls,
   now ASYNC.** Conversion strategy (D1): a `...Async` twin behind one wrapper boundary modeled on
   `SessionLivenessOracle`'s injected `exec` — flag **off ⇒ the byte-identical existing sync path**;
   flag **on ⇒ async**. Callers are unchanged when off. Excludes the send-keys / `/bin/sleep`
   injection sequence (those are event-driven ordering barriers, not on the periodic loop).
3. **Tri-state failure semantics — a slow tmux can NEVER look like a dead session.** Every async
   tmux result is classified `success` / `definitely-absent` (tmux answered "no such session") /
   `indeterminate` (timeout / reject / error). **Every destructive action (kill, reap, mark-dead)
   gates on a POSITIVE signal only**; an `indeterminate` is a NO-OP that PRESERVES the session +
   last-known list and increments the latency counter. An async timeout/reject is never mapped to
   "empty list" / "session gone". (Integration test: a slow/timing-out stub tmux does not zero the
   session list nor trigger any reap.)
4. **Bounded + reaped + back-pressured.** Per-call `timeoutMs` pinned to `> worst observed block`
   (default 9000, above the in-code 5000) with `killSignal: 'SIGKILL'` so a wedged tmux child is
   actually reaped (plain `execFile` timeout sends SIGTERM, which a wedged tmux may ignore). This
   bounds the Node child + the parent's wait; it does NOT heal a degraded tmux SERVER (killing the
   client doesn't fix server-side contention — that is (D) socket isolation's job); the killed-client
   rate is itself a telemetry signal feeding (C).
   **Single-flight per (session, op)** — overlapping captures of the same session share one child;
   a small **max-in-flight** bound on live tmux calls so the async conversion cannot replace one
   blocked loop with an unbounded fan-out hammering the degraded server. After every `await`,
   **re-read session state from `state`** before acting (async loses the sync-call atomicity; an
   operator kill can land mid-probe) and route mark-dead through the existing `terminating`/oracle
   guard.
5. **The amplifiers are converted/guarded too** (a poll-only fix leaves the two bigger ones open):
   the `on('wake')` recovery handler's sync tmux/tunnel calls move behind the same async wrapper (or
   are guarded by the in-flight marker so they don't pile onto a slow server); and the
   `ServerSupervisor` restart-defer consults the in-flight-sync-op marker — it must NOT force-restart
   the server while a known sync-block is in flight.

### (B) SleepWakeDetector: the in-flight-sync-op marker is the PRIMARY block-vs-sleep signal

The candidate signals are NOT equal — round-1 review proved two are non-solutions for THIS case:
- **wall-clock-vs-monotonic divergence — STRUCK.** A 15s sync-spawn block advances wall-clock ~15s
  *just like* a 15s sleep (the parent is wall-time-blocked, not paused); divergence ≈ 0 for both. It
  cannot separate block from sleep here. Demoted to, at most, corroboration for the *real-sleep*
  direction.
- **secondary liveness beat — insufficient alone.** A beat written from a worker thread cannot be
  *read* by the blocked main-loop classifier until the block ends.
- **in-flight-sync-op marker — MANDATED PRIMARY.** A single **chokepoint** that ALL synchronous
  subprocess/blocking callsites funnel through (tmux, `/bin/sleep`, tunnel, any sync spawn — not
  tmux-only) maintains a **COUNTER** (`depth > 0 ⇒ in-flight`, so overlapping ops don't clear each
  other) with a monotonic **set-timestamp**, set/cleared in **try/finally**. A drift gap while the
  counter is `> 0` (and the marker is not stale) is classified `event-loop-block` (`stall`), not
  `wake`. **Leak/crash-safe + observable:** a marker older than `2× the call timeout` is treated as
  STALE → ignored → the gap falls through to ordinary classification (a missed clear self-heals
  instead of permanently blinding sleep detection); a `staleMarker` counter is exposed for
  observability. **Both-directions safety:** the marker raising `stall` must not strip a genuine
  multi-minute sleep from the wake-reaper's sleep credit — a real sleep that begins while an op is
  in-flight is bounded by the TTL (the marker goes stale within `2×timeout`, far under a real
  sleep's duration, so the gap re-classifies as a wake).

### (C) Degraded-tmux guard — SIGNAL-ONLY on the shared socket, bounded, load-aware

`(B)`'s `stall` event has **zero consumers today** (nothing wires `.on('stall')`) — so (B) and (C)
ship in the **same increment**: a classified-but-discarded block is the silent-degradation failure
this spec exists to kill. The consumer:
- A **bounded EWMA / fixed-window ring** of tmux-call latency (NOT an append-only log — Bounded
  Accumulation). No unbounded sample array.
- Raises **ONE machine-tagged, deduped, age-escalating** Attention item per degradation *episode*
  (via the existing Topic-Flood Guard / `sourceContext`), never per slow call.
- **Load-gated + corroborated:** suppress while host load is high (mirroring SleepWakeDetector's own
  load guard) and require sustained slowness across N cycles AND not explained by overall host load —
  so a chronically-busy multi-agent box does not trip it forever (the incident's host runs 5+ agents).
- **NO automatic `tmux kill-server` on the shared socket — by construction.** Killing the shared
  daemon bounces every co-tenant agent (the 2026-06-22 lesson; recovery was luck). On the shared
  socket the ONLY automated action is the Attention item; any actual tmux-server refresh is an
  explicit operator decision (Attention Y/N), never a deterministic auto-fire from a latency
  threshold (Signal-vs-Authority). A daemon-level refresh is permitted to auto-fire ONLY against a
  per-agent **isolated** socket (Increment 2), where the blast radius is this agent alone, and even
  then behind a P19 circuit-breaker (max-N-per-window, then give up LOUDLY) + a post-refresh settle
  window during which latency samples are ignored (don't measure a server you just bounced).
- Registered in the guard inventory: a `GUARD_MANIFEST` entry + a `guardRegistry.register` callsite
  with a **pure in-memory** synchronous getter (`lastTickAt`/freshness as a property — never probes
  tmux), or it would derive a phantom `missing` alarm on `/guards`.

### (D) Per-agent tmux socket isolation — Increment 2 (the actual root bound)

Increment 1 stops one agent flapping but every agent still shares one socket; the root fix is
unsharing it (`-L <agent>`). This is its own increment because its blast radius is the WHOLE tmux
surface, with an irreversible, user-visible migration decision frontloaded below (D4).

## Decision points touched

Increment 1 introduces no block/allow gate; it removes a latent self-DoS and makes destructive
session actions strictly positive-signal-gated (safer). (B) is signal-only (never gates a message).
(C) is observe/alert; any tmux-server refresh on the shared socket is operator-authorized, never
automatic. (D) socket isolation changes a host-local resource only.

## Frontloaded Decisions

- **D1 — (A) conversion strategy + scope (named + fully in-scope here):** `...Async` twin behind ONE wrapper
  (off=existing sync byte-identical, on=async); request/health/dashboard routes are cache-served and
  issue NO live tmux call; only the serialized monitor tick + explicit operator actions issue live
  calls; EXCLUDE the send-keys/`/bin/sleep` injection sequence; `timeoutMs` 9000 + `killSignal
  SIGKILL`; single-flight per (session,op) + max-in-flight bound; tri-state (success / definitely-
  absent / indeterminate) with destructive actions positive-signal-only; re-read state after await.
  The exact callsite set is enumerated against the deployed `SessionManager` in the build, but the
  STRATEGY + boundary above is fixed here (reversible, behind the off=sync flag).
- **D2 — (B) signal:** in-flight-sync-op COUNTER marker with set-timestamp + `2×timeout` TTL,
  set/cleared in try/finally at a single chokepoint covering ALL sync subprocess callsites, is the
  PRIMARY signal; wall-vs-monotonic is STRUCK as a block-vs-sleep discriminator (documented
  non-solution) and used only as real-sleep corroboration; `on('stall')` is wired to (C) in the SAME
  increment. Expose a `staleMarker` counter. **"Covers ALL sync subprocess callsites" is ENFORCED,
  not aspirational:** a lint/guard asserts the chokepoint is the SOLE funnel for synchronous
  subprocess spawns (a new `execSync`/`spawnSync`/`execFileSync` outside the chokepoint fails the
  guard), so the marker can't silently rot to tmux-only. Honest residual: the marker catches
  sync-subprocess/blocking-IO blocks; a non-subprocess event-loop block (a long GC pause, a wedged
  native addon) is NOT claimed — it is a documented out-of-scope residual, classified by the
  existing CPU/load path, not by this marker.
- **D3 — (C) guard:** bounded EWMA/ring (no append-only log); ONE machine-tagged, deduped,
  age-escalating Attention item per episode; load-gated + N-cycle corroborated; **NO auto
  kill-server on the shared socket** (operator-authorized only); `GUARD_MANIFEST` + `guardRegistry`
  with a pure-in-memory getter.
- **D4 — (D) socket-isolation migration (the irreversible/user-visible decision, frontloaded):**
  **new spawns only.** Live sessions are intentionally LEFT on the shared socket until they exit
  (you cannot `-L`-move a live tmux session, and reaping a live REPL = losing a user conversation);
  no migration/orphan-reap of existing sessions. The per-agent socket label is **derived
  deterministically from the agent identity** (never a free-form config value — a free-form `-L`
  re-couples agents and is a cross-agent foot-gun), charset-validated `^[a-zA-Z0-9_-]+$`, asserted to
  contain no path/shell metacharacters; documented as a contention boundary only, NOT a privilege
  boundary (same-UID sockets under `/tmp/tmux-<uid>/`). The build ENUMERATES every tmux consumer
  (HealthChecker, SessionLivenessOracle, ServerSupervisor — which owns the `<project>-server`
  session, OrphanProcessReaper, `nuke.ts` (fix its hardcoded `'tmux'`), cli `status`/lifeline,
  threadline `PipeSessionSpawner`, hooks resolving `#S`/`$TMUX`) and decides per-consumer: adopt the
  per-agent socket, or stay on default (the server session itself stays on whichever socket
  ServerSupervisor + cli + watchdog already target — they must agree). No split-brain.
- **D5 — Migration Parity:** the (A)/(B)/(C) feature flags go through `ConfigDefaults` with `enabled`
  **OMITTED** (rides `resolveDevAgentGate` live-on-dev/dark-fleet — the #1001 lesson: a persisted
  `false` ships dark even to dev, so a `migrateConfig` strips any stale `false`); `sessions.tmuxSocket`
  needs explicit `Config.ts` default handling (sessions.* is assembled imperatively, not via
  `applyDefaults`) + a `migrateConfig` add-missing entry; register the flags in `DEV_GATED_FEATURES`
  (drives the both-sides wiring test).
- **D6 — Rollout + promotion:** dark/flagged, behavior-preserving when off. "Preserving" = the off
  path is **behaviorally identical for externally observable outcomes** (same return values, same
  thrown errors where a caller relies on them, same destructive actions, same session-state
  transitions) — NOT literally byte-identical stack traces / timing / log lines (a shared wrapper
  changes those harmlessly). The E2E asserts those observable invariants on the off path. Echo is the
  dev agent (dogfood). Named promotion
  criteria: flip the default ON after N days of dev-agent soak with zero spurious-reap / zero
  false-wake regressions — so the known-bad sync default is not left as the permanent shipped default.
- **D7 — Multi-machine posture (each surface declared):** tmux server, sockets, latency stats, the
  in-flight marker = **machine-local BY DESIGN** (tmux is host-local; the block happens on whichever
  host runs the session). (C)'s Attention item is **machine-tagged and NOT pool-coalesced across
  hosts** (each host's tmux is a distinct resource; two hosts' degraded-tmux items stay individually
  visible). No replicated state, no new `MultiMachineSyncStatus` field.

## Open questions

*(none)*

## Testing (three tiers)

- **Unit:** (A) the async wrapper resolves/rejects with a bounded timeout and SIGKILLs the child;
  off=sync path unchanged; tri-state classifier maps timeout→indeterminate (kept), tmux-"no
  session"→definitely-absent (reapable), success→present; single-flight coalesces concurrent same-
  session captures. (B) the marker counter labels a ~0-CPU gap with `depth>0` as `stall` and a
  ~0-CPU gap with `depth==0` as `wake` (BOTH sides of the boundary); a stale marker (> 2×timeout)
  is ignored (self-heal) and increments `staleMarker`; a real multi-minute sleep beginning mid-op is
  still credited to the wake-reaper. (C) the latency tracker is a bounded EWMA/ring (no growth under
  a burst — the Bounded-Accumulation burst-invariant); flags sustained slowness but NOT a single
  hiccup nor a high-host-load period; the Attention item is deduped per episode; the `guardRegistry`
  getter is pure in-memory. (D5) DEV_GATED_FEATURES both-sides (live-on-dev / dark-on-fleet).
- **Integration:** with a stub tmux that sleeps ~15s, `/sessions` + `/health` keep answering
  (cache-served) AND a slow/timing-out tmux does NOT zero the session list nor trigger any reap
  (the tri-state guarantee); the monitor tick stays bounded (does not stack). The amplifiers:
  the wake-recovery handler does not fire a blocking-tmux storm, and ServerSupervisor does not
  force-restart while the in-flight marker is set.
- **E2E:** the flags are alive in the server-boot path and FULLY INERT when off (off path is
  byte-for-byte the pre-change sync behavior — the feature-alive + inert-when-dark test).

## Source

2026-06-22 incident: `docs/specs/...` / agent memory `incident_shared_tmux_server_degradation_flapping`.
Builds on #1240 (SleepWakeDetector per-process CPU check — INCOMPLETE for ~0-CPU I/O-wait blocks,
which (B) closes). Bounded Blast Radius standard (the shared-resource coupling (D) unshares). No
Silent Degradation (the stall consumer ships with the classifier). Round-1 convergence reviewers
(security, scalability, adversarial, integration/multi-machine, decision-completeness, lessons-aware)
materially reshaped this design — see the convergence report.
