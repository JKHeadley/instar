# Side-Effects Review — Explicit Manual Unused-Allowance Balancing

Date: 2026-11-23. Author: echo. Tier 1: a reversible, optional choice within the existing authenticated manual swap action. No automatic session movement, scheduler, job routing, credential write or paid-work trigger is added. The parent requested a focused correction after repeated supported moves chose the same destination.

## Summary of the change

The existing manual swap route accepts boolean balanceUnusedQuota. When true, it reads this machine's existing quota-history summaries and ranks fresh local Codex identities by positive weekly forecast gap per remaining hour, divided by one plus the identity's running sessions. It excludes the source login and groups account aliases when counting sessions. Ordinary callers and all automatic selectors retain their behavior.

## Decision-point inventory

The owner-approved manual flag is the authority to request balancing. Forecasts and running-session observations are signals feeding a deterministic, explicitly requested selection judgment. Target eligibility and source identity checks are existing safety floors. A distinct scheduler manual intent avoids pretending a healthy account has hit its quota wall. Its refresh caller is interactive-refresh, preserving the busy-work refusal and rate guard. No request supplies an arbitrary target account or home. A serialized controller and durable unresolved intent prevent repeated selections while refresh effects remain unknown.

## 1. Over-block

Missing, stale or identity-mismatched forecasts refuse explicit balance mode even when ordinary placement might find capacity. An unknown refresh or corrupt saved intent blocks later balance requests until reconciliation; this is deliberate protection against duplicate moves. Omitting the flag restores the ordinary request, but it does not prove an unknown earlier refresh had no effect.

## 2. Under-block

The score is not a token estimate or quota reservation. A high-spend session can differ greatly from another session, and work on other machines is not represented by the local occupancy denominator. Existing quota readings include observed shared-account use, but this does not establish provider-wide scheduling. A pure forecast can still be inaccurate. Explicit manual approval and continued usage measurement remain necessary.

## 3. Level-of-abstraction fit

Selection belongs in the manual route and the existing scheduler/refresh funnel, rather than a global account preference or changed earliest-reset selector. The production callback uses the real local history ledger and account identity partitioning. No loopback request or arbitrary peer roster supplies a local credential home.

## 4. Signal vs authority compliance

Reference: docs/signal-vs-authority.md. The flag requests an already authorized manual action. The forecast is evidence, not a grant or autonomous trigger. The score is a bounded, inspectable judgment explicitly requested by the caller; unknown data never silently chooses another selector. Source and target validity are deterministic consistency floors, not natural-language blockers.

## 5. Interactions

The balance controller serializes selection through refresh settlement across session names. A successful refresh is accepted only when the replacement record has the expected target and a new session identity. A thrown or unclassified refresh retains a durable intent across restart. Definitive pre-kill refusals release the request. Reconciliation requires the expected replacement record before more balancing. A server-owned final consistency callback is carried through the scheduler and production refresh wrapper to SessionRefresh after its awaited work gate and before the rate budget and kill. It rechecks source identity, chosen target forecast, home and read/write access. A changed intent refuses without consuming refresh rate budget. Existing refresh work/rate gates remain active, and reactive observation hooks are not mislabelled with a manual balancing event.

## 6. External surfaces

The only API change is an optional boolean on the existing bearer-authenticated swap route. It introduces no endpoint, arbitrary account/home write or model call. The saved intent contains session/account identifiers, not credentials or conversation content. Default and false requests keep the original selector. Production rollout and any actual swaps remain outside this implementation session.

## 7. Multi-machine posture

This explicit action executes on the contacted machine. Its account homes, local session identities and ledger summaries remain machine-local because credentials and process state are local. No credentials are replicated. The controller does not claim to serialize swaps on different machines; its response and awareness text state the local scope. A saved unresolved local intent survives restart and is not silently transferred or deleted.

## 8. Rollback cost

Stop sending the optional flag or revert the commit. No automatic policy or schedule needs disabling. Sessions already moved retain their results. The new saved intent is used only by this optional mode; preserve and reconcile any unresolved operation rather than deleting it to retry. No credential, conversation or account metadata migration is needed.

## Verification and proportion

Focused unit coverage exercises score boundaries, account aliases, concurrent requests, source changes, definite refusals and restart custody. HTTP coverage uses the real scheduler. Production lifecycle coverage starts AgentServer with its real local history callback and proves a sequence chooses both eligible targets; an off ledger refuses. Complete verification belongs to throughput. The separate root reviewer inspected the controller, scheduler, HTTP route, production ledger and refresh wiring, lifecycle proof and final pre-kill guard. The reviewer required and then concurred with the final source/target consistency check after the awaited work gate. This was a source-backed internal review, not an external paid model review. No full-suite, published or live result is claimed here.

## Final evidence

The final targeted run passed 55 unit, 3 HTTP and 2 production lifecycle tests. Removing only the occupancy denominator deliberately reproduced repeated same-account placement in the four-concurrent-request regression; correct source was restored and the dedicated test file passed again. The Stage-B certified-source fingerprint check passed with its existing manifest and evidence unchanged. Full verification remains with throughput. Normal commit hooks remain required.

The first normal commit attempt was blocked by the existing framework-name ratchet because the new module repeated a framework string literal. It now uses the shared framework constant; the ratchet and dedicated unit tests pass without a baseline change. The commit is retried through all normal hooks.
