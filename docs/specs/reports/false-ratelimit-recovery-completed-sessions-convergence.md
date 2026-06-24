# Convergence Report — Fix false rate-limit/error recovery on finished sessions + user-channel proof harness

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's own codex CLI in both rounds
(`status: ok`, verdict MINOR ISSUES each). A Gemini-tier pass also ran successfully in
round 1 (`status: ok`, MINOR ISSUES); the round-2 Gemini pass degraded (timeout) but a
prior round succeeded, so the spec genuinely received cross-model review from BOTH
non-Claude families. Aggregate per `aggregateRoundOutcomes`: clean RAN.

## ELI10 Overview

The agent has a safety helper that "rescues" chat sessions that get temporarily blocked
by the AI provider (a "server busy, slow down" throttle). The bug: the helper decided a
session was throttled by reading the last few lines of its screen — but a session that
had already *finished* sits quietly with that old throttle message still on screen, so
the helper kept trying to rescue a session that was simply done. Because a finished
session never produces new output, the rescue never "worked", and it kept pinging the
user with "the throttle should have cleared — please continue". The helper code is
shared by every agent, so the same false alarm showed up fleet-wide.

This change makes a finished or killed session structurally incapable of being a rescue
target: the helper now checks "is this session actually still running?" at every point
it can act (when it first decides to rescue, before each retry, AND before the
"did it respond?" check), and bails out silently if a session ended. When a session
completes, the helpers are told to stop watching it immediately. A separate noisy
"rate limit!" log that fired on harmless meter hiccups is also quieted.

The bigger win is prevention: the agent already had a system that talks to itself
through real Telegram (as the user) and checks the replies — but it could only check
that the agent *said* the right thing, not that it *didn't* say something it shouldn't.
We taught it to assert the **absence** of an unwanted background message over a time
window. A deliberately-broken version now gets caught and blocked by the "is this done?"
gate. That's the catch-it-before-fleet-deploy guarantee, demonstrated working.

## Original vs Converged

- **Originally** the fix proposed a status guard at the detection site (F3) as one of
  four fixes. Review established the detection loop ALREADY iterates only running
  sessions, so that guard would be a no-op; the real residual (a *still-running* idle
  session with stale throttle scrollback) needs a detection redesign (adopt the
  watchdog's existing `evaluateThrottleSettle` settle-gate on the idle path). That was
  correctly re-scoped to a durably-tracked follow-up (CMT-1785), with the invariant
  reworded to "enforced at the recovery-ACTION boundary, not detection."
- **The decisive review catch:** the recoverability guard was applied at `report()` and
  `attemptResume()` but **not** at `verify()` — so a session finishing during the ~25s
  verify window could still reach the "still can't get through" escalation notice. Both
  a cross-model (codex) reviewer and the internal adversarial reviewer flagged it
  independently. Added the guard at `verify()` + a test reproducing the exact case.
- **Flap hardening:** `abort()` originally deleted the dedupe entry, letting a session
  flapping around the liveness oracle abort-then-rearm repeatedly; it now keeps the
  entry as a cooldown.
- **Prevention-window correctness:** the absence window default was widened 60s→90s so a
  regression surfacing at the first resume/verify (~55s envelope) lands inside it.
- **Topic-map deferral** gained an explicit future-consumer caveat + a delayed-GC
  follow-up (folded into CMT-1785).

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec/code changes |
|-----------|-----------------------|-------------------|-------------------|
| 1 | security/adversarial, decision-completeness/lessons, codex, gemini | 3 material (verify-gap, abort-debounce/transient-miss, F3-tracking) + minors | verify() guard, abort() keeps recentReports, absenceWindowMs 60→90, CMT-1785 opened, spec: F3 mechanism+harmless proof, topic-map caveat, test-authority, predicate precision |
| 2 | codex (2 addressed-repeats), internal convergence-check (CONVERGED) | 0 new material | parent-principle wording (recovery-action boundary) |
| — | Standards-Conformance Gate | 0 at-risk (both rounds) | none |

## Full Findings Catalog

**Round 1 — material:**
- *Adversarial F4 (codex echoed):* guard missing at `verify()` → finished-mid-verify escalation ping. **Resolved:** guard added at `verify()` → `abort()`; unit test added.
- *Adversarial F3:* `abort()` deleting `recentReports` + single transient-liveness read could cancel a real recovery / enable flap churn. **Resolved:** `abort()` keeps `recentReports`; documented `listRunningSessions` fails-open on tmux error so a hiccup can't drop a live session.
- *Decision-Completeness/Lessons + codex F3:* F3 deferral cited no tracking artifact; should name `evaluateThrottleSettle`. **Resolved:** CMT-1785 opened; D1 names the mechanism + proves harmlessness via the verified sole-consumer (`RateLimitSentinel.report()`) argument.

**Round 1 — minor (addressed via spec/notes):** absence-window envelope (→90s); topic-map stale-entry future-consumer caveat + delayed-GC; recoverable-predicate precision; test-authority clarification (deterministic unit tests are the correctness authority, harness is regression-prevention); QuotaCollector F4 degradation-sensitivity note; optional perf nicety (cache the running set — not taken, low call frequency).

**Round 2:** codex raised 2 addressed-repeats (F3 invariant wording, topic-map state model) — non-material per the convergence criteria (repeats of addressed concerns); the parent-principle was reworded to state enforcement is at the recovery-action boundary. Internal convergence-check verified all 5 round-1 findings RESOLVED against the actual code and found no new material finding.

## Convergence verdict

Converged at iteration 2. No material findings in the final round; the internal
convergence-check confirmed all round-1 findings resolved against the implementation and
a fresh 6-lens pass surfaced nothing new; the Standards-Conformance Gate reported 0
at-risk. Spec is ready for approval.
