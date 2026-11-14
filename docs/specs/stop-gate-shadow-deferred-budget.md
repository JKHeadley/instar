---
title: Stop-gate shadow recording runs on its own budget
slug: stop-gate-shadow-deferred-budget
tier: 1
commitment: CMT-1006
eli16-overview: docs/specs/stop-gate-shadow-deferred-budget.eli16.md
review-convergence: "2026-10-25T23:35:48.937Z"
review-iterations: 2
review-completed-at: "2026-10-25T23:35:48.937Z"
review-report: "docs/specs/reports/stop-gate-shadow-deferred-budget-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 3
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Stop-gate shadow recording runs on its own budget

## Problem (measured)

The Turn-End Self-Deferral Guard (`monitoring.selfDeferralGuard`, dev-gated) is in a
shadow soak: every Stop event is judged by the UnjustifiedStopGate authority and the
verdict, with its four self-deferral columns, is written to `stop-gate.db` `events`.
On Echo (Studio) the table has 0 rows. `authority_breaker_state` shows 7,408
consecutive failures and 15,738 suppressed calls, first opened 2026-08-20.

Cause, from `feature-metrics.db` (last 7 days, feature `UnjustifiedStopGate`): 1,253
calls, all on `codex-cli` / `gpt-6-luna`, min latency 2,005 ms, 0 calls under 2,000 ms,
p50 4,694 ms. The gate's client budget is `DEFAULT_CLIENT_TIMEOUT_MS = 2_000`
(`callWithTimeout` races the call against it). Every call loses the race, counts as a
provider failure, and keeps the durable breaker open. The provider call itself still
completes (the race does not cancel it), which is why metrics show the calls as
succeeding while the gate records nothing. A failure that (re)opens the breaker is
reported as `breakerOpen`, which the route deliberately does not record, so not even
failure rows land.

The 2 s budget exists because the Stop hook (`stop-gate-router.js`) holds the stop
open waiting for the answer (it aborts at 2,500 ms). In shadow mode the hook never
acts on the verdict: only `enforce` + `continue` blocks.

## Change

1. `UnjustifiedStopGate.evaluate(input, options?)` takes `options.timeoutMs`. The
   effective budget is `clamp(timeoutMs, clientTimeoutMs, MAX_CALL_TIMEOUT_MS=60s)`:
   it can only lengthen the default. The half-open probe lease uses the effective
   budget, and breaker-state hydration accepts leases up to the max budget, so a
   long probe is not double-admitted.
2. `/internal/stop-gate/evaluate`, when the mode is `shadow`, an authority is
   wired, AND the dev-gated self-deferral guard is on (`monitoring.selfDeferralGuard`
   via `resolveDevAgentGate`: live on a development agent, dark on the fleet),
   answers the hook at once (`decision: allow`, `shadow: 'deferred'`), then
   runs the authority with `timeoutMs: 30_000` and records the row (success,
   malformed, timeout — every path that recorded before) when it returns. Later
   response writes are no-ops.
3. Concurrency bound: at most 4 shadow PROVIDER calls outstanding (a slot is
   released only when the underlying provider call settles, via
   `onProviderSettled`, not when `evaluate` resolves at a timeout); a stop past the cap
   is answered `allow` with `shortCircuit: 'shadow-capacity'`, not judged, and
   counted. `GET /internal/stop-gate/log` reports `{ shadow: { inFlight,
   skippedAtCapacity } }`.
4. `enforce` mode is unchanged: it keeps the 2 s blocking budget.
5. In deferred shadow mode the continue-ceiling neither counts nor mutes: the
   ceiling guards against repeated ENFORCED reminders, and a shadow verdict is
   never enforced. Without this, two shadow `continue` verdicts would mark a
   long-lived session stuck and stop judging it (it would bias the soak toward
   short sessions).
6. The route handler's promise is caught: Express 4 does not catch a rejected
   async handler, and the deferred tail runs up to 30 s after the reply. A late
   throw becomes one DegradationReporter entry, not a process-level fatal.

### Fleet scope

The fleet's shadow gate is equally starved (`claude -p` ~5–6 s also exceeds 2 s),
but re-enabling it fleet-wide means ~one LLM call per stop on every agent and
re-armed notify-on-stop notices. That is a fleet rollout decision, not part of
fixing the dev soak, so this change is scoped to the dev gate and the fleet keeps
today's behaviour. Filed to the feedback queue.

On a development agent the deferred path still calls notify-on-stop, so an
unattended session that gets a shadow `continue` sends its existing Telegram
notice 5–30 s after the stop (it sent none while every call timed out).

The live breaker needs no manual repair: after the next cooldown the half-open probe
runs on the 30 s budget, and when it returns a usable verdict `onProviderReachable`
resets it. The
existing `POST /internal/stop-gate/reset-breaker` admin route remains for a
manual reset.

## Acceptance

- A shadow call slower than the default budget is recorded with its self-deferral
  columns; the hook gets its answer immediately (integration test, real
  `createRoutes`).
- Enforce mode with the same slow call fails open as `timeout` (unchanged).
- A malformed shadow verdict records its failure row.
- The fifth concurrent shadow call is answered `shadow-capacity` and counted.
- After deploy on Echo, judged rows (the predicate above) appear in `events`
  and the breaker row shows `consecutive_failures = 0` (recovery requires one
  successful probe within the 30 s budget; verified, not assumed). The 30-day
  soak clock restarts from the first judged row.
- A fleet agent (guard dark) in shadow mode still times out as today.
- A session past the continue-ceiling is still judged in deferred shadow mode.

## Known limits

- Recording is best-effort across restarts: a deferred call in flight at shutdown
  records no row.
- A provider call that never ends keeps its slot until restart (the slot bounds
  running provider work). The Codex provider ends its own calls at 30 s.
- Up to 4 shadow calls can hold half the host spawn cap (8) for a few seconds;
  these spawns already ran before (the race never cancelled them).
- Stops skipped at capacity are counted in process memory only.

Enforce mode on an agent whose gate route is off-Claude (p50 ~4.7 s) will still fail
open on every stop: a blocking verdict cannot be waited for longer than the hook's
budget. That is a property of enforce, not of this change, and enforce is not on
anywhere. It goes to the feedback queue for the enforce graduation decision.

## Decision points touched

- `/internal/stop-gate/evaluate` deferred shadow branch — **invariant**: shadow mode never blocks (existing contract); answering `allow` before the verdict exists changes no outcome the hook can act on.
- Shadow capacity cap (4 outstanding provider calls) — **invariant**: a fixed resource bound (Bounded Blast Radius); its only effect is to not judge a stop that would not have been acted on. Counted on the log route.
- Per-call budget clamp — **invariant**: an arithmetic bound that can only lengthen the default.
- Continue-ceiling skip in deferred shadow — **invariant**: the ceiling guards enforced reminders; a shadow verdict is never enforced.

## Signal and state (P20)

- Symbol: a row in `events` with `mode='shadow' AND invalid_kind IS NULL AND
  decision IN ('continue','allow','escalate')`. State claimed: the authority
  produced a usable verdict for that stop. Failure rows (timeout, malformed,
  llmUnavailable, invalidEvidence) and `force_allow` rows are attempts, not
  judgments, and are not counted as such. Corroboration: the row's `latencyMs` and `promptHash` come from
  the authority result; `feature-metrics.db` records the same call independently.
  Unmeasurable: a skipped-at-capacity stop has no row and is counted in
  `skippedAtCapacity`, never shown as judged.
- Symbol: breaker `consecutive_failures = 0`. State: the last authority call
  produced a usable verdict (reset only in `onProviderReachable`).

## Multi-machine posture

This change adds no durable state surface. The only new state is two counters in
the server's process memory (in-flight shadow calls, skipped-at-capacity), which
describe that one process's own work and reset on restart; they are read on the
existing local `/internal/stop-gate/log` route. The stop-gate DB, its breaker row
and its events keep their existing posture (each machine's Stop hook posts to its
own server for its own sessions); this change does not alter it.

## Frontloaded Decisions

- Shadow budget 30 s (codex p95 observed 9,979 ms; 3x headroom, well under the
  60 s cap).
- In-flight cap 4 (one Stop per turn per session; ~350 judged stops/day on Echo).
- Enforce mode unchanged (graduating enforce is a separate decision).

## Open questions

*(none)*

## Maturation plan

- **test-agent-live:** the integration test mounts the real `createRoutes` with a real StopGateDb and a slower-than-budget provider; rows land with self-deferral columns.
- **dev-agent-live:** on Echo after the release installs: judged rows (predicate above) appear in `stop-gate.db` `events` and the breaker row reads `consecutive_failures = 0`, checked by reading the database.
- **fleet:** not part of this change; the deferred path follows the self-deferral guard's own dev gate, and widening shadow recording to the fleet is a separate decision filed to the feedback queue.
- **graduation criterion:** at least one judged shadow row on Echo within 24 hours of the release installing, and the soak's 30-day clock restarted from it. Zero judged rows is not a pass.
- **dark-window:** at most 30 days, the self-deferral soak's own window; if no judged row lands within 24 hours, the reason is recorded on CMT-1006 and it is re-opened, never left silent.

## Rollback

Revert the commit. No persisted state, config, or installed file changes.
