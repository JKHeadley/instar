---
title: "Fork-Bomb Prevention (SIMPLE) — host-wide spawn cap + single-instance lock"
slug: "forkbomb-prevention-simple"
author: "echo"
parent-principle: "Structure beats Willpower — a safety control must ENFORCE, not advise"
source-postmortem: "the-portal/docs/postmortems/2026-06-20-echo-instar-forkbomb-oom.md"
severity: "SEV-1 (full host OOM ×2, recurred after reboot)"
supersedes: "forkbomb-prevention.md (the elaborate 17-round design — retained as the failure-mode reference; this is the build target)"
status: "draft — simple redesign, VALIDATED + build-ready. Cross-model (codex gpt-5.5): SERIOUS (elaborate) → MINOR (simple) → consistency-clean; all findings applied. Lessons-aware internal: NEEDS-CHANGES → all 3 must-fix applied (outbound CoherenceReviewer 4th fail-closed branch; P1 is a per-evaluate() wrapper not build-time acquire; emergency-stop deterministic pre-check exempt from the cap) + migrateConfig note. Every code-grounding claim verified true. All other dimensions (holder-set crash model, bounded-heap poll-retry, OS-simple-first, never-ship-floor-dark, deploy-handoff, 3-tier tests, migration parity) confirmed SOUND."
review-convergence: "2026-06-22T20:07:49.948Z"
review-iterations: 4
review-completed-at: "2026-06-22T20:07:49.948Z"
review-report: "docs/specs/reports/forkbomb-prevention-simple-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
approved: true  # session pre-approval (Justin, 24h autonomous mandate: "move forward to finish out the fork-bomb fix"); validated by independent cross-model + lessons-aware reviewers
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Fork-Bomb Prevention (SIMPLE)

## Why this spec exists (and why it is SHORT)

The elaborate predecessor (`forkbomb-prevention.md`, 17 internal review rounds, 2400 lines) was
judged **SERIOUS ISSUES by two independent non-Claude models** (gpt-5.5 + gemini-2.5-pro) on the same
frame-level critique the internal rounds never raised: it is **over-engineered** (a custom lane-aware
semaphore, reserve math, acquire-budget timeout math, per-gate typed-shed dispositions, hysteresis —
"a partially-correct implementation whose interactions differ from the prose" is the likely failure
mode), the **per-process cap is the wrong PRIMARY primitive** for a host OOM (the resource is
host-wide and cross-agent), and the round-17 "never-shed-inbound / unbounded block-and-wait" fix
**reintroduced an unbounded-heap risk** under the actual incident driver (inbound flood / backlog
replay). This spec is the simple, robust, OS-aligned replacement. Defense-in-depth nuance (lanes,
priority fairness, per-gate disposition surgery) is explicitly OUT — it can come later if measured to
be needed.

## Problem statement

On 2026-06-20 the Instar server fork-bombed its macOS host into OOM **twice** (~230-289 concurrent
`claude -p` processes ≈ 90-115GB). Driver: `ClaudeCliIntelligenceProvider.evaluate()` spawns one
`claude -p` per call with **zero concurrency control**; `CoherenceGate` fans ~10 reviewers in
parallel per message; a stuck message drove a 503→lifeline-restart→reflood loop; and **three** revive
vectors (launchd, fleet, tmux) ran **up to 3 concurrent server instances**, each re-flooding. The
interim mitigation (a module-level semaphore in the shadow-install dist, cap=3) was **wiped by the
1.3.642 auto-update** — Echo currently runs **uncapped**.

## The design — three primitives

### P1. Host-wide concurrent-spawn cap — a counting semaphore (the PRIMARY control)

A single shared, host-local **counting semaphore** (concurrency-occupancy, NOT a rate-limiting token
bucket — it bounds how many LLM subprocesses run AT ONCE, not how many per second) bounds concurrent
LLM subprocess spawns across **every compliant Instar agent and every server instance on the host**.

- **Honest guarantee:** the bound holds **for compliant Instar processes that go through the funnel**
  (P1's lint enforces this for our own code). A co-resident process that is a stale/custom version,
  or that launches `claude -p` outside this codepath, is NOT bounded by P1 — so the host-wide
  guarantee is "for compliant Instar processes." For genuinely host-global protection against a
  non-compliant flooder, an OS-level hard ceiling (`ulimit -u` in the launchd plist, or a launchd
  per-job process limit) is the belt under P1's suspenders — **RECOMMENDED defense-in-depth, applied
  conservatively** (a generous limit that bounds a runaway without affecting normal operation) —
  included IN this PR (promoted from a later increment per the cross-model review).
- **Mechanism — a holder-SET model (NOT decrement/increment counter math):** a host-local file at a
  fixed path (e.g. `~/.instar/host-spawn-holders.json` — host-local, NOT a synced/shared volume),
  guarded by an exclusive `flock` (the `O_CREAT|O_EXCL`/`flock` pattern in-tree at
  `ProjectRoundLock.ts`). The cap is enforced by **counting LIVE holder records**, not by mutating a
  shared integer: **acquire** = under the lock, prune dead holders, and if `liveHolders < cap` append
  a holder record `{id: <unique>, pid, hostname, heartbeat}` (atomic temp-file + rename); **release**
  = under the lock, remove THIS caller's unique holder id. This is crash-safe by construction — a
  double-release is a no-op (id already gone), a pid-reuse can't steal another's slot (unique id, not
  pid), a partial write is discarded (temp+rename), and a crashed holder is reclaimed by the
  prune-dead step (pid no longer alive AND heartbeat stale, on THIS host only). Mirror `ResumeQueue.ts`'s
  host-local-lock contract: a **foreign-hostname** holder is NEVER pruned/reclaimed (refuse-loud); a
  `df -P` host-local-disk confirmation gates reclaim (fail-closed). A long spawn that pauses its
  heartbeat is NOT reclaimed while its pid is alive (pid-liveness is the primary signal; heartbeat is
  the secondary).
- **Cap:** `INSTAR_HOST_SPAWN_MAX` (default **8**) concurrent LLM subprocesses across the whole host.
  Rationale: ~8 × ~400MB ≈ 3.2GB — survivable on the 128GB host with wide margin, vs the incident's
  230+. Operator-tunable.
- **Chokepoint — a per-`evaluate()` wrapper provider (NOT a build-time acquire):** P1 is a thin
  **wrapper provider** layered exactly like `wrapIntelligenceWithCircuitBreaker` — its `evaluate()`
  **acquires** a semaphore holder, `await`s a slot, calls the inner provider's `evaluate()` (the
  spawn), and **releases in a `finally`**. It is INSTALLED at the provider factory funnel
  (`buildIntelligenceProvider` in `intelligenceProviderFactory.ts`), wrapping every provider the
  factory returns (incl. the InteractivePool + headless members) + the `reflect.ts` raw fallback
  (route it through the factory). The factory is only the **install point**; the acquire happens
  per-call inside `evaluate()`. This is load-bearing: `CoherenceGate` builds its provider ONCE
  (`CoherenceGate.ts:110`) and fans ~10 reviewers in parallel through that ONE shared instance (the
  primary incident driver) — so each of the N concurrent `evaluate()` calls must independently
  acquire. A build-time acquire would NOT bind the fan-out. A lint
  (`scripts/lint-no-unbounded-llm-spawn.js`, model on the existing `lint-no-unfunneled-headless-launch.js`)
  forward-guards any new raw spawn that bypasses the funnel.

### P2. Single-instance lock (stops the 3×-instance flood)

A per-agent host-local lock so launchd + fleet + tmux cannot run **duplicate** server instances of
the same agent (the 3× multiplier that made the incident catastrophic).

- **Mechanism:** `ProjectRoundLock.ts` `O_CREAT|O_EXCL` atomic primitive; holder record =
  pid + `os.hostname()` + heartbeat mtime. A **foreign-hostname** lock is NEVER pid-probed or
  reclaimed (refuse-loud — the multi-machine shared-state-dir hazard, 2026-06-15); same-host stale
  reclaim is gated on a `df -P` host-local-disk confirmation (fail-closed). Release via BOTH a
  `finally` and a process exit handler (SIGTERM/SIGINT/exit). A legit standby on a DIFFERENT host
  with its own non-shared state dir boots freely.
- **Deploy handoff (NOT too blunt — cross-model finding #5):** the lock must not break a normal
  restart/upgrade. The incoming instance, on finding a live same-host holder, **waits a bounded grace
  for the outgoing instance to release** (the existing restart path already kills-then-respawns, so
  the outgoing holder's exit handler frees the lock) before refusing — so a clean restart hands off,
  and only a genuine *duplicate* (two independent supervisors racing) is refused. An explicit
  operator override (`INSTAR_ALLOW_SECOND_INSTANCE=1`) exists for an intentional admin/debug instance.
  The refusal is the duplicate-flood guard, not a deploy blocker.

### P3. Bounded ingress (NEVER an unbounded wait queue)

When the host cap (P1) is saturated, a spawn request **waits a bounded time** for a token, then takes
a **safe non-fail-open disposition** — it is NEVER an unbounded block-and-wait (the heap risk the
cross-model review caught), and NEVER a silent fail-open.

- **Bounded wait via poll-retry, NOT an in-memory waiter queue:** acquire does not park a large
  closure in an in-memory queue (64 waiters × retained prompt/context could itself be material heap —
  cross-model finding #4). Instead it **polls the file-lock holder-set on a short interval** (e.g.
  100ms) up to `INSTAR_SPAWN_ACQUIRE_MS` (default **5000ms**); each poll is a cheap lock+count, the
  caller's large prompt state stays where it already lives (not duplicated into a queue node). A
  bound on *concurrent pollers* (`INSTAR_SPAWN_WAITERS_MAX`, default **64**) is enforced by the same
  holder-set (a "waiting" marker pruned on timeout), so even the waiters are bounded — and because a
  waiter retains nothing beyond its own already-allocated call, there is no queue-node heap growth.
- **On genuine exhaustion (timeout OR queue full):**
  - A **safety-gating** call (`gating: true`) is **held, not passed** — never `category:'normal'` /
    `verdict:'coherent'` / `pass:true` on a capacity shed. This is **FOUR small fail-CLOSED catch
    additions** (NOT the elaborate per-gate typed-shed machinery), because — CORRECTING an earlier
    draft — the outbound path is NOT already fail-closed (lessons-aware finding):
    - **Three INBOUND gates** (`MessageSentinel.classify`, `InputGuard.reviewTopicCoherence`,
      `MessagingToneGate.review`): each catch returns a typed "capacity-unavailable" result the caller
      treats as DO-NOT-AUTO-PASS / hold.
    - **The OUTBOUND CoherenceReviewer** (server-side, inside `CoherenceGate._evaluate`): today its
      fail-open branches return `pass:true` (`CoherenceGate.ts` ~394/497/509/559/610) — so a shed
      reviewer would be delivered UN-reviewed. Add a capacity-shed branch returning **`pass:false`**
      (block-the-turn) so the existing `response-review.js` `exit(2)` actually fires. (A capacity
      shed is an in-server verdict, NOT an HTTP error, so it is distinct from `response-review.js`'s
      own server-error fail-open, which stays as-is.)
  - **Emergency-stop is NEVER gated on LLM capacity (lessons-aware finding):** `MessageSentinel`'s
    deterministic keyword pre-check for "stop everything"/emergency-stop runs **before** the LLM
    classifier and is **exempt from the spawn cap** — so a user halting a runaway always halts even
    when P1 is saturated. Only the LLM-judgment portion is subject to the capacity-hold; the
    deterministic emergency-stop trigger is not. (Consistent with the existing
    `emergency-stop > pause > redirect > normal` priority; adds NO elaborate machinery.)
  - **The hold is TERMINAL for that attempt** — it does NOT re-inject the message into the
    forward-retry/replay path that drove the incident (cross-model finding #3): the turn is blocked
    and the message is surfaced for the user to resend, not auto-replayed. So a capacity shed cannot
    become a self-feeding backlog loop — and P1's cap + P2's single-instance lock have already removed
    the catastrophic multiplier that made the original 503→restart→reflood loop fatal.
  - A **non-gating background** call sheds and degrades to its existing heuristic/no-LLM path (loud
    + counted, never silent — per the never-silently-degrade standard).

This bounds BOTH process count (P1 cap) AND heap (bounded waiter queue) — the two OOM vectors — while
keeping every safety gate fail-CLOSED.

## Explicitly OUT of scope (the elaborate predecessor's catalogued features)

Priority lanes, `reserveInteractive`, acquire-budget/`minSpawnMs`/`hardCapMs` timeout math, per-gate
typed-shed `unavailableCount`/criticality surgery, free-memory hysteresis, the consumer-seam HOLD
patches. The elaborate spec retains these as a catalogued reference; this build does not implement
them. **Reducing the number of LLM gate spawns at the source** (replacing LLM reviewers with
deterministic logic — the gemini finding) is a separate, larger architectural track, not this PR.

## Frontloaded decisions

- **D-CAP:** host cap default **8**, acquire poll-timeout **5000ms** (100ms poll interval),
  concurrent-waiters cap **64**, holder-SET model (not counter math). All env/config-tunable; the
  mechanism is unconditionally ON (a safety floor never ships dark) — read `intelligence.spawnCap.*`
  with a plain `?? default`, NOT `resolveDevAgentGate`. PLUS a RECOMMENDED OS-level `ulimit -u` /
  launchd process limit in the plist as host-global belt against a non-compliant flooder (generous,
  conservative). The `intelligence.spawnCap.*` defaults are added to `migrateConfig()` (Migration
  Parity — existence-checked, only-add-missing) so existing fleet agents materialize the knobs;
  absence is already safe via the `?? default` read.
- **D-DISPOSITION:** a capacity shed of a gating call is a fail-CLOSED hold (typed
  capacity-unavailable → do-not-auto-pass / `pass:false`), NOT the elaborate per-gate disposition.
  **FOUR small catch-branch additions:** the three INBOUND gates
  (MessageSentinel/InputGuard/MessagingToneGate) + the OUTBOUND CoherenceGate reviewer path (which is
  NOT already fail-closed — it returns `pass:true` today). PLUS the deterministic emergency-stop
  pre-check stays exempt from the cap (a "stop everything" halt is never gated on LLM capacity).
- **D-LOCK:** P1 host-spawn semaphore + P2 single-instance lock both use the in-tree `ProjectRoundLock.ts`
  `O_CREAT|O_EXCL` primitive + the `ResumeQueue.ts` host-local-lock contract (hostname-stamped,
  foreign-host refuse-loud, `df -P` host-local-disk gate). No new dependency (we do NOT pull in
  BullMQ — gemini's suggestion — to avoid a heavy new dep; the file-lock primitives already exist
  in-tree and are sufficient for a host-local cap).
- **D-ROLLOUT:** ON by default fleet-wide (a safety floor that ships dark is no floor). Land the cap
  + single-instance lock + bounded ingress + the lint + a burst-invariant ratchet test + the
  STANDARDS-REGISTRY "Bounded Blast Radius" article in ONE PR (so it lands enforced, not
  documented-only). Verify every co-resident agent (echo/gemini/sagemind) updates onto the capped
  version (a per-host cap only contains OOM when all co-resident agents carry it).

## Tests (3 tiers)

- **Unit:** holder-set semaphore acquire/release + flock contention + stale-holder reclaim (host-aware: a
  foreign-hostname token is never reclaimed); bounded-wait timeout; waiter-queue cap → shed; the
  single-instance lock (same-host second instance refused; cross-host standby boots). Burst-invariant:
  10,000 acquire attempts → live tokens never exceed the cap (Bounded Accumulation).
- **Integration:** a stub provider that sleeps; N concurrent evaluate() calls → at most `cap` spawn
  concurrently, the rest wait-then-shed; a gating call on shed is HELD (not passed); a background call
  on shed degrades loud. The lint flags a fresh raw spawn outside the funnel.
- **E2E:** the cap + lock are ALIVE at the production init path (on by default), and a supervisor
  kill+launchd-respawn does NOT produce a second concurrent instance (single-instance lock holds) and
  does NOT re-flood (cap holds).

## Honest scope

A-core (this spec) bounds the host's concurrent LLM-subprocess count (the SEV-1) and the duplicate
-instance multiplier, with bounded heap and fail-CLOSED gates. The poison-pill restart-loop
dead-lettering (the message that couldn't forward and drove the reflood) is a small later increment
<!-- tracked: docs/planning/2026-06-20-forkbomb-prevention-plan.md -->: the single-instance lock + the cap already break the catastrophic amplification,
so the loop becomes survivable, but a backoff/dead-letter on a repeatedly-stuck forward is the
clean closure. The OS-level `ulimit -u` / `launchd` process limit (codex's "even simpler" suggestion)
is **included in this PR** as a conservative host-global belt in the launchd plist (consistent with
D-CAP — it ships here, not in a later increment), under the host-wide holder-set semaphore which already gives
a host-wide bound without a macOS-global `ulimit` that could affect unrelated processes.
