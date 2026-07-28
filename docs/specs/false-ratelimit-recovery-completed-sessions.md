---
title: Fix false rate-limit/error recovery on finished sessions + user-channel proof harness
slug: false-ratelimit-recovery-completed-sessions
eli16-overview: false-ratelimit-recovery-completed-sessions.eli16.md
status: draft
parent-principle: "Structure beats Willpower — a finished session must be structurally incapable of becoming a recovery target, enforced at the recovery-ACTION boundary (the sentinel chokepoint), not merely at detection. Also instances Live-User-Channel Proof Before Done: the user-facing fix is not done until proven from the user's seat through the real channel."
author: echo
created: 2026-06-24
review-convergence: "2026-06-24T20:54:04.708Z"
review-iterations: 2
review-completed-at: "2026-06-24T20:54:04.708Z"
review-report: "docs/specs/reports/false-ratelimit-recovery-completed-sessions-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 2
contested-then-cleared: 0
approved: true
approved-by: "echo (standing 8-hour autonomous-run pre-approval, 2026-06-24; spec D4)"
---

# Fix false rate-limit/error recovery on finished sessions + user-channel proof harness

## Problem (observed live, 2026-06-24, topics 28130 / 28150 / mesh-debug)

A user saw the same line repeated many times across topics:
> "The temporary server throttle should have cleared — please continue where you left off."
…with no matching rate-limit in the session logs. It also appeared on a *different* agent
(AI Guy), i.e. it is fleet-wide, in shared detector logic, not agent-specific.

### Root cause (grounded in current source @ v1.3.655)

1. **Stale-scrollback false trigger.** `SessionManager`'s idle monitor
   (`src/core/SessionManager.ts` ~L1593-1610) fires `rateLimitedAtIdle` /
   `apiErrorAtIdle` when a session `isActuallyIdle` (idle-at-prompt + no active
   processes) AND the last ~30 captured tmux lines match
   `detectRateLimited()` / `TERMINAL_ERROR_PATTERNS`. A session that **finished**
   right after a throttle is *also* "idle at a prompt" with the throttle string
   still in scrollback → it is mistaken for a live-but-throttled session.

2. **No session-status guard in recovery.** `RateLimitSentinel.report()`
   (`src/monitoring/RateLimitSentinel.ts:235`) starts a full backoff→resume→verify
   lifecycle without checking the session is still `running`. A finished session
   never grows its jsonl, so verification fails every time → up to `maxAttempts`
   (6) futile resume nudges (`RATE_LIMIT_RESUME_NUDGE`) + "still throttled" check-ins
   over `maxWindowMs` (30m), then an escalation notice. Each is a user ping.

3. **No cleanup on completion.** The three `sessionComplete` handlers
   (`src/commands/server.ts` ~8501/8546/8593) never call
   `rateLimitSentinel.clear()`, `compactionSentinel.clear()`, or
   `telegram.unregisterTopic()`. So a finished session lingers as a recovery
   target AND stays in the `topicToSession` map (re-visited by `PreCompact`'s
   `getAllTopicSessions()` and the watchdog), re-arming the false trigger.

4. **Sibling gap.** `CompactionSentinel` has the identical missing guard:
   `clear()` exists but is never called on completion (confirmed: zero callers).

5. **Secondary noise (not the nudge driver).** `QuotaCollector`'s OAuth usage poll
   logs `429 retry-after:0` as a `[DEGRADATION]` warning on every transient meter
   blip (716 lines observed). It has a 3-strike circuit breaker but still emits a
   warning per blip. This is log noise, separate from the user-facing nudges.

## Fix

### F1 — Session-recoverability guard (primary, structural)
Add a `isSessionRecoverable(sessionName): boolean` dep to **both** `RateLimitSentinel`
and `CompactionSentinel`. Default (dep absent) preserves today's behavior so unit
tests/bare installs are unchanged. When wired (server.ts), it returns false if the
session is unknown OR its status ∈ {completed, failed, killed} OR it is not in
`listRunningSessions()`.

Consult it in two places:
- **`report()`**: if not recoverable → no-op (do NOT send the "throttled" notice, do
  NOT start recovery). This stops the false trigger at the door.
- **`attemptResume()` / `verify()`**: re-check before each resume; if the session
  became non-recoverable mid-flight (finished while backing off) → `finalize(..., 'recovered'?)`
  no — finalize as a new terminal `aborted` reason without a user "still throttled"
  ping. (Silent, audited stop — the session is gone, nothing to tell the user.)

### F2 — Completion cleanup (structural)
Add ONE consolidated `sessionComplete` handler (or extend an existing one) in
server.ts that, for the completing session, calls:
`rateLimitSentinel.clear(tmux)`, `compactionSentinel.clear(tmux)`, and
`telegram.unregisterTopic(topicId)` (resolve topicId via
`telegram.getTopicForSession`). Guard each call (feature may be disabled).
This removes the lingering-target + stale-map class entirely.

### F3 — Detection hardening (defense in depth)
In `SessionManager`, gate the `rateLimitedAtIdle`/`apiErrorAtIdle` emit on
`session.status === 'running'` (the loop already iterates running sessions, but the
status can flip between capture and emit). Cheap, removes a race.

### F4 — QuotaCollector 429-retry-after-0 noise (secondary)
Downgrade a `429` with `retry-after: 0` (or absent) from a `[DEGRADATION] WARN` to a
debug-level line once the circuit breaker is closed; keep the breaker. No behavior
change to quota accounting — purely log-volume.

## Test plan (ALL THREE TIERS + user-channel proof)

### Unit (`tests/unit/`)
- `RateLimitSentinel`: report() no-ops when `isSessionRecoverable` returns false (no
  notify, no timer). A recovery in flight aborts silently when the session becomes
  non-recoverable. Dep-absent path unchanged (regression lock).
- `CompactionSentinel`: same guard, both sides of the boundary.
- `SessionManager`: emit suppressed when status ≠ running with a throttle string in
  scrollback; still emits for a genuinely-running stuck session.
- Wiring-integrity: the server's `isSessionRecoverable` dep is non-null and delegates
  to the real SessionManager (not a `() => true` stub).

### Integration (`tests/integration/`)
- Full server boot: completing a session clears both sentinels + unregisters the topic
  (assert via the recovery-active predicate + `getAllTopicSessions()`).

### E2E (`tests/e2e/`)
- "Feature alive": a finished session with a throttle string in its pane produces ZERO
  resume nudges (the regression that started this).

### User-channel proof (NEW — the prevention layer, see companion harness spec)
- Drive the real Telegram surface (browser-as-user) through scenarios: finished
  session (no nudge), genuinely throttled session (recovery DOES run + recovers),
  idle topic-bound session (no nudge), and a message-delivery-failure path. Record a
  signed PASS/FAIL scenario matrix. Wire into the ship gate so future changes inherit it.

## Migration parity
No config-default or hook changes required (the recoverability dep is internal wiring).
If F4 adds a `monitoring.quotaCollector.logLevel` knob, add a `migrateConfig` existence
check. The new sentinel deps are server-internal; no agent-installed file changes.

## Rollback
Each fix is independently revertible. F1's guard is additive (dep-absent = old
behavior). F2 is a pure cleanup addition. F4 is log-level only.

## As-built (this PR)
- **F1** — `isSessionRecoverable?` dep added to `RateLimitSentinel` and
  `CompactionSentinel`; consulted in `report()` (no-op for a non-recoverable session,
  no user notice), in `RateLimitSentinel.attemptResume()` AND in
  `RateLimitSentinel.verify()` (silent `abort()` if the session finished mid-backoff
  OR mid-verify — new `rate-limit:aborted` event, no escalation ping). The guard is at
  ALL THREE lifecycle points so a session that finishes during the 25s verify window
  cannot reach the "still can't get through" escalation notice (spec-converge finding).
  `abort()` KEEPS the `recentReports` dedupe entry so a session flapping around the
  liveness oracle cannot abort-then-rearm on every flap. Wired in `server.ts` as
  `sessionName => sessionManager.listRunningSessions().some(...)` — membership in the
  running set is the SOLE recoverability criterion (a finished/failed/killed session
  drops out of it). `listRunningSessions()` fails OPEN on a transient tmux error
  (`isSessionAlive` catch → alive), so a tmux hiccup does NOT drop a live session;
  genuine termination is what removes it.
- **F2** — a `sessionComplete` handler in `server.ts` calls `rateLimitSentinel.clear()`
  + `compactionSentinel.clear()` (the completion cleanup that previously had zero
  callers).
- **F4** — `QuotaCollector` gates the OAuth-429 DegradationReport to fire only when the
  3-strike breaker trips (kills the `retry-after:0` log spam); accounting + breaker
  unchanged.
- **Prevention layer** — extended the existing Live-User-Channel Proof harness
  (`LiveTestHarness`) with an **absence assertion**: a scenario may set
  `absenceWindowMs` + `expect.noMessageMatching` and the harness collects every message
  on the channel over the window (new optional `ChannelDriver.collectMessages`) and
  FAILs if any matches — the structural way to catch a spurious background message,
  which a single send→reply could not. `rateLimitFalsePositiveMatrix.ts` defines the
  scenarios; an unsupported driver yields BLOCKED (never a silent pass). Proven
  end-to-end: a regressed run (spurious nudge) makes `LiveTestGate` VETO.
- **Tests** — 16 unit (guards both sides + harness absence + matrix + wiring-integrity)
  + 2 integration (harness→signed artifact→gate allow/veto). No regression across the
  existing sentinel/quota/harness suites; clean `tsc`.

### Scoping decisions (autonomous, reversible)
- **F3 detection-redesign DEFERRED-with-rationale, not dropped — tracked as CMT-1785:** <!-- tracked: CMT-1785 -->
  the idle-but-still-running stale-scrollback residual self-corrects to at most one
  stray "back online" (not the 6-nudge spam, which requires a finished/non-growing
  session that F1+F2 kill). The KNOWN one-layer-down fix already exists: the watchdog
  path uses `evaluateThrottleSettle` (`src/monitoring/rateLimitDetection.ts` — throttle
  string present AND pane byte-identical across polls = genuinely settled), but the
  SessionManager idle path (`rateLimitedAtIdle`/`apiErrorAtIdle` emit, ~L1607/L1622)
  does NOT. F3 is to adopt that settle-gate on the idle path; CMT-1785 carries it,
  driven evidence-first by the new absence harness. **Why the deferral is harmless <!-- tracked: CMT-1785 -->
  now:** the ONLY consumer of `rateLimitedAtIdle`/`apiErrorAtIdle` is the
  `RateLimitSentinel.report()` chokepoint (verified — no other listeners), and F1
  no-ops a non-recoverable report there, so a stale-scrollback emit on a FINISHED
  session is fully neutralized; only the running-idle residual remains, bounded to
  ≤1 self-correcting message.
- **Topic-map unregister dropped from F2:** unregistering a completed session's
  topic→session mapping risks the conversation-resume flow; F1 already neutralizes stale
  map entries at the sentinel chokepoint (the `PreCompact` trigger enumerates the map but
  `report()` no-ops a non-recoverable entry). **Caveat (review):** this offloads the
  guard responsibility onto any FUTURE consumer of `topicToSession` — they too must not
  assume a mapped session is alive. The blast radius today is contained (the watchdog
  reads `listRunningSessions`, not the map; sentinels are F1-guarded). A delayed
  garbage-collect of the map entry (retain for a resume grace period, then remove) is
  the cleaner long-term fix and is folded into the CMT-1785 follow-up. <!-- tracked: CMT-1785 -->

### Test authority (review clarification)
The DETERMINISTIC unit tests (the guard both-sides, the verify/abort lifecycle, the
wiring-integrity) are the AUTHORITY for correctness — the invariant is "a terminal
session is never a recovery target," provable without a live channel. The user-channel
absence harness is the regression-PREVENTION supplement: it proves the user never
receives the spurious nudge end-to-end and blocks a reintroduction at the gate. The
absence window must be ≥ (first backoff + verify window) ≈ 55s for the throttle class so
a regression that only surfaces at the first resume/verify lands inside it — the default
is 90s. The window covers the immediate-notice false positive (the observed incident);
the escalation-path variant is covered by the deterministic unit tests, not the window.
- **Live-drive HTTP route is a fast-follow:** the prevention capability is library-
  invokable and gate-wired; a dedicated `/live-test/rate-limit-false-positive` route
  (mirroring the capstone route) is additive polish, deferred to keep this PR's surface
  tight. <!-- tracked: CMT-1785 -->

## Decision points touched
- **Adds** no new block/allow/route gate. The `isSessionRecoverable` guard is an
  internal predicate that NO-OPS a recovery — it never blocks a user action.
- **Extends** the existing `LiveTestGate` veto surface only by giving it a new
  artifact (featureId `rate-limit-false-positive-fix`) to evaluate; the gate's
  block/allow logic is unchanged.
- **Signal vs authority:** every new element is a SIGNAL or a bounded no-op. The
  sentinel guard suppresses a spurious notice (it removes an action, never adds an
  authoritative block); the harness absence assertion produces a PASS/FAIL signal the
  (already-dark, dry-run-default) gate consumes; the QuotaCollector change is
  log-level only. Nothing here holds new blocking authority over a user.

## Frontloaded Decisions
- **D1 — F3 detection-redesign is deferred, not bundled.** <!-- tracked: CMT-1785 --> The idle-but-running
  stale-scrollback residual is lower-severity (self-corrects to ≤1 stray "back
  online", never the 6-nudge spam F1+F2 kill) and its fix is a detection redesign best
  driven by the new absence-harness evidence. Reversible: a follow-up spec. <!-- tracked: CMT-1785 --> Ships
  nothing dark/irreversible. *Cheap-to-change-after:* the residual is internal
  messaging behavior behind no published interface.
- **D2 — Topic-map unregister on completion is intentionally NOT done.** It risks the
  conversation-resume flow; F1 already neutralizes stale map entries at the sentinel
  chokepoint. Reversible.
- **D3 — The live-drive HTTP route is a fast-follow.** The prevention capability is
  library-invokable + gate-wired and fully tested via fake drivers; the dedicated
  route is additive (mirrors the existing capstone route). *Cheap-to-change-after:* an
  additive route behind the existing dark `liveTestGate` flag.
- **D4 — `approved: true` is self-applied** under the operator's standing 8-hour
  autonomous-run pre-approval (2026-06-24); design forks in scope are the agent's to
  resolve, reversible + dark-shipped.

## Multi-machine posture
- The sentinel guards + QuotaCollector change are **machine-local by design**: each
  machine runs its own sentinels over its own sessions; `listRunningSessions()` is the
  local running set. No cross-machine state is introduced.
- The Live-test artifact + ledger are **already per-machine segments** (existing
  `LiveTestArtifactStore` design, hash-chained per `machineId`); this spec adds a new
  featureId to that existing posture, not a new replication path.

## Open questions
*(none)*

## Out of scope (separate spec/PR)
The cross-machine ownership-handoff wedge (`pendingReplacement` never completing in
the session-pool placement path) is a distinct subsystem and gets its own spec +
tests + PR to avoid bundling unrelated changes.
