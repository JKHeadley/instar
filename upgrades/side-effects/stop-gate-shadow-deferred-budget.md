# Side-Effects Review — stop-gate shadow recording runs on its own budget

**Version / slug:** `stop-gate-shadow-deferred-budget`
**Date:** `2026-10-25`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** independent reviewer subagent (the change touches a gate). See the appended review.
**Tier:** `1` — two source files, ~90 lines; a revert fully undoes it; no persisted state, config or installed-file change.
**Effort:** spec review rounds and commit attempts are listed in the Conclusion.

## Summary of the change

Commitment CMT-1006. The Turn-End Self-Deferral Guard shadow soak recorded nothing since 2026-08-20 on Echo: `stop-gate.db` `events` has 0 rows; `authority_breaker_state` shows 7,408 consecutive failures, 15,738 suppressed calls, first opened 2026-08-20.

Cause (`feature-metrics.db`, 7 days, feature `UnjustifiedStopGate`): 1,253 calls on `codex-cli`/`gpt-6-luna`, minimum latency 2,005 ms, zero under 2,000 ms, p50 4,694 ms. `callWithTimeout` races the call against `DEFAULT_CLIENT_TIMEOUT_MS = 2_000`, so every call lost the race and counted as a provider failure, holding the durable breaker open. The race does not cancel the call, so metrics show completed calls while the gate recorded nothing; a failure that (re)opens the breaker is reported `breakerOpen`, which the route deliberately does not record.

Fix:
- `UnjustifiedStopGate.evaluate(input, options?)`: `timeoutMs` widens the budget (clamped to `[clientTimeoutMs, 60s]`, so it can only lengthen); the half-open probe lease uses the effective budget; hydration accepts leases up to the max. `onProviderSettled` fires exactly once when the started provider work really finishes (or at once if none started).
- `/internal/stop-gate/evaluate`: in `shadow` mode with an authority AND the dev-gated self-deferral guard on (live on a development agent, dark on the fleet), answer the hook at once (`allow`, `shadow: 'deferred'`), then evaluate on a 30 s budget and record the row as before. At most 4 shadow provider calls outstanding (slot released on `onProviderSettled`, so a timed-out call still holds its slot); past the cap the stop is answered `shadow-capacity`, not judged, and counted on `GET /internal/stop-gate/log` (`shadow.inFlight`, `shadow.skippedAtCapacity`).
- In deferred shadow the continue-ceiling neither counts nor mutes (it guards enforced reminders; shadow verdicts are never enforced).
- The handler's promise is caught (Express 4 does not catch async handler rejections; the deferred tail runs up to 30 s after the reply): a late throw becomes one DegradationReporter entry and a fail-open `allow`, not a process-level fatal.
- `enforce` mode unchanged. Fleet agents (guard dark) unchanged.

## Decision-point inventory

- `/internal/stop-gate/evaluate` shadow branch — **modify**: responds before the verdict. Shadow never blocked, so the hook-visible outcome is identical (`allow`, empty reminder).
- Shadow capacity cap — **add**: a fixed resource bound; its only effect is to not judge a stop that would not have been acted on.
- Continue-ceiling — **modify** (deferred shadow only): skipped. It never blocked in shadow; it only stopped judging long sessions.

## 1. Over-block

None. Shadow mode answered `allow` on every path before; it still does. The cap does not block a stop; it skips a judgment.

## 2. Under-block

- Stops past the cap are not judged (counted). At ~350 judged stops/day and ~5 s per call, four concurrent is rarely reached.
- Recording is best-effort across server restarts: a deferred call in flight when the server restarts records no row (no durable queue). Acceptable for soak telemetry.
- Enforce mode on an off-Claude gate route still fails open on every stop (a blocking verdict cannot wait 5 s). Unchanged; enforce is on nowhere. Filed to the feedback queue for the enforce graduation decision.

## 3. Level-of-abstraction fit

Right layer: the route owns the mode and the hook response; the gate owns the provider call and its budget. The hook template is unchanged (it already ignores shadow verdicts), so no migration is needed.

## 4. Signal vs authority compliance

Compliant. Shadow is signal-only telemetry; the change makes it record. No new blocking authority. Ref `docs/signal-vs-authority.md`.

## 4b. Judgment-point check

No competing-signals decision point added. The cap and the budget clamp are resource bounds (invariant).

## 5. Interactions

- Breaker: a successful shadow probe resets the durable breaker via the existing `onProviderReachable`; no manual reset needed (the existing `POST /internal/stop-gate/reset-breaker` still works).
- Spend: development agents only. With the breaker closed, every shadow stop (up to the cap) gets a judgment instead of one probe per 5 minutes: roughly 180 → ~350 calls/day on Echo, off-Claude (codex), under the host spawn cap. Up to 4 such calls can hold half the host spawn cap (8) for a few seconds. The timed-out calls already ran to completion before, so per-call cost is unchanged.
- Fleet: unchanged. The fleet's shadow gate is equally starved by the 2 s budget; re-enabling it is a rollout decision, filed as feedback fb-0658b6d1-a4e. Enforce on an off-Claude route cannot meet the hook budget: feedback fb-3b862d80-d5b.
- StopNotifier still fires after the deferred row is recorded: on a development agent an unattended session with a shadow `continue` sends its existing notice 5–30 s after the stop (none were sent while every call timed out).
- `session_stuck_state` rows marked earlier stay; nothing on the evaluate route reads them.
- Continue counter (`CONTINUE_CEILING`): in deferred shadow (development agents) it neither counts nor increments; on fleet agents and in enforce it behaves as before.

## 6. External surfaces

Hook response in shadow mode gains `shadow: 'deferred'` or `shortCircuit: 'shadow-capacity'`; the hook reads only `decision`/`reminder` in enforce. `GET /internal/stop-gate/log` gains a `shadow` object (additive). Stops return faster in shadow mode (no 2.5 s hook wait).

## 7. Multi-machine posture

No durable state added. The two counters are per server process, describing that process's own work. The stop-gate DB keeps its existing per-machine posture (each machine's hook posts to its own server for its own sessions).

## 8. Rollback cost

Revert the commit and release. No data repair: rows written in the meantime remain valid shadow rows.

## Conclusion

Ships. Spec review: 2 of 3 Tier-1 rounds (Codex + internal reviewer; converged round 2, report at `docs/specs/reports/stop-gate-shadow-deferred-budget-convergence.md`). Proportionate for a gate change.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (the defect is a TypeScript budget in source).

## Evidence pointers

- `tests/unit/UnjustifiedStopGate-call-budget.test.ts` (8): budget widening, clamping, `onProviderSettled` after a timeout, once with breaker open, once on a synchronous throw.
- `tests/integration/stop-gate-shadow-deferred-budget.test.ts` (7, real `createRoutes`): shadow answers at once then records the slow verdict with self-deferral columns; enforce keeps the budget (`timeout`); malformed verdict records its failure row; fifth concurrent call is `shadow-capacity`, counted on `/log`; slots stay held while provider calls are still running; a fleet agent keeps the timeout; a session past the continue-ceiling is still judged.
- Existing stop-gate suites: 10 unit files (119), 5 integration files (20), 2 e2e files (5) green; `npm run lint` clean.
- Before the fix, 3 of the 4 original integration tests fail (verified by reverting `src/`).

## Second-pass review

**Reviewer:** independent reviewer subagent
**Independent read of the artifact: concern: §5 Interactions says "Continue counter (`CONTINUE_CEILING`) increments on shadow `continue` as before", which contradicts the diff and the Summary.**

- In the current diff, deferred shadow (guard on) neither reads nor increments the continue counter (`priorCount` forced to 0; increment guarded by `!deferShadow`). The line is only true for non-deferred shadow (fleet, guard dark). Reword it to say that.
- Everything else matches the diff: dev-gate scoping, the 30 s clamped budget, slot release on `onProviderSettled`, the cap and its `/log` counters, the outer `.catch` (report wrapped in try/catch; the two deliberate 400s return normally and are not masked), and the dev-agent notify-on-stop notice.
- No over-block: every shadow path still answers `allow`. Signal-vs-authority compliant. Rollback is a clean revert.
**Follow-up:** concern resolved by the §5 rewording — concur.
