# Convergence Report — Proactive Swap for Bound Default-Account Sessions

## Cross-model review: codex-cli:gpt-5.5 + gemini-cli:gemini-3.1-pro-preview

Both available non-Claude reviewer families read the final design. Their final
verdicts contained clarity-oriented minor notes and no material security,
integration, authority, or lifecycle finding.

## ELI10 Overview

The account monitor was watching the wrong set of conversations. It watched
sessions explicitly tagged to an account, but the main interactive conversation
usually starts on the default login and has no tag. At the same time, it tried
to move background sessions that had no Slack or Telegram route for a safe
restart. The result was the worst combination: the conversation that needed a
move was skipped, while impossible moves filled the failure ledger.

The converged design lets a bound default-login conversation use the same
proactive move as tagged sessions, filters impossible background moves before
execution, and chooses the eligible account with the lowest current usage. It
does not change the machine's default login. It pins only the restarted
conversation and preserves every existing anti-thrash and busy-work brake.

## Original vs Converged

The initial draft included the core candidate and target changes. Review added
four important closures: execute-time re-resolution of the effective default
source, an accurate `sourceWasUntagged` audit marker, Slack-only bootstrap plus
real Slack disk fallback, and explicit preservation of concrete refresh refusal
codes. Review also made transport precedence, mixed-version behavior,
multi-machine identity, target math, rollback, and negative tests explicit.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|---|---|---:|---|
| 1 | security, integration, decision-completeness | 10 | Added stale-source revalidation, accurate audit semantics, Slack-only/disk parity, source-admission boundaries, refusal propagation, supersession, and standards evidence. |
| 2 | integration | 1 | Assigned effective-source re-resolution to the scheduler's async anti-thrash hook and required the A→B/no-refresh test. |
| 3 | codex, gemini | 0 | No material change; minor clarity findings catalogued below. |

Standards-Conformance Gate: ran; the local route returned no report body, so
the round continued fail-open as required. Internal reviewers ran on the
authoring model; external reviewers ran on the models named above.

## Full Findings Catalog

- Stale default source could change between monitor decision and kill. Resolved
  by scheduler-owned async effective-source revalidation and `intent-stale`.
- Reusing `defaultAccountChanged` would make a false audit claim. Resolved with
  optional `sourceWasUntagged`; global default remains unchanged.
- Parent Q3/I10 contradicted the new behavior. Resolved by a narrow explicit
  supersession grounded in the actual per-session pinned respawn behavior.
- Slack-only servers constructed refresh but not the scheduler/monitor.
  Resolved by channel-neutral construction and optional Telegram attention.
- Real Slack adapter lacked the disk reverse lookup promised by refresh.
  Resolved with a non-mutating memory-first disk fallback and tests.
- Source admission and refusal propagation were underspecified. Resolved with
  enumerated source floors, structured error propagation, and boundary tests.
- Final external minor notes requested more precision on precedence, quota
  math, machine identity, and cache scope. The spec already pins the operative
  invariants; these notes do not require a design or implementation change.

## Convergence verdict

Converged at iteration 3. The final round found no material issue. Three
independent internal reviewer perspectives concurred after revisions, and both
available external model families completed a final read.
