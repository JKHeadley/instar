# Side-Effects Review — Retried Reply History Format

**Version / slug:** telegram-recovery-history-markdown
**Date:** 2026-11-23
**Author:** Echo
**Second-pass reviewer:** held_format_review; concur after two material findings were corrected

## Summary of the change

Tier 1 narrow repair: recovered text history uses the authored Markdown retained in a protected request, instead of its Telegram wire HTML. A shared registered-owner capture seam retains Adapter and Lifeline pre-format input, including direct background calls, without replacing an existing policy, metadata, reviewed state or producer. Automation and legacy Markdown ingress also preserve source text. Late replacement retains its pre-prefix input; exact sealed representation/footer comparison prevents a second notice on older marked records without stripping matching authored prose. Existing immutable wire replay remains unchanged. This adds no feature, endpoint, format decoder or storage system. Actual final test results will be recorded before commit.

Proportion: seven runtime files, 66 added and 12 removed lines; six test files, 420 added and one removed line; four documentation/evidence files, plus generated review metadata. The test volume covers the required three tiers and the two reproduced review findings. One independent implementation review and correction recheck; normal commit attempt 1. No spec convergence rounds are claimed for this narrow reversible repair.

## Decision-point inventory

No new block/allow authority. Existing origin authorization, content review, durable claim, capacity and outcome uncertainty remain authoritative. History representation is a deterministic data projection; no text classifier or semantic veto is introduced.

## 1. Over-block

No new refusal. Authored Markdown, including literal HTML-shaped text inside code, must remain byte-for-byte authored text when that source exists. Do not strip tags from arbitrary source as a heuristic repair.

## 2. Under-block

Previously recorded HTML history is not rewritten. A historical request retaining only already-formatted text cannot yield exact original Markdown; do not claim otherwise. This repair must not turn a history-write failure into a new provider send.

## 3. Level-of-abstraction fit

Repair the recovery-to-history projection and the existing original-text capture seams. The formatter owns Telegram's wire representation; the App history remains authored Markdown. Do not change the app renderer to interpret arbitrary Telegram HTML.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

Reference: [signal vs authority](../../docs/signal-vs-authority.md). Existing request/source representation is mechanical, not an intent decision. No policy approval or exemption is inferred from a format.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Existing review and dispatch authorities remain in place.

## 5. Interactions

Protected policy input is already sealed with the request and survives restart. Fallback capture fills only a missing input and preserves existing producer, advisory metadata and reviewed state. With no producer context, it uses the same registered unbound-automation fallback as the existing egress door. It adds no author inferred from text. Existing original-input validation and its byte bound remain in force; the bound is not changed or bypassed. Legacy capture uses already-redacted safeText, never raw snapshot text. Independent source review confirmed normal route history records the same original string, so this projection does not undo a sanitization step. Recovery continues sending the same sealed wire bytes under the same outbox operation. A recorded late marker uses its actual marking time; history must not invent a different age at acceptance. History deduplication remains keyed to the accepted Telegram message, without a second append on another recovery pass.

## 6. External surfaces

Telegram receives HTML with its existing parse mode. The App's existing history response receives Markdown for recovered Markdown replies. No changed auth, credential, signature, route schema or retry permission is intended. No live message, resend, restart or deployment is performed while developing the repair.

## 6b. Operator-surface quality

No UI file or action changes. The intended visible correction is that a held reply retains the same bold/italic rendering as an immediate one. Native visual acceptance remains separate from the server representation tests.

## 7. Multi-machine posture

Replicated through the existing protected origin admission and ordinary topic-history paths. Direct recovery should agree with the existing forwarded-delivery projection. Canonical authored text travels with existing custody; no second store or machine-specific authority is added. No status/capability route, recurring notice or URL is introduced.

## 8. Rollback cost

Revert the code repair and release a normal patch. No schema migration or installed-file repair is required. Existing history is not destructively rewritten in either direction. A rollback may reintroduce the formatting defect on future recovered replies.

## Test coverage

The frozen unfixed HTTP baseline passed both immediate-send cases and failed both capacity-held cases at the exact original-Markdown history assertion; Telegram HTML assertions passed. A separate real recovery unit reproduced the same mismatch. Direct adapter and old no-policy late replacement tests then reproduced the two review findings. The first recovery-unit attempt stopped at an incorrect fixture clock assumption, before the product assertion; it is not counted as product RED evidence. The corrected fixtures respect actual durable-worker retry pacing.

Final candidate results, with seven runtime hashes unchanged:

- Unit: 35/35 in five files, including scoped/unbound direct sends, source/code preservation, legacy Markdown/plain capture, exact late-line cases and real old no-policy admission/replacement.
- HTTP integration: 4/4 selected cases in telegram-origin-routes.test.ts, with 29 unrelated cases unselected. Real adapter/runtime/store and actual authenticated send/history routes; session and automation, immediate and held recovery. Both surfaces and duplicate prevention are asserted.
- Production lifecycle: 1/1 in telegram-held-retry-format-lifecycle.test.ts. Actual bootTelegramOrigin, AgentServer and adapter; real capacity hold, shutdown, reopen, recovery and App history read.
- Normal build: exit 0. Missing development release-signing key is an explicit build warning, not release-signing evidence.
- test-as-self: PASS, no bot/roundtrip; target preparation, current dist deploy, server startup and crash checks passed, followed by guarded teardown. This proves throwaway startup, not a live Telegram send or native app display.

All Vitest runs used normal enforcing host admission. The original HTTP baseline stayed in its separate checkout while the corrected candidate was developed; no frozen source was replaced beneath a queued run. Full exact-head verification remains with throughput after commit. No native visual acceptance, production install or live resend is claimed.

## Self-action declaration

`unbounded-self-action`, closure n/a: this repairs representation inside existing bounded outbox execution. It adds no retry trigger, cadence, budget, controller or permission. The same claim/capacity/uncertain-outcome state machine remains in force. Actual unit, HTTP and lifecycle checks show one accepted network send and no duplicate on another recovery pass.

## Conclusion

Independent review initially found uncaptured direct adapter sends and a duplicate late-prefix case on an old no-policy record. Both were reproduced by failing tests, then corrected. The reviewer concurred after reading the final source; it ran no tests. The focused results above support the correction; complete exact-head verification and actual rollout remain separate. Normal commit hooks are required and their result accompanies the handoff.
