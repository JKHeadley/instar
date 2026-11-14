# Convergence Report — Bounded turns for Studio merge checks and ordinary full suites

## Cross-model review: codex-cli:gpt-6-astra

GPT-6 Astra reviewed the evolving design through the installed Codex CLI. Its final pass found only measurement and wording clarifications. The Claude Fable clean-door adapter reported `no-supported-framework` for this spec pass; the earlier throughput recommendation from Fable was obtained separately. The live standards gate checked 93 articles and returned no findings on the final design.

## ELI10 Overview

Studio can run one full test suite at a time. Merge checks and other full suites currently share that slot. An ordinary test that has waited 15 minutes goes ahead of merge work, so several aged ordinary tests can repeatedly delay a merge check. The change gives the two kinds of test a turn when both have a real, eligible process waiting.

A merge process gets a twelve-second offer after an ordinary suite. If it stops making progress, the slot becomes available to an aged ordinary test on the next poll. The machine records the turn under its existing lock and checks a file-write proof before trusting that record. An invalid record uses today's scheduling rule. The full test suite remains the only merge-authorizing result.

## Original vs Converged

The initial draft had a separate turn receipt that could lag behind a successful admission. Review moved turn history into the atomic holders file and added a proof of that file's identity, so a crash or legacy rewrite cannot silently refresh stale history. The initial rule also treated a coordinator reservation as if a merge process were ready; the converged rule requires a child claim and live waiter, with one bounded offer per free-slot episode. It limits enforcement to a healthy one-slot host limiter and states the inherited fail-open and timeout limits explicitly.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
| --- | --- | ---: | ---: | --- |
| 1 | security/adversarial, scalability/integration, decisions/lessons | 5 | 2 | Atomic history, cap-one prerequisite, real merge waiter, maturation plan. |
| 2 | internal reviewers and Astra | 3 | 3 | Removed claim-only reservation; qualified alternation and timeout behavior. |
| 3 | Astra | 2 | 2 | Added bounded handoff and declared 64-ticket fairness scope. |
| 4 | Astra | 1 | 1 | Made handoff exhaustion persist for the free-slot episode. |
| 5 | Astra, internal reviewers, standards gate | 2 | 3 | Added file identity proof, prevented stale-history laundering, named agent-role rollout. |
| 6 | Astra | 1 | 1 | Narrowed the guarantee around invisible fail-open admissions and visible witnesses. |
| 7 | Astra, security/adversarial, standards gate | 0 | 2 | Wording only: offer versus episode outcome; ordinary-side stalls measured separately. |

## Proportion

Tier 2 scheduling change; seven review passes on a roughly 100-line spec, one beyond the usual six-round cap because the sixth pass found a fail-open authority gap. The extra pass closed that gap before source changes.

## Left behind

- A bypass that cannot write holders or a witness is invisible to later file-only readers. This is inherited from the parent limiter's fail-open availability policy; those periods are outside the fairness guarantee and must be reported as degraded when observed.
- A test process outside the shared OS-user home or shared-lock contract is outside this host-local semaphore's scope.
- A paused ordinary waiter can retain its renewable ticket until its 60-second lease expires. Measure this separately from the new merge-offer delay.
- The same-head failure sample is small and cannot establish a machine-specific flake rate. The throughput report will state that limit.

## Full Findings Catalog

| Finding | Class | Resolution |
| --- | --- | --- |
| Separate turn receipt can remain syntactically valid after a crash. | DESIGN, security | Turn metadata moved into holders envelope; proof sidecar validates each rewrite. |
| Dry-run and cap-above-one admissions violate single-slot assumptions. | DESIGN, security | Enforcement requires host-limiter enforcing and resolved cap one; other admissions invalidate turn history when recorded. |
| Coordinator claim can exist before a merge child acquires. | DESIGN, scalability | Child claim plus registered waiter required; claim-only case retains existing aged-waiter policy. |
| A paused merge child can leave a slot idle. | DESIGN, Astra | One twelve-second offer, then first eligible poll wins. |
| Ticket churn can restart the offer indefinitely. | DESIGN, security/scalability | Exhaustion belongs to the free-slot episode, not a ticket ID. |
| Legacy writer can erase or preserve stale top-level metadata. | DESIGN, Astra | Independent holders-file identity proof detects atomic rewrites; input proof must validate before any upgraded writer preserves history. |
| Fail-open admissions may leave no durable record. | DESIGN, Astra | Visible witnesses invalidate history; invisible bypasses explicitly fall outside the guarantee and trigger a healthy-interval reset when observed. |
| Host tuning permits more than one suite slot. | DESIGN, internal | Feature enforcement only under resolved cap one. |
| Ordinary waiters expire after 45 minutes, before a 90-minute holder frees. | DESIGN, internal | Guarantee is conditional on live waiters; measure timeout and retry loss separately. |
| Maturation originally named machines as fleet stages. | DESIGN, standards gate | Test agent, Echo development agent, and fleet roles now have explicit dark-window and graduation fields. |
| Off/observe, mixed-version, and status semantics were ambiguous. | PRECISION, multiple | Distinct controls and momentary advisory status are explicit. |
| Offer expiry and eventual admission are different telemetry events. | PRECISION, Astra | Linked offer and episode outcomes by episode ID. |

## Convergence verdict

Converged at round 7. The final independent pass found no change to what gets built. The design remains conditional on a healthy enforcing one-slot limiter and compatible actors; it does not claim to shorten a running test or authorize merge without the full suite. Justin's 24-hour throughput instruction authorizes implementation within this scope.
