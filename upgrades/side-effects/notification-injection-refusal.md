# Side-Effects Review — Preserve Explicit Notification Refusal

**Version / slug:** notification-injection-refusal
**Date:** 2026-11-23
**Author:** echo
**Second-pass reviewer:** codex_followup_review, read-only concurrence

## Summary of the change
Tier1 SMALL reversible source bug fix. The notification helper propagates exact false from the existing injection authority. Three direct-call protections contain that new refusal safely. No new API, setting, queue, automatic retry, schema or credential access is introduced. Actual baseline6fail/3pass is retained. Eleven source/test/doc files before the trace, with two runtime files. One independent reviewer; no spec convergence claimed. Normal commit gate required.

## Decision-point inventory
- Existing injectMessage acceptance: pass-through, unchanged authority.
- Notification reference return: modify; explicit refusal cannot manufacture successful receipt evidence.
- Existing observed wrapper: unchanged catch maps refusal to stuck.
- Hourly notice slot, stored-secret response, delayed hint and paste notification status: protect existing caller outcomes.

## 1. Over-block
Only exact false becomes refusal. Successful string/reference return behavior is unchanged. Direct callers that previously silently discarded false now receive an error they already had to handle for thrown injection failures. Secret submission is already persisted and its response remains successful if the later best-effort notification fails.

## 2. Under-block
Accepted-but-prepared input can still be observed before physical dispatch. This patch does not claim every false receipt class is solved or model consumption is proven. Early Telegram message-ID cache insertion is also separate. No historical message is replayed or claimed recovered.

## 3. Level-of-abstraction fit
Preserve the existing authority’s answer in the common notification helper, before marker observation. Do not add a second content filter or competing terminal writer. The observed wrapper already owns failure interpretation.

## 4. Signal vs authority compliance
No new authority or heuristic. Explicit false is an existing delivery decision propagated to its existing consumer; signal-vs-authority.md remains satisfied. Private-file safety, provenance, ownership, capacity and physical-effect fences are unchanged.

## 4b. Judgment-point check
No new static heuristic at a competing-signals decision point. Exact false is an enumerable API result, not an inference about message content or urgency.

## 5. Interactions
Shadowing: refusal reaches the existing observed catch before marker absence could imply success.
Double-fire: no retry or duplicate injection; one injector call per notification.
Races: delayed hint catches refusal inside the timer, not only in the earlier request stack.
Feedback loops: refused keyless notice does not consume its hourly slot; successful secret storage is not undone by later notification failure. Console paste retains written data and does not broadcast notified on refusal.

## 6. External surfaces
Agent receipt accuracy and existing paste error behavior improve. Auth, secret retrieval, request signing and stored values are unchanged. Tests use fixture values and private temporary directories; no live terminal injection, account credentials, replay or restart. No new feature requires a scaffold command or config migration; the upgrade note explains repaired existing behavior.
Operator surface: existing Telegram, paste form and secret submission form remain the surfaces. No new operator action or approval is introduced.

## 7. Rollback
Ordinary source revert. No state migration or deletion. Preserve already stored pastes/secrets and uncertain delivery records; never replay bodies to compensate for missing receipt evidence.

## 8. Multi-machine posture
**machine-local BY DESIGN**: a receipt describes the exact local incarnation’s injection result. Existing routing, ownership and cross-machine queues remain responsible for transfer. No remote delivered phase is promoted to proof of real consumption.

## Verification
Independent review required catches for delayed hint and persisted-secret notification and post-success hourly marker. Those changes and their HTTP/lifecycle regressions were reviewed. Actual GREEN:21unit,18HTTP,1lifecycle passed, zero skips, all commands exit0 under separate authorized normal admission. This includes the unchanged observed-busy suite and both new caller-safety HTTP cases. Build exit0. Source/test hashes match the frozen manifest. Normal hooks required; full exact-head gate remains throughput custody and is not claimed.
