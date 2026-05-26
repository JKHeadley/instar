---
title: SessionReaper Spec
review-convergence: "3-way (codex/gpt-5.5 + 2 code-grounded Claude passes), 2026-05-25"
approved: true
eli16-overview: SESSION-REAPER-SPEC.eli16.md
topic: 13201
---

# SessionReaper Spec

**Status:** v2 CONVERGED + RATIFIED (user-approved 2026-05-26, topic 13201). 3-way review: codex/gpt-5.5 + 2 code-grounded Claude passes.
**Topic:** 13201 (🧹 SessionReaper)
**Author:** echo
**Created:** 2026-05-25 · **Converged:** 2026-05-25
**Companion:** `SESSION-REAPER-SPEC.eli16.md`

> **Convergence changelog (v1 → v2):** Review unanimously found v1's central safety claim — "C+D+E are three independent sensors; a false-reap needs all three to fail" — **false in the real code**. In-process/network work (LLM generation, MCP/WebFetch, API stall) shows **no child process, no pane change, no transcript growth** — all three "sensors" fail together. Worse, gates E/F/K all hinge on the **optional, frequently-absent `claudeSessionId`** and Claude-only transcript paths (`~/.claude/projects`), so they are structurally dead for Codex sessions and for any agent whose hooks never fired. v2 **inverts the classifier** from "absence of activity ⇒ reap" to "**positive proof of a completed, idle turn ⇒ eligible; anything unknown ⇒ KEEP**," adds a per-signal **confidence contract** (unresolvable ⇒ KEEP), a **provider-neutral session key**, a single-writer `terminateSession` kill path, and a fresh-confirmation-after-boot rule. See §10 for the full finding→fix table.

---

## 1. Problem

We clean up **crashed/zombie** sessions, but nothing safely sweeps a session that is **idle-but-alive** — sitting at its prompt, doing nothing, holding memory. On 2026-05-25 these piled up across the fleet: 51 agent sessions / 260 processes / ~37 GB used / 1.4 GB free. Under that pressure, agents refused to spawn sessions to read incoming messages ("too busy, spawn denied"), and cross-agent collaboration silently failed. Reaping 42 stale sessions freed ~38 GB and recovery was immediate.

### 1.1 Why the existing idle-kill did not prevent this

`SessionManager.monitorTick` (src/core/SessionManager.ts:559–677) already kills idle sessions: `IDLE_PROMPT_KILL_MINUTES = 15` (unbound), `IDLE_PROMPT_KILL_MINUTES_BOUND_TO_TOPIC = 240` (4 h, topic-bound). It still let 42 sessions accumulate. Four concrete defeat mechanisms, all present in the case study:

1. **The idle clock is in-memory and resets on every restart.** `idlePromptSince` is a `Map` on the live object (SessionManager.ts:149). The case study's root cause #1 was a *crash-looping server*. Every crash/restart wipes the map → a session idle for days never accumulates the continuous 4 h needed to be killed. **The crash-loop literally protected the idle sessions.**
2. **The pane-pattern gate is fragile.** Idle-kill fires only if `IDLE_PROMPT_PATTERNS` match the last 5 lines (SM:565–577). A pane showing leftover output, a partial render, an unrecognized error, or scrolled content fails `isIdleAtPrompt` → treated as *active* → never reaped. (Note: this is the *opposite* failure direction from a false-reap — here it under-reaps. v2's classifier must not inherit this fragility in *either* direction.)
3. **No pressure awareness.** The 4 h topic-bound window is by-design generous. With many topics × agents, dozens sit alive *correctly* — until the machine starves. Per-agent idle-kill is purely time-based; blind to the memory pressure that makes the pileup harmful.
4. **Per-agent scope, not fleet.** Each agent's `SessionManager` sees only its own sessions. The 51-session pileup spanned all agents; no component factors in machine-wide resource state.

### 1.2 What SessionReaper adds

A **pressure-aware, restart-durable, positive-evidence reaper** that reaps an idle session **only when the machine actually needs the memory back** and **only when it can positively prove the session's turn is complete and idle**. It does not replace the fast 15 m at-prompt idle-kill — it covers the pressure-driven and ambiguous cases that one misses, while being *strictly more conservative* about what it will kill.

---

## 2. The hard requirement (user, 2026-05-25)

> "STRONG focus on NOT reaping sessions that might be working on something. A robust set of checks and metrics... an intelligent decision."

**Design posture (v2):** the reaper does **not** infer idleness from the *absence* of activity signals. Absence is ambiguous — a session mid-LLM-generation or mid-network-call produces no observable activity yet is fully working. Instead the reaper requires **positive, framework-confirmed evidence that the turn is complete and the session is parked at a ready-for-input prompt**, *plus* the absence of every protect signal, *plus* render stasis. **Any ambiguity, any unresolvable signal, any unknown framework state → KEEP.** We would rather leak an idle session for many ticks than reap one that was thinking.

---

## 3. Design

### 3.1 The classifier: positive-evidence, confidence-gated

`classify(session) → KEEP | REAP_ELIGIBLE`. Every signal returns `{verdict, confidence}`. **A session is `REAP_ELIGIBLE` only if ALL of the following hold; any failure, any `confidence:'low'`, any unresolved probe ⇒ KEEP.**

**(1) Positive idle proof (REQUIRED — the gate v1 lacked).** A framework-specific detector must *affirmatively* confirm the session is **turn-complete and parked at a ready-for-input prompt** — not merely "no work signal seen."
- Claude Code: the idle input box / ready prompt is positively rendered in the captured pane (extend `IDLE_PROMPT_PATTERNS`, used as *positive* evidence here).
- Codex CLI: the ready prompt is positively rendered, *and* none of the Codex active markers (`Working (Ns`, `• Ran`, `esc to interrupt`, spinner) appear anywhere in the captured buffer (per `frameworkActivitySignals.ts`).
- **Framework cannot be resolved** (`SessionManager.frameworkForSession()` returns undefined) **⇒ KEEP** (confidence low). No reaping on an unknown framework's render.

**(2) Render stasis (REQUIRED).** The captured pane — **≥ 200 lines**, scanned in full, not just the tail — must be **byte-identical across every one of the `confirmObservations` ticks**. A streaming generation updates the token counter / spinner / output every tick; a truly parked prompt does not. This is the **primary real-time liveness signal** and closes the in-process/network-work hole that defeats process-tree and transcript checks.

**(3) No active work (process + transcript), with confidence contract.**
- **Process liveness:** `hasActiveProcesses()` (no non-baseline children) **plus** main-process liveness deltas from the pane PID (CPU-time / IO-counter movement across ticks). A moving main process = work even with no child. **Cannot inspect the process tree ⇒ KEEP.**
- **Transcript growth:** resolved **per-framework** (Claude `~/.claude/projects/...`, Codex `~/.codex/sessions/YYYY/MM/DD/rollout-*-<uuid>.jsonl` via `FrameworkSessionStore`). Persist *file identity* (path + inode + size + mtime), not just a session id. **Unresolved / missing / rotated / truncated / permission-error transcript ⇒ KEEP** (never counted as "quiet"). Growth ⇒ KEEP.

**(4) Protect-gates — all must pass; each carries a confidence contract (missing dependency ⇒ KEEP for that class, never "gate passes").**

| # | Protect when… | Source (verified) | Confidence note |
|---|---------------|-------------------|-----------------|
| A | in `config.protectedSessions` (e.g. `*-server`) | `Config` | always resolvable |
| B | is the reaper's own / server session | host context | always |
| G | a recovery is in flight | composed `activeRecoveryChecker` | **must be extended** to include socket + silence sentinels (today it is compaction + rate-limit only, server.ts:5230) — *compose, don't replace* (a second `setActiveRecoveryChecker` drops the existing veto) |
| H | a pending injection **or** active relay lease exists | `getPendingInjection()` (public); **needs new** `isRelayLeaseActive(sessionId)` accessor (lease map is private, keyed by instar `session.id`) | resolvable once accessor added |
| I | bound topic got a user message within `recentUserWindowMinutes` | `topicBindingChecker` + message store | KEEP if binding unresolved |
| J | the session's **bound topic** has an active commitment | `CommitmentTracker.getActive()` filtered by `topicId` — **commitments have no `sessionId`**; re-scoped to topic | KEEP if topic unresolved |
| K | an active subagent maps to this session | `SubagentTracker.getActiveSubagents(claudeSessionId)` | keyed on `claudeSessionId`; **absent ⇒ KEEP** |
| L | a `/build` or `/autonomous` is live for this session's **topic/project** | autonomous: `.instar/autonomous/<topicId>.local.md` `active:true` + recent mtime; build: non-idle `build-state.json` phase (project-wide; cannot be narrowed to one session) | topic/project-scoped, not per-session |
| M | `age < minAgeMinutes` (spawn grace) | session record | always |

> **Honesty about independence (corrects v1's false claim):** signals (1)–(3) are *not* fully independent. Process and pane both derive from `ps`/tmux; transcript, token-ledger (gate K's cousin) and subagent signals all hinge on `claudeSessionId` + framework transcript paths. The real safety does **not** come from "three independent sensors" — it comes from (a) requiring a **positive** turn-complete signal, (b) **render stasis** as a real-time channel that is independent of `claudeSessionId`, and (c) the **confidence contract**: every channel that cannot resolve forces KEEP rather than contributing a false "quiet."

### 3.2 Hysteresis (necessary, not sufficient)

A candidate must satisfy (1)–(4) **continuously** across `confirmObservations` ticks spanning ≥ `confirmWindowMinutes`; any non-candidate observation resets the counter. **Hysteresis alone is explicitly NOT relied upon** to cover sustained-but-quiet work (a 12-minute build or a long generation can sit inside the window). The defense against *sustained-quiet* work is the **positive-idle requirement + render stasis** (§3.1), not the window length.

### 3.3 Adaptive idle threshold (pressure-driven, macOS-aware)

Idle duration must exceed a threshold that tightens as the machine starves. **`os.freemem()` alone is rejected** — on macOS (the case-study platform) it excludes the large reclaimable cache/compressed pool and routinely reads alarmingly low on a healthy Mac, which would spuriously select the tightest threshold.

Pressure tier = composite of: **spawn-denial rate** (the actual case-study symptom — primary), macOS `memory_pressure` / `vm_stat` page-out rate, `QuotaTracker` state, and `freemem%` as *advisory only*.

| Tier | Trigger | Idle threshold | Behavior |
|------|---------|----------------|----------|
| **Normal** | no pressure signal | **effectively off** (rely on existing 15 m/4 h idle-kill) | reaper idle |
| **Moderate** | early pressure (page-out trend / quota elevated) | `idleThresholdModerateMinutes` (def 45) | trim longest-idle |
| **Critical** | **spawn-denial observed** OR sustained page-out OR quota critical | `idleThresholdCriticalMinutes` (def 15, must exceed worst-case legitimate silent-work span) | reap oldest-idle-first to budget |

**Anti-stampede:** every agent reaps independently, so all could hit Critical at once. Mitigate with **per-host cross-process jitter** + a **shared host budget file/lock** (`<sharedRoot>/session-reaper-budget.lock`) so the fleet doesn't mass-reap in the same instant, plus a **cooldown** after each reap to re-measure pressure before the next.

### 3.4 Restart durability — default-distrust

Continuous-idle state persists to `state/session-reaper.json` keyed by a **provider-neutral composite key**: `{provider, agentId, tmux session/window/pane identity, frameworkSessionId?, transcript file identity}`. (v1's `claudeSessionId`-only key is rejected — it's absent for Codex and pre-hook sessions, and the tmux name is reused across respawns.)

**On boot, never reap from rehydrated idle alone.** A rehydrated idle-since is honored *only* if **all** hold: (a) the composite key matches unambiguously, (b) the transcript *file identity* matches and shows zero growth, and (c) a **fresh full `confirmObservations` window completes after boot** also satisfying §3.1. If any identity component is ambiguous, or the transcript can't be resolved, or work without transcript-growth may have occurred during downtime → **discard the persisted clock and restart it from boot** (apply gate M spawn-grace from boot time). A crash-loop must never let the reaper boot straight into Critical and kill a session that worked through the outage.

### 3.5 Two-phase graceful reap (full re-check under lock)

1. **Enter `reaping` state** (see §3.6) + emit structured event.
2. **Final grace** (`finalGraceSec`, def 60): re-run the **full §3.1 classifier fresh** (positive-idle + render-stasis + process/transcript + all protect-gates A–M) — **not** the narrowed process+transcript probe of v1. No nudge is injected (the reaper is a cleaner, not a recoverer).
3. **Immediately before the kill syscall**, under the `reaping` lock, re-assert: render-stasis still holds since `reaping` began, no pending injection, no relay lease, no recent user message, status still `running`/`reaping`. **Any change ⇒ abort, revert to `running`, reset the clock.**
4. **Reap:** via the single-writer path (§3.6): `endedReason:'reaped-idle'`, write to `sentinel-events.jsonl` + the `destructive-ops` audit trail, persist a transcript pointer + final pane capture for post-mortem.

### 3.6 Single-writer termination (fixes the concurrency race)

All session-termination paths — the existing `SessionManager` idle-kill **and** the reaper — must funnel through one **idempotent `SessionManager.terminateSession(sessionId, reason)`** with **compare-and-set** on a `running → reaping → completed` state machine and **exactly-once** `beforeSessionKill`/`sessionComplete` emission. While a session is `reaping`, idle-kill and injection paths must **skip/serialize** on it. `status==='running'` checks alone (v1) are insufficient — they admit interleaving, duplicate events, and clobbered `endedReason`.

### 3.7 Bounded blast radius + auto-disable

`maxReapsPerTick` (def 3) and `maxReapsPerHour`. Under Critical the cap is enforced **per-host** (via the shared budget file), not just per-agent, so N agents can't collectively over-reap. **Auto-disable:** any *ambiguous* or *failed* reap (kill errored, or post-kill verification unexpected) flips the reaper to dry-run and raises one `/attention` item — fail safe, investigate before re-enabling.

### 3.8 Dry-run-first rollout

Ships `enabled:false, dryRun:true`. In dry-run it logs every would-reap with the full per-signal breakdown + confidence to `sentinel-events.jsonl`, kills nothing. Operator validates over a real pressure event, then flips `enabled:true`.

### 3.9 Observability

`GET /sessions/reaper`: current pressure tier + active threshold + inputs (spawn-denial rate, page-out, quota, freemem-advisory), and every running session with its classifier verdict, the **specific signal/gate** that kept it (with confidence), and any reap-pending countdown; plus recent reaps with reasons. Pull surface, not chat ([[feedback_notifications_near_silent]]).

---

## 4. Placement & wiring

- **New class:** `src/monitoring/SessionReaper.ts` (EventEmitter; constructor → setters → `start()` like `SessionWatchdog`/`OrphanProcessReaper`).
- **Wired in:** `src/monitoring/sentinelWiring.ts` + `src/commands/server.ts`. Tick `tickIntervalSec` (def 120).
- **Wiring tasks the review surfaced as prerequisites:**
  - Extend the composed `activeRecoveryChecker` (server.ts:~5230) to include `socketSentinel.isRecoveryActive()` + `silenceSentinel.isRecoveryActive()` — **compose into the existing predicate, do not replace it**.
  - Add `SessionManager.isRelayLeaseActive(sessionId)` (gate H) and `SessionManager.terminateSession(sessionId, reason)` (§3.6).
  - Add `TokenLedger.sessionActivitySince(claudeSessionId, sinceMs)` (gate-K corroborator; `topSessions()` is a leaderboard, not a per-session-since query).
  - Per-framework transcript resolver shared with CompactionSentinel/RateLimitSentinel (today hardcoded to `~/.claude/projects`).
- **Scope:** per-agent reaper, machine-pressure-driven, per-host budget lock for fleet relief without a central coordinator (rejected for v1).
- **Name reserved:** `CrashLoopPauser.DEFAULT_NEVER_PAUSE` already lists `session-reaper`.

### 4.1 Non-overlap with existing watchdogs

| Component | Its target | Relationship |
|-----------|-----------|--------------|
| `SessionManager` idle-kill | tracked, at recognized prompt, no procs, 15 m/4 h | Shares the §3.6 single-writer `terminateSession`; reaper covers ambiguous-pane / restart-reset / pressure-early cases it misses. |
| `OrphanProcessReaper` | **untracked** orphan processes >1 h | Disjoint: reaper acts only on sessions *in* the registry. |
| `SessionWatchdog` | tracked sessions with a **stuck active child** | Disjoint: active-but-stuck vs positively-idle. |
| Socket/Silence/Compaction/RateLimit sentinels | sessions to **recover** | Gate G (extended) defers to any recovery in flight. |

---

## 5. Config (`monitoring.sessionReaper`) — defined in `ConfigDefaults.ts`

```jsonc
{
  "enabled": false,
  "dryRun": true,
  "tickIntervalSec": 120,
  "minAgeMinutes": 30,
  "confirmObservations": 3,
  "confirmWindowMinutes": 10,
  "paneCaptureLines": 200,            // §3.1 render-stasis window
  "recentUserWindowMinutes": 30,
  "idleThresholdModerateMinutes": 45,
  "idleThresholdCriticalMinutes": 15,
  "normalTierReaps": false,           // Normal = effectively off (approved default)
  "maxReapsPerTick": 3,
  "maxReapsPerHour": 12,
  "finalGraceSec": 60,
  "protectOpenCommitments": true,
  "pressure": {
    "useSpawnDenialSignal": true,     // primary
    "usePageOutRate": true,           // macOS memory_pressure/vm_stat
    "freememAdvisoryOnly": true,
    "crossProcessJitterMs": 5000,
    "sharedBudgetLockPath": "<sharedRoot>/session-reaper-budget.lock"
  }
}
```

---

## 6. Testing (3-tier; the dangerous cases are mandatory)

**Tier 1 — Unit:** each protect-gate A–M forces KEEP; **confidence contract** — every unresolvable signal (no framework, no `claudeSessionId`, unresolved/rotated transcript, missing tracker) forces KEEP, never "quiet"; positive-idle requirement (no positive prompt ⇒ KEEP even if all activity absent); render-stasis (any byte change across ticks ⇒ KEEP); pressure tier selection incl. macOS freemem-advisory-only; restart default-distrust (rehydrate requires fresh post-boot window); `terminateSession` CAS idempotency + exactly-once events; blast-radius + auto-disable.

**Tier 2 — Integration:** `GET /sessions/reaper` verdict + per-signal confidence over HTTP; dry-run logs-but-survives.

**Tier 3 — E2E (must include the false-reap-vector cases the review flagged):**
- Feature-alive: route 200 not 503.
- **Idle reaped vs active kept** under simulated Critical.
- **Silent-but-working kept:** a long single tool/build with no transcript growth and a scrolled-off spinner ⇒ render-stasis or process-delta keeps it.
- **API/network stall kept:** mid-generation, no pane change for > window ⇒ positive-idle absent ⇒ kept.
- **No-`claudeSessionId` session kept:** missing-signal ⇒ KEEP.
- **Codex session:** transcript resolves to `~/.codex/sessions`; unresolved ⇒ KEEP.
- **Restart rehydrate:** worked-during-downtime session not reaped at boot.
- **Final-grace race:** user message injected during `reaping` ⇒ abort.

**Wiring-integrity:** server constructs `SessionReaper` with non-null deps and calls `start()` ([[feedback_verify_component_actually_wired]]).
**Live test-as-self** ([[feedback_test_as_self_standard]]): shadow-install, run a real pressure scenario with a real in-flight build + a real Codex session, confirm both untouched, restore, then merge.

---

## 7. Migration parity

- **Config:** add `monitoring.sessionReaper` to **`src/config/ConfigDefaults.ts`** (`getMigrationDefaults`); `applyDefaults` carries it to existing agents. (v1 said `migrateConfig()` hand-writes the block — that path is deprecated; `migrateConfig` delegates to `ConfigDefaults`.)
- **CLAUDE.md template:** add a SessionReaper section in `generateClaudeMd()`.
- **Wiring + new SessionManager/TokenLedger accessors:** code in `src/`; existing agents get it on server update, new via `init`.
- **No hook changes.**

---

## 8. Open decisions (locked to approved defaults unless changed)

1. **Pressure source** — **spawn-denial (primary) + macOS page-out; freemem advisory-only.** (Was "freemem"; review showed freemem misleads on macOS.)
2. **Commitment protection (gate J)** — hard-protect any active commitment on the bound **topic** (re-scoped from per-session, which is unimplementable).
3. **Reaped-session handoff** — persist transcript pointer + final pane capture on **every** reap.
4. **Normal-tier** — **effectively off**; reaper is a pure pressure-relief valve (user-approved).

---

## 9. Standards conformance pass

- **Structure > Willpower:** machine sweeps itself, pressure-reactive, per-host budget.
- **Signal vs authority:** signals carry confidence; the budget + dry-run + single-writer `terminateSession` + auto-disable hold authority.
- **Near-silent:** `/sessions/reaper` + audit log; chat only on auto-disable `/attention`.
- **3-tier + dangerous-case E2E + wiring-integrity + test-as-self:** §6.
- **Migration parity via ConfigDefaults:** §7.
- **Bug-fix evidence bar:** live reproduce pileup→reap→recovery before claiming fixed.
- **No false reap of working sessions:** positive-evidence + confidence-contract + render-stasis is the entire §3.

---

## 10. Convergence findings → fixes (3-way: codex/gpt-5.5 + 2 Claude code-grounded)

| # | Sev | Finding (all reviewers converged on 1–5) | Fix in v2 |
|---|-----|------------------------------------------|-----------|
| 1 | BLOCKER | "Trips ≥1 sensor" false: in-process/network work has no proc, no pane change, no transcript growth | §2 + §3.1(1): **require positive turn-complete idle**, not absence of activity |
| 2 | BLOCKER | Gate C blind to main-process work (API/MCP/CPU) | §3.1(3): add main-process CPU/IO deltas; "cannot inspect ⇒ KEEP" |
| 3 | BLOCKER | Transcript probe hardcoded to `~/.claude/projects`; Codex blind; mtime-fallback grabs sibling jsonl | §3.1(3): per-framework resolver + file-identity; unresolved ⇒ KEEP |
| 4 | BLOCKER | `claudeSessionId` optional/absent collapses E+F+K together | §3.1 confidence contract + §3.4 provider-neutral key; absent ⇒ KEEP |
| 5 | BLOCKER | Final-grace race + kill TOCTOU; `status==='running'` insufficient | §3.5 full re-check under lock + §3.6 single-writer `terminateSession` CAS |
| 6 | MAJOR | Pane window too small; spinner scrolls off | §3.1(2): ≥200 lines, scan full buffer, render-stasis |
| 7 | MAJOR | Hysteresis doesn't cover >window silent work | §3.2: hysteresis necessary-not-sufficient; positive-idle is the real guard |
| 8 | MAJOR | `os.freemem` misleads on macOS; fleet stampede | §3.3: spawn-denial primary + page-out; per-host jitter + budget lock |
| 9 | MAJOR | Gate G checker omits socket/silence | §4: compose (not replace) socket+silence into `activeRecoveryChecker` |
| 10 | MAJOR | Gate J commitments keyed by topic, not session | §3.1(4)J: re-scope to bound-topic |
| 11 | MAJOR | Gate L build/autonomous have no per-session key | §3.1(4)L: topic/project-scoped |
| 12 | MAJOR | Migration via `migrateConfig` is deprecated path | §7: `ConfigDefaults.ts` |
| 13 | MINOR | Gate H relay lease / gate F per-session have no accessor | §4: add `isRelayLeaseActive`, `sessionActivitySince` |
| 14 | MINOR | Blast caps still allow 12 false kills/h/agent | §3.7: per-host cap + auto-disable on ambiguous/failed reap |
| 15 | MINOR | E2E only tests the easy case | §6: mandatory dangerous-case E2Es |
