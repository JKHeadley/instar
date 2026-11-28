# Side-Effects Review — History Acquisition Main Reconciliation

Date:2026-11-23. Author:echo. Tier2. This merges exact main aa1f50b67876c8f66621c85df1bdbf145c0d66af into the existing126fc75c acquisition branch. It preserves that branch's ancestry and adds no native parsing/encryption helper work.

## Summary of the change

Resolves five main conflicts while preserving current main's quoted-agent views and Chief of Staff title fallback, the prerequisite's immutable archive receipts and real writer lock, all existing self-action controllers, and both acquisition controllers. Resolution files were independently reviewed in a private composition; the five latest-main input blobs are byte-identical to that reviewed baseline. No helper modules or source-union expansion is included.

## Decision-point inventory

No new permission, limit, approval or provider policy. Existing owner/agent response boundaries, archive verification, fresh preview and writer admission pass through unchanged.

## 1. Over-block

No new refusal policy. Existing private-storage, source-change, provider/account and writer-busy refusals remain.

## 2. Under-block

This is source reconciliation, not completed normal verification, installed-provider evidence or native acceptance. Capability availability remains dependent on actual configured connections. The startup tests cover fallback/cleanup, not a claim that a real provider connection or native journey is installed.

## 3. Level-of-abstraction fit

Resolve composition at the conflicting server, route, awareness, registry and test-import sites. Existing implementations retain their own responsibilities; no second importer or authority is created.

## simplestRobustRoute

A normal ancestry-preserving main merge is the simplest route. Keep both sides' existing behavior instead of replacing either implementation: dropping main would restore unquoted export text or lose project names; dropping the prerequisite would lose immutable snapshots and writer admission. No new machinery is needed.

## 4. Signal vs authority compliance

Reference:docs/signal-vs-authority.md. Imported text remains inert quoted data for agents. A receipt is evidence only; fresh owner confirmation and existing admission remain authority.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

## 5. Interactions

AgentServer keeps both the title fallback and acquisition worker/router initialization. Startup, polling and shutdown remain single registrations. The self-action registry retains every current-main entry and both acquisition entries. Agent previews continue through agentPreview; owners keep their raw preview. Both generic refusal branches retain caller, preserving filename-safe agent errors. Test imports retain both scrub-window and writer-contention coverage.

## 6. External surfaces

The existing pull request's intended behavior is unchanged. This update must return to normal custody under its actual pushed head; no completed pass or merge is inferred from source review. No user history, live account or Claude invocation was used.

## 6b. Operator-surface quality

No operator renderer changes in the resolution. Awareness retains provider-unavailable fallback and complete quotation/fact-confirmation instructions.

## 7. Multi-machine posture

Existing selected-machine private acquisition and current conversation routing remain unchanged. No new local store, replication route, URL or notification is introduced by the resolution.

## Team posture

Existing owner-only personal-account acquisition is retained; no member/guest or unsigned sharing authority is added. Agent access retains its existing quoted-history boundary.

## 8. Rollback cost

Preserve both parent histories. Any later rollback of a deployed writer must retain authorized reads and lifecycle cleanup; do not delete imported history to undo deployment.

## Conclusion

Corrected official no-emit typecheck exited0. Clean-tree focused evidence:92 unit cases,14 full HTTP cases and3 AgentServer fallback/cleanup lifecycle cases all passed. The separate private composition also passed904 existing self-action convergence cases, recorded as separate evidence rather than borrowed as an exact-head parent pass. Full ordinary verification is still required before publication or completion.

## Second-pass review

local_reader_review checked response/quotation and refusal boundaries and caught a missing type import, now restored. local_parser_review compared original provenance/preflight/writer behavior. local_final_gaps checked startup/shutdown, controller preservation and awareness. Their reviewed five-file resolutions were reused only after proving the latest-main input blobs unchanged. No reviewer claimed a public merge or full pass.

## Class-Closure Declaration

- defectClass: unbounded-self-action
- closure: guard
- guardEvidence: tests/unit/self-action-convergence.test.ts, enforcementType ratchet. Existing acquisition polling and notice controllers retain their registered bounds; this merge adds no controller beyond the existing prerequisite.
