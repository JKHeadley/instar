# Convergence Report — Stop-gate shadow recording runs on its own budget

## Cross-model review: codex-cli:gpt-6-astra

Ran in both rounds (round 1: SERIOUS ISSUES, one design finding; round 2: MINOR ISSUES, no design findings). Gemini was not authed on this machine (`gemini-not-authed`); the `claude-code` clean-door family was not run.

## ELI10 Overview

When an agent stops, a judge model is asked whether the stop was fair. A trial run of one of its checks (does the agent hand its own work back to the operator?) has written down nothing since 20 August, because the judge on Echo answers in about five seconds but was only ever given two. Every answer arrived too late, so the gate paused itself and stayed paused.

The trial run never acts on the answer, so the fix stops making the session wait: in trial mode the server says "fine, stop" at once, gives the judge up to 30 seconds in the background, and records the answer when it comes. At most four background judgments run at once. This applies only on development agents (where the trial runs), so the wider fleet's cost and notices do not change.

## Original vs Converged

- Originally the background cap counted judgments, so a timed-out call that kept running freed its slot early. After review the slot is held until the underlying model call really ends (Codex, round 1).
- Originally the change would have switched the stop gate back on for every agent in the fleet, re-arming a model call per stop and Telegram notices everywhere. After review it is scoped to development agents; the fleet decision goes to the feedback queue (internal, round 1).
- Originally the spec said any recorded row meant a judgment happened. Failure rows and "force allow" rows do not; the predicate is now exact (internal, round 1).
- Originally two background "continue" verdicts would have muted a long-running session for good via the continue-ceiling. In background trial mode the ceiling now neither counts nor mutes (internal, round 1).
- The route's async handler is now caught, so a late error after the early reply cannot crash the server under Express 4 (internal, round 1 precision, fixed in passing).

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | codex, internal (scalability, integration, evidentiary, lessons) | 4 | 5 | cap release on provider settle; dev-gate scope; P20 predicate; continue-ceiling; route catch |
| 2 | (converged) | 0 | 6 | one-line wording fixes |

Standards-Conformance Gate: ran (1 flag) — round 1: "No Silent Degradation to Brittle Fallback" possible-violation about enforce mode failing open on timeout. Enforce behaviour is unchanged by this spec and enforce is on nowhere; recorded under Known limits and the feedback queue. Round 2: body changed only in scope/wording; the same flag applies.

Per-round model: internal reviewer ran on the session model (Opus 5.5) both rounds.

## Proportion

Tier 1; 2 source files, ~110 lines; 2 of 3 allowed rounds. Proportionate.

## Left behind

- Codex r1: P20 wording on what a row means (fixed anyway, it was design-relevant per the internal reviewer).
- Codex r1/r2: breaker recovery stated as verified-after-deploy, not assumed (wording applied).
- Codex r2: the 7-day sample proves the observed window, not every failure since August (accepted; the post-deploy check verifies the fix).
- Internal r1: a hung provider call keeps its slot until restart (Known limits).
- Internal r1: shadow calls may hold up to half the host spawn cap briefly (Known limits).
- Internal r1: skipped-at-capacity stops are counted only in memory (Known limits).
- Internal r1: lease clamp widened to 60.5 s on hydration — harmless.
- Internal r2: report-in-catch could re-raise (fixed: wrapped).
- Internal r2: dev agent will receive notify-on-stop notices again (spec states it).
- Internal r2: `route-error` reply carries no `eventId` (harmless; hook reads only `decision`).
- Queued to feedback: fleet shadow gate equally starved by the 2 s budget; enforce mode cannot work on an off-Claude gate route.

## Full Findings Catalog

Round 1 — Codex (gpt-6-astra): DESIGN — cap must count outstanding provider work, not resolved evaluations → resolved with `onProviderSettled`. PRECISION ×2 (row meaning; recovery claim) → wording.
Round 1 — internal: DESIGN — fleet-wide re-enable not stated → scoped to dev gate; DESIGN — row-meaning claim wrong → predicate; DESIGN — continue-ceiling mutes shadow sessions → skipped in deferred shadow; PRECISION ×5 (unhandled rejection, hung slot, spawn-cap share, lease clamp, in-memory skip count) → fixed or Known limits.
Round 2 — Codex: no design; PRECISION ×3 (slot release wording, breaker-status claim, causal scope) → wording.
Round 2 — internal: converged; PRECISION ×3 (catch re-raise, dev notices, eventId) → fixed or stated.

## Convergence verdict

Converged at round 2. The final round found nothing that changes what gets built; items left behind are listed above. Tier 1: no operator approval required before build.
