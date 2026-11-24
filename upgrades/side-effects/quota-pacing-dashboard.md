# Side-Effects Review — Allowance forecast on Accounts

**Version / slug:** `quota-pacing-dashboard`
**Date:** 2026-11-22
**Author:** echo
**Second-pass reviewer:** reset_spec_completeness

## Summary of the change

Tier1, small and reversible: two presentation modules plus mounting on the existing Accounts page, an awareness update, and unit/HTTP/lifecycle tests. The existing forecast endpoint, arithmetic, history, quota policy, account selection and authorization remain unchanged. One independent review round; focused tests cover data-flow through real HTTP and production initialization. Reverting removes the view without state repair.

## Decision-point inventory

No new behavioral authority. Existing forecast measurements pass through a display-only model. Unknown data and a stale cached response display uncertainty, never zero capacity. A five-minute generated-response age guard and one-minute future-clock tolerance only change wording to unavailable; they never hold work. Raw account names and provider text are written with textContent.

## 1. Over-block

No work or account controls are blocked. A separate request prevents slow forecast telemetry from delaying sign-in controls. An unconfirmed account identity is shown conservatively rather than treated as confirmed capacity. Off-state hides only the forecast section.

## 2. Under-block

The view is read-only. It does not certify reliability from a small sample, treat missing numbers as zero, or use forecasts as permission to move work. Requests remain behind the existing authenticated owner-only endpoint.

## 3. Level-of-abstraction fit

A pure view model translates the existing quota-pacing/1 response into paragraphs. DOM rendering uses shared card/details/text primitives on Accounts. No duplicate forecast engine, store, endpoint or background loop.

## 4. Signal vs authority compliance

Reference: docs/signal-vs-authority.md. This is a signal presentation only. The scheduler and existing placement retain sole behavior authority. No LLM call or brittle blocking rule is introduced.

## 4b. Judgment-point check

The operator explicitly authorized the next project card, a plain forecast dashboard after comparison with real resets. A read-only live snapshot contained two scored outcomes (mean absolute error2.4 percentage points, one inside range), which is sufficient to display calibration but not establish reliability. Displayed forecast ranges are explicitly pace ranges, not confidence intervals. Missing outcomes are separately disclosed.

## 5. Interactions

Accounts controls keep their existing behavior. The card fetches independently and failure is local to that section. Existing provider identity merging and partial-source disclosures are preserved. No registration, mutation or spending request is added.

## 6. External surfaces

Accounts gains a section with collapsed provider details, named account forecasts and calibration. Dynamic text is never interpreted as HTML. No private identity hash or machine ID is used as a display name. The existing credentials are neither read nor written by the new code.

## 6b. Operator-surface quality

Complete sentences explain reset projections and unknowns. The view states it measures rather than changes where work runs. Existing CSS primitives provide the responsive layout. Visible calibration sample counts prevent overclaiming forecast maturity.

## 7. Multi-machine posture

The existing pool-scope endpoint merges by identity across machines and reports failed sources; the card displays partial coverage. No machine-local decision, store or notification source is introduced. The awareness entry reaches updated agents through the existing registry.

## 8. Rollback cost

Revert this presentation change. No migration, state cleanup, credential change or session restart is necessary.

## Validation

Unit checks cover numeric/missing/stale/identity/conflict boundaries and DOM failure/escaping. Existing real HTTP replay and initialized-server lifecycle tests now feed their actual responses through the view model. Targeted results, type checking and normal lint/commit/push logs are retained under .instar/recovery/token-reset-routing/dashboard-*.log. Full normal verification remains required before merge; no full-suite, publication or installed success is claimed here.

Final targeted evidence:91 unit checks passed across forecast, existing Accounts and awareness registry;10 real-HTTP integration checks and2 initialized-server lifecycle checks passed. Type checking passed. Independent review identified the real dashboard wrapper’s disabled-response shape; the view now accepts it and an actual Accounts renderer test proves the card mounts hidden while the page stays available. The reviewer concurred after that correction.

The separate Fable allowance is shown separately wherever the existing API provides it, both in provider outlook and account projections; it is never combined with the weekly budget. The original brainstorm’s plan explicitly requires this distinction.

The focused completeness delta for the separate Fable window received reviewer concurrence with no material finding. Its current usage, projection and reset remain independent of the weekly window.
