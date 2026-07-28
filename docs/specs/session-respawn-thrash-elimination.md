---
kind: "spec"
id: "session-respawn-thrash-elimination"
title: "Session Respawn/Kill Thrash Elimination (veto-backoff for the idle-zombie hot-spin)"
summary: "Evidence-based fix for the ~72-swaps/day thrash. Ground truth REFUTES the macOS-memory and proactive-swap theories: the churn is a hot-spin veto loop — SessionManager's bound-idle zombie killer re-fires terminateSession every 5s on a session the ReapGuard permanently vetoes, because the idle clock is never reset on veto. The fix GENERALIZES the shipped P19 AgeKillBackoff primitive (#863) into a shared VetoedKillBackoff covering both the age-gate and idle-zombie branches."
status: draft
author: Echo (autonomous root-cause investigation, session-respawn-thrash mission)
date: 2026-07-03
risk-class: "safety-neutral — removes wasteful re-attempts; never changes WHETHER a kill is authorized, only HOW OFTEN a vetoed attempt is retried. No session killed today stops being killed; no session kept today starts being killed."
parent-principle: "No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes (P19): a kill the authority VETOES must back off (backoff), stop and surface once after sustained veto (breaker), and never re-fire on the next monitor tick (cap). AgeKillBackoff is the article's own canonical shape; this generalizes it to the idle-zombie branch."
lessons-engaged:
  - "P19 No Unbounded Loops / AgeKillBackoff (#863): the origin incident is the SAME loop shape one branch over (the age-gate re-firing a vetoed kill every 5s → the 2026-06-05 17,503-line flood). AgeKillBackoff is the shipped brake; this spec GENERALIZES it rather than hand-rolling a parallel Map."
  - "P14 Root-vs-symptom: Fix A (veto-backoff) is the ROOT fix (stops the re-fire); Fix B is SYMPTOM-CONTAINMENT via bounded reap-log ROTATION (a regression of A can't re-inflate the log past the size ceiling) — NOT a new persisted dedupe file (C3/L2)."
  - "P20 Fail-direction: every uncertainty (missing config, NaN cooldown, changed keep-reason) fails toward MORE evaluation / the prior per-tick behavior — never toward suppressing a legitimate kill."
  - "Structure > Willpower: a CI regression ratchet (reads the config default, measures over a no-restart window, asserts map-size returns to 0 after reap) makes the fix un-regressable rather than relying on reviewers remembering."
review-convergence: "2026-07-03T22:47:58.484Z"
review-iterations: 5
review-completed-at: "2026-07-03T22:47:58.484Z"
review-report: "docs/specs/reports/session-respawn-thrash-elimination-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
approved: true
approved-by: "Justin (operator, telegram-7812716706) — explicit 'yes please' to build the veto-backoff fix, topic 30823, 2026-07-03 16:45 PDT, after reviewing the plain-English overview"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 1
contested-then-cleared: 1
---

# Session Respawn/Kill Thrash Elimination

**Status:** DRAFT
**Owner:** Echo
**Created:** 2026-07-03
**Goal Alignment:** M5 (operator's explicit concern), Goal B (seamless agent across machines)
**Evidence:** `.instar/roadmaps/session-respawn-thrash-rootcause.md` (full log analysis)

> **Supersedes the earlier stub of this spec.** The stub assumed the root cause was the macOS `os.freemem()` metric + trailing-quota proactive-swap. **Ground truth from the live logs REFUTES both.** See §2.

## 1. Problem statement

On Mini (v1.3.737), `SessionManager` emits **8,472 `Killing zombie` WARN/day** + **~8,472 `skipped` reap-log records/day** at a **5.0s median cadence**, for a few topic-bound autonomous sessions that exceeded the 240-minute bound-idle threshold but are protected by a `ReapGuard` KEEP-reason (`open-commitment` / `recent-user-message`). `logs/reap-log.jsonl` has grown to **132MB / 463K lines**, almost entirely from this loop. The operator perceives it as ~72 session swaps/day.

## 2. Root causes (evidence-first)

Ground truth from `logs/reap-log.jsonl`, `logs/reaper-audit.jsonl`, `logs/server.log`, `logs/mesh-selfheal.jsonl`, `state/`:

- Actual kills last 24h: **2** (both legitimate `age-limit`).
- reaper-audit last 24h: **all `verdict: keep`, `tier: normal`** — the SessionReaper is NOT load-shedding.
- `state/swap-ledger.jsonl`: **does not exist** — SubscriptionPool proactive-swap has never fired.
- reap-log 24h top reason: **3,218 `[skipped] idle-zombie`** for ONE session (`tas-20260702-2`, topic 30223), re-attempted every 5s.

**Leads verdicts:** (1) proactive-swap — REFUTED (no ledger). (2) `os.freemem` macOS — REFINED: latent smell, but `tier:normal` for 24h means it is NOT firing now. (3) credential re-pointing — REFUTED. (4) liveness reconciler — REFUTED. (5) lease flap — PARTIAL (mesh-selfheal is dry-run; the real placement churn is RC#2). (6) context-wall — REFUTED (4 events total).

### RC#1 (dominant, ~99% of volume) — vetoed idle-zombie terminate never backs off

- `src/core/SessionManager.ts:1818-1858` — bound-idle kill branch: computes `idleMs = now - idlePromptSince.get(id)`, logs `Killing zombie` (1850), calls `terminateSession(id, 'idle-zombie', {disposition:'terminal'})` (1854), `continue` (1857).
- `src/core/SessionManager.ts:1144-1201` — `terminateSession` consults `ReapGuard.blockedReason()`; a keep-reason returns `{ terminated:false, skipped }` at **line 1200** — no tmux kill.
- **Bug:** the idle-zombie caller ignores the `skipped` return and never resets `idlePromptSince`. The API-error and compaction-recovery branches DO reset it (lines 1805, 1813, 1834). Monitor tick = **5000ms** (`startMonitoring(intervalMs=5000)`, line 1390). Next tick: `idleMs` still > threshold → identical veto → re-fire, **unbounded** (violates the codebase's own P19 standard).
- Thresholds: `IDLE_PROMPT_KILL_MINUTES_BOUND_TO_TOPIC = 240` (line 139); the session is 415m–1834m idle in the logs, permanently over threshold, so it spins until age-out or the next user message (which clears `idlePromptSince` via the active branch, line 1866).

**Why the age-gate branch (one branch up, line 1600) does NOT spin:** it already routes through the shipped `AgeKillBackoff` (#863) — a per-session veto-backoff ledger. The idle-zombie branch is the ONE surviving branch that never adopted the brake. That asymmetry is the whole bug, and it is why the fix is *generalize the existing primitive*, not invent a new one (§3, finding 5).

### RC#2 (secondary, real cross-machine churn) — post-transfer closeout re-attempts a vetoed kill every ~2 min

- reap reason `"topic moved to Laptop — post-transfer closeout"`, `disposition: skipped:recent-user-message`, 27–60/day on active days.
- Carries `bypassLeaseForTopicMovedCloseout` (line 1084 / 1128-1132) but the `recent-user-message` KEEP-guard still vetoes unless `bypassRecentUserMessageForConfirmedMove` is set (1183-1189). When the move isn't liveness-confirmed-with-stale-local-message, Mini can't shed its leftover → the two machines disagree on ownership → the topic can genuinely bounce (the "swap" the operator literally sees), or it spins vetoed like RC#1.

## 3. Proposed fixes

### Fix A (RC#1) — generalize `AgeKillBackoff` into a shared `VetoedKillBackoff` (root fix, P14)

**Decision (finding 5): GENERALIZE, do not hand-roll a parallel Map.** `src/core/AgeKillBackoff.ts` is already exactly the primitive this branch needs — a per-`sessionId`, memory-bounded (`maxTracked`, oldest-evicted), injectable-clock ledger exposing `shouldRequest(id, now)` / `recordVeto(id, now)` / `recordKilled(id)` / `clear(id)` / `reset(id)`. (Note: for the idle-zombie instance a zero cooldown means "no cooldown window, re-evaluate every tick" — NOT a disable; the sole disable path is `enabled: false`, which never constructs the instance. See R4-5.) The age-gate already consumes it (SessionManager lines 1600 / 1632 / 1637). Fix A extends the SAME primitive to the idle-zombie branch instead of introducing a second `idleKillVetoedUntil` Map.

**Rename + reuse:** rename the class to `VetoedKillBackoff` (a superset name; keep an `export { VetoedKillBackoff as AgeKillBackoff }` alias for the existing age-gate callsites to avoid a churny rename in one PR). Instantiate a SECOND, independently-configured instance for the idle-zombie branch: `private idleKillBackoff!: VetoedKillBackoff`, constructed from the new config knob (§4). Two instances, one class — the age-gate keeps its own 10-minute cadence; the idle-zombie branch gets its own 30-minute cadence. (Rationale for two instances rather than one shared instance: the two branches back off at different cadences and must record vetoes independently — a veto in one branch must not suppress the other.)

**Store the vetoing reason KEY (finding 9 — stale-reprieve).** `VetoedKillBackoff` gains an optional per-entry `reasonKey` recorded alongside `until`, and `shouldRequest` becomes reason-key-aware: a caller may pass the CURRENT reason key and, if it differs from the stored one, the entry is invalidated and one fresh evaluation is allowed (protection changed → re-check now, don't wait out the window). Back-compat: the age-gate callsite may omit the key and get today's behavior.

**Reason identity is a STABLE KEY, not free-form text (R3-2).** The backoff ledger keys the stale-reprieve comparison on a STABLE reason KEY (an enum / normalized key such as `open-commitment` / `recent-user-message`), NEVER the free-form human-readable `blockedReason` string. `blockedReason` may carry variable human text (interpolated ids, timestamps); comparing raw strings would over-fire the reprieve on cosmetic text drift. A `normalizeReasonKey(blockedResult)` helper maps the guard result to its stable key BEFORE it is stored or compared; only the key crosses into the ledger. One-line note: **reason identity in the ledger is a stable key, not human text — the human string is used only for the WARN/attention wording.**

**Normalization is EXHAUSTIVE and FAILS OPEN on an unknown key (R4-4).** `normalizeReasonKey` MUST map every CURRENT `ReapGuard` result variant to a distinct stable key — the known keep-reasons (`open-commitment`, `recent-user-message`, and every other variant `ReapGuard.blockedReason()` can currently return) each get their OWN key; materially-different keep reasons are NEVER collapsed onto one another.

For an UNKNOWN / unrecognized variant (a keep-reason added later that this map doesn't yet know), the function **fails OPEN** — but the fail-open key derivation is CONSTRAINED to avoid high-cardinality poisoning of the ledger:
- **Derive the key ONLY from a stable discriminator field** (the guard result's enum/type/kind discriminator), NEVER from a serialized payload or free-form human text. Interpolated ids/timestamps in the human string must never enter the key — that would mint a unique high-cardinality key every tick and unbound the ledger (the exact hazard the reason-KEY-not-text rule R3-2 closes).
- **If the unknown variant exposes NO stable discriminator** (nothing safe to key on), do NOT synthesize a key from the payload. Instead **fail open by BYPASSING the cooldown for that tick** — the branch re-evaluates this tick (prior per-tick behavior for this one unkeyable case) rather than writing a ledger entry under a fabricated key. This keeps fail-open meaning "toward MORE evaluation" (P20) while guaranteeing the ledger never accretes high-cardinality junk keys.

When a stable discriminator IS present, the unknown variant gets its OWN fresh, DISTINCT key (derived deterministically from that discriminator, never the shared `'guard'`/`'unknown'` bucket) so it is treated as a NEW reason and does NOT silently coalesce with an unrelated reason's cooldown. The Tier-1 suite enforces this EXHAUSTIVELY (test case 6b): every current `ReapGuard` result variant maps to a unique key; a synthetic unknown variant WITH a discriminator yields a distinct non-shared key; and a synthetic unknown variant WITHOUT a stable discriminator causes the tick to bypass the cooldown (re-evaluate) rather than mint a payload-derived key.

**Single guard evaluation per tick (C2 — no racey double-call).** The kill decision and the backoff/recordVeto MUST use the SAME guard result. Today the idle-zombie branch would call `reapGuard.blockedReason(session)` for the backoff gate and `terminateSession` would call the guard AGAIN internally — the reason could change between the two calls, so the backoff would record a reason the kill decision never saw. **Resolution: evaluate the guard ONCE at the top of the cooldown-expiry tick and thread that single result through both paths** via a NARROW, idle-zombie-only option.

**Guard-eval authority boundary (R3-1 / R4-2 — the precompute is a PRIVATE same-tick optimization, never a public authority parameter).** The pre-evaluated guard result is **NOT part of the public `terminateSession()` signature**. `terminateSession(id, reason, opts)` keeps its existing public shape — no new `precomputedReapGuardResult` option is exposed to any caller. Instead the single-guard-eval optimization is INTERNAL to `SessionManager`:

- A **local helper produces a typed result object immediately before the kill call** — `computeIdleZombieReapVerdict(session, now): { blocked: ReapGuardResult | null; reasonKey: string | null }` — a private method that calls `reapGuard.blockedReason(session)` exactly once and normalizes the key.
- The idle-zombie branch calls that helper, uses its result to gate the backoff (`shouldRequest`), then invokes a **private overload / internal method** — `#terminateIdleZombie(session, verdict)` (or the equivalent private path `terminateSession` delegates to) — that consumes the already-computed verdict directly. The precomputed result crosses ONLY this private, same-class boundary; it is never a field on the public options object, so no external caller can supply it for another kill class.
- **Guard-once factoring — one shared private implementation, no duplicated behavior.** The public `terminateSession(id, reason, opts)` and the private `#terminateIdleZombie(session, verdict)` MUST both delegate to a **single shared PRIVATE implementation** (e.g. `#terminateWithVerdict(session, reason, verdict)`) that accepts an internally-produced guard verdict. The public entry point produces the verdict itself (evaluates the guard once, as today); the idle-zombie entry point passes the verdict it already computed. Neither entry point re-implements the skip / WARN-log / reap-log-audit / tmux-kill behavior — that lives ONCE in the shared private implementation. This prevents the two entry points from drifting into divergent skip/log/audit semantics, and keeps the enforcement decision (kill vs skip) in exactly one place.
- Because the precompute is confined to the idle-zombie-only private path, the "assert/ignore for any other reason" concern is structurally eliminated: there is no public parameter through which a foreign reason could arrive. The **public `terminateSession()` for every OTHER reason re-evaluates the guard itself**, exactly as today.

Explicitly: **`terminateSession()` remains the sole enforcement boundary; the precomputed verdict is a private same-tick optimization inside `SessionManager` to avoid a double guard-eval, never a new authority path and never a public parameter.** The enforcement decision (kill vs skip) is still made on that single verdict inside the terminate path. One evaluation, one reason, used by the `shouldRequest` gate, the kill decision, and `recordVeto`.

**Kill-branch wiring (idle-zombie, ~line 1818):**
```ts
// Evaluate the guard ONCE for this tick via a PRIVATE local helper (C2/R4-2 — the
// authoritative verdict, produced internally; NOT threaded through the public
// terminateSession() options shape).
const verdict = this.computeIdleZombieReapVerdict(session, now);
//   → { blocked: ReapGuardResult | null; reasonKey: string | null }
// Before the kill attempt: honor an in-flight back-off window (reason-key-aware).
if (!this.idleKillBackoff.shouldRequest(session.id, now, verdict.reasonKey)) continue;
...
// Private overload / internal method consumes the already-computed verdict directly;
// the public terminateSession() signature is unchanged and gains no new option.
const result = await this.terminateIdleZombie(session, verdict); // private, idle-zombie-only path
if (!result.terminated) {
  this.idleKillBackoff.recordVeto(session.id, now, normalizeReasonKey(result.skipped) ?? verdict.reasonKey ?? 'unknown');
  // Log ONCE per (session, reason) episode — the ledger owns the once-per-episode gate
  // (finding 2: no separate idleKillVetoLogged Set; log-once folds into recordVeto's return).
  continue;
}
this.idleKillBackoff.recordKilled(session.id); // real kill → drop state
```
`recordVeto` returns a boolean `firstOfEpisode` so the single WARN is emitted exactly once per (session, reasonKey) episode — the log-once state lives INSIDE the ledger value (`{ until, reasonKey, logged, episodeCount }`) and evicts atomically with the entry, eliminating the second Set entirely (finding 2).

**Ledger value-shape seam (L1 — the `number` → object migration).** `VetoedKillBackoff`'s per-entry value changes from a bare `number` (the raw `until` timestamp the shipped `AgeKillBackoff` stored) to an object `{ until: number; reasonKey: string | null; logged: boolean; episodeCount: number }`. This is an internal-only shape change with a hard invariant: **every internal method that read the old bare number MUST now read `.until`** — `shouldRequest` (compares `now < entry.until`), `remainingMs` (`entry.until - now`), `recordVeto` (writes `entry.until`), and `evictIfNeeded`/`maxTracked` oldest-eviction (compares entries by `.until`). Missing any callsite silently compares an object to a number (`NaN`), collapsing the backoff. Back-compat for the age-gate: its `shouldRequest(id, now)` / `remainingMs(id, now)` **two-arg callsites stay valid** — the added `reasonKey` parameter is optional (omitted ⇒ key is `null`, today's behavior; a `null` stored key never triggers the stale-reprieve invalidation). The class is not persisted, so there is no on-disk value to migrate — only the in-memory readers.

**Map-leak eviction (finding 1 — HIGH).** Veto entries are keyed by `session.id`; a respawn mints a new id, so without eviction the map grows unbounded — worse here than for `idlePromptSince` because these entries target LONG-LIVED stuck sessions. Evict at BOTH lifecycle exits:
1. `terminateSession` success path (real kill) → `idleKillBackoff.recordKilled(session.id)` (already above).
2. Co-located with `state.removeSession(session.id)` in `cleanupStaleSessions` (~line 3890) → `idleKillBackoff.clear(session.id)`.
The active-output branch (line 1866, alongside `idlePromptSince.delete`) → `idleKillBackoff.reset(session.id)` so a session that resumes work is re-evaluated at the next tick, not left suppressed.
Belt-and-suspenders: the ledger's own `maxTracked` oldest-eviction (inherited from `AgeKillBackoff`) is the hard memory ceiling even if a lifecycle hook is ever missed.

**Net:** a protected idle session is evaluated + logged ONCE per cooldown episode, not every 5s. **Kill authority is unchanged** — a session with no keep-reason still returns `terminated:true`, no cooldown set.

**Disabled contract (C1 — ONE exact definition).** When `enabled: false` (the resolved value — fleet default), the idle-zombie `VetoedKillBackoff` instance is **never constructed and never consulted**. The kill branch guards the ledger behind an `if (this.idleKillBackoff)` (the field is left `undefined` when disabled): no `shouldRequest` gate, no `recordVeto`, no episode counting, no breaker/escalation, no once-per-episode log-gating — the branch falls through to its exact prior per-tick behavior (attempt `terminateSession` every tick; the guard's `skipped` return writes a reap-log record as it does today). This is the single disabled contract: **bypass — the ledger is not constructed at all** so there is zero risk of a stray side-effect. Note this is DISTINCT from `cooldownMs: 0` (R4-5), which is enabled-but-no-cooldown — the ledger IS constructed and its log-once/breaker state still exist; `cooldownMs: 0` is NOT a disable path. The ONLY disable path is `enabled: false`. See § Config & rollback and the disabled-mode test (Tier 1 case 10).

### Fix A′ — P19 breaker (finding 6)

Backoff + once-per-episode log is a cap, not a breaker. `VetoedKillBackoff` counts consecutive veto episodes per session (`episodeCount`, reset by `reset`/`recordKilled`/`clear`). After `escalateAfterEpisodes` (default 6) cooldowns on the SAME session with the keep-reason still active, raise **ONE** attention item (`"Session X on topic N is permanently vetoed from idle-zombie cleanup (reason: …) — likely a stuck open-commitment or a resume-loop; investigate"`) — gated through the `IncidentDedupe` seam (below) so it emits at most once per incident, durably across restarts and machines.

**Escalate ONLY on a genuine stuck-session keep-reason (second-pass-review addendum — the multi-machine standby gap).** The idle-zombie kill is `origin:'autonomous'`, so on a STANDBY (non-lease-holder) machine `terminateSession` short-circuits at the lease gate with `skipped:'not-lease-holder'` BEFORE the keep-guard runs — and `protected`/`in-flight`/`already-*` are likewise authority/CAS skips, not keep-reasons. Escalating those as "permanently vetoed from idle-zombie cleanup" is false, and a standby machine would emit misleading HIGH items every incident. So the breaker escalation is gated on an explicit `IDLE_ZOMBIE_ESCALATION_REASONS` set — the stuck-session keep-reasons (`open-commitment`, `recent-user-message`, `active-subagent`, `structural-long-work`, `active-process`, `main-process-active`, `process-uninspectable`, `pending-injection`, `relay-lease`). A skip OUTSIDE that set still COOLS DOWN (`recordVeto` — the flood-stop is universal, incl. the standby `not-lease-holder` flood) but NEVER raises the attention item. (`protected`/`spawn-grace`/`recovery-in-flight`/`guard-error` are intentional-or-transient keeps, also excluded.) This addendum closes the gap that the round-1..5 convergence panel did not surface: the original §Multi-machine posture "strict no-op on a single-machine agent" was silent on the standby-machine *escalation* path.

**Best-effort "one per incident" (C4 — precise contract).** The in-memory `episodeCount` is NOT the dedupe authority — a server restart resets it to 0, and each machine keeps its own counter, so relying on it would re-emit the "one" item on every restart and once per machine. The dedupe decision is made through a **named `IncidentDedupe` seam** (defined below), keyed on a **stable incident key** — `idle-zombie-veto:<topicId>:<reasonKey>` — with a TTL (default 24h). **State is per-incident (seam-deduped), NOT per-process.** When the seam permits emission, the item posts to the alerts topic — **never spawns a new topic**, never one-per-tick. After escalation the session stays in slow-cooldown so the breaker is a one-shot signal, not a new flood.

**The dedupe contract is BEST-EFFORT, not exactly-once (precise claim).** The seam's initial backing is the topic-flood guard's **in-process coalescing + TTL** (below). Its guarantee is bounded: within a single process's flood-guard window, repeat emissions of the same incident key coalesce. It does **NOT** provide a durable, cross-machine, exactly-once dedupe. Concretely:
- Across a **server restart**, the flood-guard's in-process window may have reset, so a duplicate attention item for the same incident is **possible and ACCEPTABLE**.
- On a **second machine**, each machine's flood guard is independent, so the same incident class may raise one item per machine — again **possible and ACCEPTABLE**.

This is by design: the breaker's purpose is to **avoid a flood** (hundreds of items), not to guarantee exactly one item forever. At-most-a-handful across restarts/machines is a success; a flood is the failure it prevents. The spec does NOT claim the topic-flood guard dedupes durably across machines, and no test asserts exactly-once across a restart or a second machine — the tests assert only "no flood within a window" (Tier-1 case 7 asserts one item per episode within a single process, the flood-guard's actual scope).

**The `IncidentDedupe` seam (R4-3 — defined + built in THIS PR).** The breaker depends on a small, explicitly-named interface — NOT a raw reach into `TelegramAdapter`. This decouples session-lifecycle safety from the alert transport: the breaker asks "may I emit this incident?" and the seam owns the durable dedupe decision.

```ts
/** BEST-EFFORT "one per incident" gate (NOT exactly-once).
 *  The breaker depends on THIS seam, never on the alerting transport directly. */
export interface IncidentDedupe {
  /** Returns true at most once per (incidentKey) within the backing's coalescing
   *  window (bounded by ttlMs). Backed initially by the topic-flood guard's
   *  in-process coalescing + TTL: within one process's window, a repeat of the
   *  same key returns false (already emitted). It is BEST-EFFORT — across a
   *  server restart or on a second machine a duplicate emission is possible and
   *  acceptable (the goal is flood-avoidance, not durable exactly-once).
   *  Returning true RECORDS the emission. */
  shouldEmit(incidentKey: string, ttlMs: number): boolean;
}
```

**Initial backing (pragmatic reuse, R3-3):** the shipped implementation is a thin adapter over the **EXISTING topic-flood guard** (`TelegramAdapter`'s per-source circuit breaker), which coalesces by source key via an **in-process window + TTL** — the flood guard is the seam's coalescing substrate. The breaker owns no dedupe state of its own; it calls `incidentDedupe.shouldEmit('idle-zombie-veto:<topicId>:<reasonKey>', 24h)` and only posts when it returns true. The contract this backing provides is **best-effort flood-avoidance within a process window, NOT durable cross-machine exactly-once** (see the C4 precise contract above): a restart or a second machine may each emit one item for the same incident, which is acceptable. Because the dependency is the named seam rather than the concrete adapter, a future subsystem needing a genuinely durable cross-machine "one per incident" contract can be given a different (durable) backing without touching the breaker — but that stronger backing is out of scope for this PR.

### Why branch-local, not a centralized kill-attempt scheduler / log rate-limiter (C5)

The fix is a per-branch backoff ledger, not a central "kill-attempt scheduler" or a global reap-log rate-limiter. Rationale:
- **Minimal blast radius.** The change touches only the one branch that regressed (idle-zombie), threaded through one already-proven primitive. It cannot alter the cadence or authority of any other kill class (age-gate, load-shed, lease, operator-driven) — see § Threat model note.
- **Reuses a proven P19 primitive.** `AgeKillBackoff` (#863) is already the shipped, tested, memory-bounded veto-backoff for the sibling branch. Generalizing it to `VetoedKillBackoff` extends known-good code rather than introducing a new coordination surface.
- **A central scheduler is a larger separate refactor.** A single kill-attempt scheduler (or a global log rate-limiter) would centralize retry policy across every kill class, changing the behavior of branches that are working correctly today and expanding the surface under test far beyond this bug. That is a strictly larger, riskier change for no additional coverage of the actual root cause — rejected, not adopted.

### Fix B (defense-in-depth, symptom-containment, P14) — bounded reap-log rotation, NOT a new persisted dedupe file

**Resolution (C3 / L2): the containment is bounded reap-log ROTATION — Fix B does NOT introduce a new persisted per-(session,reason) dedupe file.** The round-1 design keyed a dedupe on its own persisted last-write timestamp per (session, reason); codex C3 and lesson L2 both flag that this is itself a SECOND unbounded, audit-adjacent persisted file (the exact hazard Fix B was meant to contain). The simpler, strictly-bounded containment is to cap the reap-log itself: even if a regression of Fix A re-inflated the write rate, a rotating log with a fixed size ceiling cannot grow past `maxSizeBytes × K generations`. This folds Fix B into the **reap-log rotation sibling scope** (§ Reap-log rotation) — Fix A stops the re-fire at the root; bounded rotation caps the blast radius of any regression without a new persisted store.

**If any in-memory dedupe map is kept** (an optional micro-optimization to skip near-identical consecutive skip writes), it MUST be bounded: keyed on `(topicId, reason)` with an explicit `maxEntries` cap (oldest-evicted) AND a TTL, held in memory only, never persisted. It is a convenience, not the containment — the rotation is the containment. Fix B is containment only; Fix A is the root fix.

### Fix C (RC#2) — DEFERRED; same veto-backoff for post-transfer closeout, keyed on (topic, targetMachine) <!-- tracked: CMT-780 -->

**The deferral is decision-completeness-blessed, not a gap.** <!-- tracked: CMT-780 --> The convergence panel's decision-completeness angle explicitly blessed shipping Fix A + A′ without Fix C: the north-star metric of THIS spec is **idle-zombie skip-rate reduction** (RC#1, ~99% of the volume), and the user-visible cross-machine placement churn is **Fix C's separate scope** (RC#2, ~1% of the volume, a genuine ownership-disagreement bounce distinct from the hot-spin). Fix C is a scheduled follow-up with a defined shape below — deferring it does not leave RC#1 partially resolved.

Ships AFTER Fix A + B are verified (§ Rollout). Definition (finding 4), so the deferral <!-- tracked: CMT-780 --> is a schedule, not a gap:
- **Reuse the `VetoedKillBackoff` primitive**, keyed on `(topicId, targetMachineId)` rather than `sessionId`.
- **Gate the backoff on the closeout being VETOED** (`disposition: skipped:recent-user-message`) — NOT on a succeeded-then-recurred closeout (a real re-move is legitimate work, not a spin).
- **Escalate on COOLDOWN COUNT** (N episodes), not wall-clock, so a genuinely bouncing topic escalates in 2–3 episodes rather than after a long timer.
- **On escalate:** read authoritative placement `GET /pool/placement?topic=N`. If the other machine genuinely owns the topic, **force the closeout via the confirmed-move bypass** (`bypassRecentUserMessageForConfirmedMove`) rather than backing off forever — the correct resolution is to shed the leftover, not to keep it. If placement is ambiguous/unreachable, raise ONE attention item ("Mini and Laptop disagree on topic N ownership") through the **topic-flood guard** (no new topic).
- **Real-pair cross-machine test REQUIRED** — a synthetic symmetric two-machine test gives false confidence (per the multi-machine live-verify lesson); Fix C is not "done" until driven on the real Mini↔Laptop pair.

### Fix D (latent, separate spec) — SessionReaper memory metric

Out of scope here (reaper-audit is `tier:normal`), but track: switch SessionReaper's memory input from `os.freemem()` to the corrected `vm_stat` metric HealthChecker already uses. File as its own spec.

## Multi-machine posture

`machine-local-justification: hardware-bound-resource`

The `VetoedKillBackoff` cooldown state is **machine-local BY DESIGN — never replicated, no state-sync store.** Each machine's `SessionManager` monitors ONLY its own live tmux/session set; the veto-backoff is a property of THIS machine's monitor loop against THIS machine's sessions (the resource it guards — the local tmux session inventory — is hardware-bound). Replicating the cooldown across machines would be actively WRONG: machine A's back-off window says nothing about machine B's identical-id-namespace-free session set, and a peer could suppress a legitimate local evaluation. Each machine backs off its own vetoed kills independently. This is a strict no-op on a single-machine agent. (Fix C's `(topic, targetMachine)` state is likewise machine-local, held by the machine attempting the closeout.)

## Config & rollback

**Knob:** `monitoring.idleKillVetoBackoff` (drives the idle-zombie `VetoedKillBackoff` instance):
```jsonc
{
  "monitoring": {
    "idleKillVetoBackoff": {
      "enabled": false,            // fleet default OFF — a bad ship is inert on the fleet
      "cooldownMs": 1800000,       // 30m → ≤48 idle-zombie evaluations/day/stuck session
      "escalateAfterEpisodes": 6   // P19 breaker: ONE attention item after 6 cooldowns
    }
  }
}
```

**migrateConfig() default (Migration Parity):** add `monitoring.idleKillVetoBackoff` with an **existence check** — only write the block if absent, so an operator override is never clobbered. Deployed agents get the knob on update, new agents get it via `init`. **No state-schema migration** is needed: the cooldown lives in in-memory maps only (nothing persisted to disk to unwind).

**Dev-agent gate + fleet-off:** the rollout is gated on the development-agent flag — the resolved `enabled` is `true` on a development agent (Echo) and `false` on the fleet UNLESS an operator explicitly sets `monitoring.idleKillVetoBackoff.enabled: true`. This lets Fix A soak on Echo first while shipping inert everywhere else.

**Rollback:** set `monitoring.idleKillVetoBackoff.enabled: false` → per the C1 disabled contract, the idle-zombie `VetoedKillBackoff` instance is **not constructed and not consulted** (the field stays `undefined`; the kill branch's `if (this.idleKillBackoff)` guard falls through to prior per-tick behavior). No `shouldRequest` gate, no `recordVeto`, no episode/breaker side-effects, no once-per-episode log-gating → **exact prior per-tick behavior** restored. There is no persisted data to unwind. (The age-gate's own `ageKillBackoffMinutes` knob is untouched by this spec — the two instances roll back independently.)

**`cooldownMs: 0` is "enabled-but-no-cooldown", NOT a disable path (R4-5 — ONE exact definition).** There is exactly ONE disable path: **`enabled: false`** (the ledger is never constructed — the C1 disabled contract). `cooldownMs: 0` is a DIFFERENT, orthogonal setting: with `enabled: true` and `cooldownMs: 0`, the `idleKillBackoff` ledger IS constructed and IS consulted every tick, but the backoff window is zero — so `shouldRequest` re-permits an evaluation on EVERY tick (no cooldown gate). Crucially, the OTHER ledger machinery still exists and runs: the reason-key-aware stale-reprieve, `recordVeto`/`recordKilled` bookkeeping, the once-per-episode **log gating**, and the **P19 breaker** (`escalateAfterEpisodes` still counts episodes and still fires its one incident). So `cooldownMs: 0` yields "evaluate every tick, but still log-once-per-episode and still escalate after N episodes" — it is NOT a second way to fall back to the raw prior per-tick behavior, and it is NOT a disable. The ONLY way to get the exact prior per-tick behavior with zero ledger side-effects is `enabled: false`. (This removes any ambiguity that `0` might be a covert disable.)

**NaN safety (finding 11):** `cooldownMs` is coerced through the inherited `coerceNonNegInt` (a negative/NaN falls back to the 30m default). `0` is a LEGITIMATE coerced value meaning "no cooldown window" per R4-5 above — it passes coercion unchanged and does NOT disable the ledger. `effectiveBoundIdleKillMinutes` is a REAL getter (SessionManager line 678–680, `config.idlePromptKillMinutesBoundToTopic ?? FALLBACK…240`) — VERIFIED present, so any `Math.max(cooldownMs, …)` reference resolves to a real number, never `undefined → NaN`.

## Threat model note

The cooldown gates **ONLY the idle-zombie kill branch.** Every other kill class is UNTOUCHED and continues at its existing cadence/authority:
- `age-limit` kills — governed by the SEPARATE age-gate `AgeKillBackoff` instance (its own knob).
- SessionReaper load-shed / pressure-tier reaps.
- Lease-based and protected-session reaps.
- `/sessions/reaper/evaluate` operator-driven reaps.

No kill class is suppressed. The ONLY behavior change is HOW OFTEN a *already-vetoed* idle-zombie kill is re-attempted — a session that would be killed today (no keep-reason) is still killed on the first attempt with no cooldown recorded. The fail-direction (P20) on every uncertainty is toward MORE evaluation, never toward silencing a legitimate kill.

## Reap-log rotation (sibling scope)

**Scoped explicitly, DEFERRED to a tracked sibling spec.** <!-- tracked: CMT-782 --> `src/monitoring/ReapLog.ts` has **NO size cap or rotation** (verified: no `maxSizeBytes`/rotate/truncate logic present) — so the existing **132MB** file PERSISTS even after Fix A stops its growth, and an unbounded append-only audit log is a fleet-wide latent hazard regardless of this bug. **This rotation IS Fix B's containment (C3/L2):** a fixed size ceiling (`maxSizeBytes × K generations`) bounds the blast radius of any Fix A regression WITHOUT a new persisted dedupe store. Two items:
1. **Sibling spec:** add a bounded-size / rotation cap to `ReapLog` (roll at N MB, keep K generations). Tracked separately — do NOT bundle into this spec's single-run scope. This is the single containment layer for Fix B; no separate persisted per-(session,reason) file is created.
2. **Deploy-runbook step (this spec):** after Fix A is verified on Mini, ARCHIVE the existing 132MB `logs/reap-log.jsonl` (rename → `.jsonl.pre-thrash-fix`, gzip) so the reclaimed space is realized immediately; the fix stops growth but does not shrink the historical file.

## Test plan

**Tier 1 — Unit** (`tests/unit/session-manager-idle-veto-backoff.test.ts` + `tests/unit/vetoed-kill-backoff.test.ts`):
1. Vetoed kill sets cooldown and does NOT re-fire on the next tick (`terminateSession` called once across two ticks).
2. Cleared kill still kills (`blockedReason`→null ⇒ `terminated:true`, no cooldown) — authority unchanged.
3. Cooldown expiry ⇒ one fresh attempt.
4. Active-output branch calls `idleKillBackoff.reset` (clears cooldown + episode count).
5. Exactly one WARN per veto episode across N ticks (log-once folded into the ledger value).
6. **Stale-reprieve (reason-KEY):** a changed reason KEY on the next tick invalidates the cooldown and allows one fresh evaluation; a change in only the free-form `blockedReason` TEXT (same key) does NOT re-fire the reprieve (R3-2 — the ledger compares the stable key, not human text).
6b. **Exhaustive reason-key normalization + fail-open (R4-4):** `normalizeReasonKey` is asserted over ALL current `ReapGuard` result variants — each known keep-reason (`open-commitment`, `recent-user-message`, …every variant the guard can currently return) maps to its OWN distinct key, and NO two materially-different keep reasons collapse onto the same key. A synthetic UNKNOWN/unrecognized variant yields a fresh, DISTINCT key (never the shared `'guard'`/`'unknown'` bucket) — proving fail-open toward MORE evaluation and no silent coalescing of an unrecognized reason onto a known one.
7. **P19 breaker (best-effort dedupe):** after `escalateAfterEpisodes` cooldowns with the reason unchanged, exactly ONE attention item is emitted **within a single process/flood-guard window**, routed via the alerts topic / flood guard — never a spawned topic (finding 6). The test asserts "no flood within the window" (one item per episode in-process); it does NOT assert exactly-once across a restart or a second machine — that is explicitly best-effort per the C4 contract.
8. **Map-leak:** after a stuck session is reaped (real kill) AND after `cleanupStaleSessions` removes it, `idleKillBackoff.trackedCount` returns to **0** (finding 1). `maxTracked` oldest-eviction holds the ceiling under a synthetic id churn.
9. **Value-shape seam (L1):** after the ledger value changes from a bare `number` to `{ until, reasonKey, logged, episodeCount }`, `remainingMs(id, now)` still returns the correct positive remaining window (reads `.until`, never the whole object) — asserted for both a mid-cooldown entry and an expired one (returns 0). Two-arg age-gate callsites (`shouldRequest(id, now)` / `remainingMs(id, now)`) still compile and behave as before (`reasonKey` defaults to `null`, no stale-reprieve). This is IN ADDITION to the `trackedCount === 0` ratchet.
10. **Disabled contract (C1):** with `enabled:false`, the `idleKillBackoff` field is `undefined` (never constructed); across N ticks on a permanently-vetoed session, `terminateSession` is attempted EVERY tick (prior behavior), the reap-log gains one `idle-zombie` skip record per tick, NO WARN-once gating applies, and NO breaker attention item is ever emitted — proving zero ledger side-effects when disabled.
11. **Single guard evaluation (C2):** the `precomputedReapGuardResult` passed into `terminateSession` is the one used for the kill decision — `reapGuard.blockedReason` is called exactly ONCE per cooldown-expiry tick (spy asserts call count), and the reason key recorded by `recordVeto` equals the key the kill decision saw.
12. **Guard-eval authority boundary (R3-1 / R4-2):** the public `terminateSession()` signature exposes NO `precomputedReapGuardResult` option — a type-level / API-shape assertion that the precompute is confined to the private `SessionManager` path. A NON-idle-zombie kill (any other reason) is asserted to re-evaluate the guard itself (spy shows the internal `reapGuard.blockedReason` IS called), proving no external caller can inject an authoritative reason for another kill class.
13. **cooldownMs:0 is enabled-but-no-cooldown (R4-5):** with `enabled:true, cooldownMs:0`, the ledger IS constructed; across N ticks on a permanently-vetoed session `shouldRequest` re-permits every tick (evaluation each tick) YET the WARN is logged once per episode AND the breaker still fires exactly ONE attention item after `escalateAfterEpisodes` — proving `0` is NOT a disable path and the log-once/breaker state still exist.
14. **migrateConfig() default without clobber (R4-6):** `migrateConfig()` on a config MISSING `monitoring.idleKillVetoBackoff` writes the default block; run on a config that ALREADY carries an operator override (e.g. `{enabled:true, cooldownMs:600000}`) leaves the override BYTE-FOR-BYTE untouched (existence-checked, idempotent — a second run is a no-op). Both directions asserted.

**Tier 2 — Integration:** real topic-bound session + synthetic open commitment past a reduced `idlePromptKillMinutesBoundToTopic`; over ~30s the reap-log gains ≤1 `idle-zombie` skip (not ~6); session stays alive; the attention item does NOT fire before `escalateAfterEpisodes`.

**Tier 3 — E2E lifecycle:** production init path (mirrors `server.ts`); protected idle session survives; `Killing zombie` WARN per session per hour drops from ~720 to ≤2; `GET`-visible attention surface receives exactly one breaker item after the configured episode count.

**Regression ratchet (CI):** over a fixed monitored **no-restart** window with a permanently-vetoed session, reap-log `idle-zombie` skip count MUST be ≤ (windowMs/cooldownMs)+1. The test READS the config default (`monitoring.idleKillVetoBackoff.cooldownMs`), NOT a magic number, and ALSO asserts `idleKillBackoff.trackedCount === 0` after the vetoed session is reaped. Fails any change reintroducing per-tick re-fire OR the map leak. (Structure > Willpower.)

## How to VERIFY the swap-count drops on a single machine

Baseline on Mini before deploy, re-run after:
```bash
# zombie-kill WARN rate per hour (baseline: hundreds/hr/session)
grep "Killing zombie" logs/server.log | grep -oE '^[0-9-]+T[0-9]+' | sort | uniq -c
# reap-log idle-zombie skip count + file size
grep -c '"idle-zombie"' logs/reap-log.jsonl ; wc -c logs/reap-log.jsonl
```
Success criteria after deploy:
- `Killing zombie` WARN: hundreds/hr → **≤2/hr per stuck session** (one per cooldown).
- reap-log `idle-zombie` skips: ~3,200/day → **≤48/day** at a 30m cooldown.
- reap-log **file growth rate** drops >95% (compare `wc -c` over an hour).
- Actual kills (`type:reaped`) **UNCHANGED** — confirm legitimate `age-limit` reaps still occur. (This proves the fix touched retry cadence, not kill authority.)

**North-star metric:** skipped idle-zombie reap-log records per stuck session per day drops from ~3,200 to ≤48, with zero change to real kill counts.

## Rollout

### What ships in THIS PR (unambiguous, R4-1)

**This spec/PR implements Fix A + Fix A′ ONLY** — the generalized `VetoedKillBackoff` veto-backoff ledger (Fix A, RC#1) plus the P19 breaker (Fix A′). That is the entire code deliverable of this PR:
- the `AgeKillBackoff` → `VetoedKillBackoff` generalization (rename + alias + the `{ until, reasonKey, logged, episodeCount }` value shape + reason-key-aware `shouldRequest`);
- the second `idleKillBackoff` instance wired into the idle-zombie branch (the guard-once precompute, map-leak eviction, disabled contract);
- the `IncidentDedupe` seam + the breaker's one-per-incident escalation;
- the `monitoring.idleKillVetoBackoff` config knob + its `migrateConfig()` existence-checked default;
- Tier 1/2/3 tests + the CI regression ratchet.

Ship it live on developer agents (Echo) first, dark on the fleet via the dev-agent gate (`monitoring.idleKillVetoBackoff.enabled` fleet-default false); soak 24h; re-run § How to VERIFY.

### Activation — code shipped ≠ operator symptom resolved (honest scope)

**This PR fixes the LOOP; enabling it on the Mini RESOLVES the operator's symptom.** These are two distinct milestones and the spec must not conflate them:

1. **Code shipped (this PR merges):** the `VetoedKillBackoff` generalization + breaker land in `main` and deploy **enabled on the development agent (Echo)** and **fleet-off** (`monitoring.idleKillVetoBackoff.enabled` resolves `false` everywhere except a dev agent, via the dev-agent gate). At this point the Mini — where the actual 132MB thrash lives — is STILL running the old per-tick behavior: the code exists on the box but the gate is off, so nothing changes for the operator yet.
2. **Problem resolved (a later, deliberate operator action):** the Mini's thrash is resolved ONLY when an operator flips `monitoring.idleKillVetoBackoff.enabled: true` on the Mini, AFTER the Echo soak has demonstrated the fix is healthy.

**Activation criterion (the gate between milestone 1 and 2):** the Echo 24h soak (§ How to VERIFY, run on Echo) shows (a) `Killing zombie` WARN dropped to ≤2/hr per stuck session, (b) reap-log `idle-zombie` skips ≤48/day, (c) `idleKillBackoff.trackedCount` returns to 0 after reaps, and (d) actual `age-limit` kills UNCHANGED. Only once all four hold is the Mini activation warranted.

**Activation runbook step (Mini):** after the Echo soak passes the criterion above:
- Set `monitoring.idleKillVetoBackoff.enabled: true` in the Mini's `.instar/config.json` (full block, existence-checked — do not clobber sibling knobs).
- Boot-instantiated component → restart the Mini's server (SIGTERM the server pid; supervisor respawns) so the `idleKillBackoff` instance is constructed.
- Re-run the § How to VERIFY baseline/after commands ON THE MINI; confirm the WARN rate and skip count drop against the Mini's own baseline (not Echo's).
- Then perform the § Reap-log rotation item-2 archive of the existing 132MB `logs/reap-log.jsonl` on the Mini to realize the reclaimed space.

**Honest scope statement:** merging this PR does NOT resolve the Mini's thrash on its own — it ships the correct code inert on the fleet. The operator's symptom is resolved by the deliberate Mini activation above. Claiming "shipped" is not the same as claiming "the Mini is fixed"; the spec's completion is the code + Echo soak, and the Mini activation is the tracked operator hand-off that closes the loop.

### What is EXPLICITLY NOT in this PR

- **Fix B (reap-log rotation)** <!-- tracked: CMT-782 --> — the bounded-size/rotation cap on `ReapLog` is a **SEPARATE tracked sibling spec** (§ Reap-log rotation, item 1). It does **NOT** ship in this PR. Fix A stops the re-fire at the root; the rotation cap is a defense-in-depth containment layer built independently.
- **Deploy-runbook archive step** <!-- tracked: CMT-782 --> — after Fix A is verified on Mini, a **runbook step** (not code, not this PR) archives the existing 132MB `logs/reap-log.jsonl` to reclaim the space (§ Reap-log rotation, item 2). This is an operational action performed at deploy time, not a shipped artifact.
- **Fix C (RC#2 post-transfer closeout backoff)** <!-- tracked: CMT-780 --> — ships AFTER Fix A is verified, shares the `VetoedKillBackoff` primitive, and requires the real Mini↔Laptop pair test.
- **Fix D (SessionReaper `os.freemem` → `vm_stat`)** <!-- tracked: CMT-781 --> — its own separate tracked spec.

**One-line summary:** THIS PR = Fix A (veto-backoff ledger) + Fix A′ (breaker). Everything else — reap-log rotation, the 132MB archive step, Fix C, Fix D — is out-of-PR and tracked separately.

## Open questions

*(none)*
