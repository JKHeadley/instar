# Side-effects review: dashboard edit rejection

**Author:** Echo
**Independent reviewer:** Hooke; design, implementation and corrected boundaries concurred.

## Scope and governing contract

Justin's report from Scout identifies a dashboard amplifier still present in
v1.3.1235. A rejected pinned-message edit fell through to a new send regardless
of whether Telegram had received the edit. This repair preserves the approved
[Telegram message-origin contract](../../docs/specs/telegram-message-origin.md):
a hold or uncertain outcome does not authorize a new operation.

The report's false-wake and daily-send counts were supplied by Justin, not
independently verified on b2lead-insights. Echo's own log contains repeated wake,
tunnel restart and edit-fallback entries; that confirms the path exists locally,
not that every wake is false or that this explains every capacity refusal.

## Decision-point inventory

- TelegramAdapter.broadcastDashboardUrl: replace catch-all fresh sends and error
  substring no-ops with narrow evidence from the platform response boundary.
- TelegramAdapter.apiCall: bind parsed Telegram rejection evidence to the original
  error and the actual edit target; preserve typed holds through existing catches.
- TelegramOriginService.executePreparedBot: retain the same known-failed hold and
  bind edit evidence only after recordOutcome reports recorded:true.
- TelegramEditRejection: private, one-use error-object evidence for matching bot
  account, chat, message and method. No serialized error field grants authority.

## 1. Over-block

Only HTTP400 with ok:false, error_code:400 and the exact Telegram missing-edit
description permits replacement. A future changed description, cannot-edit,
authorization rejection, malformed response or lost evidence remains an explicit
refresh failure, preserving the pinned ID. This may leave a stale dashboard link
until the underlying fault is resolved. It never invents a successful refresh.
Exact authoritative unchanged content remains a no-op. First-run sends remain.

## 2. Under-block

Corrupt or unreadable saved-ID state is still treated as absent by the existing
loader. Existing save failures and simultaneous legitimate missing-message
refreshes are separate adjacent risks, not repaired here. If a genuinely missing
message's replacement is held or unknown, a later broadcast against the still-saved
old ID can receive another genuine missing-message rejection and prepare another
replacement. This repair fences held edits within a broadcast; it does not add
durable replacement custody across distinct broadcast calls. That boundary is
tracked for the subsequent delivery work in topic69507. The broader false-wake
classifier, unconditional tunnel recovery and opaque admission errors remain
follow-ups in topic69507. No generic class-convergence claim is made.
<!-- tracked: topic-69507 -->

## 3. Level-of-abstraction fit

The replacement decision belongs inside broadcastDashboardUrl, before sendToTopic,
so it covers startup, wake and HTTP callers even when an outer caller catches the
failure. Managed Telegram4xx responses are consumed inside the origin service;
evidence must therefore be carried through its original typed hold rather than
reconstructed from adapter error text. Legacy library use classifies the actual
raw response at apiCall. These are the only production evidence producers.

## 4. Signal versus authority

This is a constrained transport-outcome invariant, not a semantic message filter.
HTTP status alone and exception substrings cannot choose a new send. The narrowly
enumerated platform error, actual target and successful durable outcome write
provide the required evidence. Existing ownership, content and send-policy
authorities still decide every replacement. See
[signal versus authority](../../docs/signal-vs-authority.md).

## 4b. Judgment points

No new static heuristic at a competing-signals decision point, LLM call, timer,
recovery budget or policy bypass. Wake classification is deliberately separate.

## 5. Interactions

Held/unknown edits never reach replacement, unpin or pin calls. Their original
operation IDs and saved ID bytes remain intact. A successful missing-message
replacement saves its new ID and the next refresh edits it. Failed replacement
sends also preserve their original error identity. Managed outcome-write failure
cannot mint evidence, even when Telegram's raw response says the message is gone.
Known-failed edit operations retain the existing recovery rules; this repair does
not reset attempts, deadlines, content reservations or the fifteen-minute brake.
No additional retry loop is introduced. Existing raw429 retry behavior remains.

## 6. External surfaces and migration

No new API, config or durable schema. The existing dashboard-refresh route returns
502 when refresh fails. New-install awareness and idempotent PostUpdateMigrator
guidance explain original-operation custody and the remaining wake limitation.
The explicit shadow migration updates AGENTS.md and GEMINI.md even when the new
paragraph already exists in CLAUDE.md; custom framework text remains.
Normal package update and server activation install the runtime correction.

## 6b. Operator surface

No new control or approval. A held update is a failure to refresh the pinned link;
it must not be reported as delivered or worked around by deleting the saved ID.

## 7. Multi-machine posture

Evidence is process-local and target-bound. A serialized remote error cannot
authorize replacement. Standby and revoked lease refusals remain fenced; no
session credential is forwarded and no peer is granted a new send budget.
This repair precedes the pending standby-routing release to stop its relay from
carrying catch-all fallback dashboard posts.

## 8. Rollback

Revert the repair and publish a patch; no queue clearing or data migration needed.
Rollback restores the reproduced dashboard amplification defect.

## Evidence

Nine regression tests failed against the released code for the intended reasons.
The correction passed twenty-two unit cases, three actual HTTP route cases, seven
production-Boot lifecycle cases and three awareness migration cases. E2E fixture
repairs used a short Unix-socket path and the actual audit record/outer-service
error contract. They did not change production to accommodate the fixture.
Initial build and lint passed; the reviewed build passed. Independent review
required preserving original errors on null/undefined-token adapters, managed
unchanged-response coverage and explicit documentation of repeated replacement
custody. These corrections passed their focused tests. Expanded shadow tests
exposed missing standalone guidance on existing framework files; the explicit
migration tuple corrected it and all three migration cases passed. Final commit
checks, full test:all and CI remain required before release.

The first full run on 9ffb202636d7 found two release-completeness failures:
the new awareness marker was absent from the feature-addenda parity registry,
and the release fragment lacked the required sections. The parent deliberately
cancelled its own run after confirming these failures; all 5,579 frozen inputs
were unchanged. That run is incomplete, not passing. The correction adds the
marker to the existing real parity assertions and organizes the release note
under the required headings. It changes no production behavior and removes no
assertion or release requirement. A fresh full run is required on the correction.
The corrected completeness suite and dashboard unit/migration tests passed all
179 cases across three files.
Independent correction review confirmed the added assertions preserve the gate;
its wording concern narrowed the user-facing claim to held or uncertain pinned
edits, preserving the documented cross-invocation replacement limitation.

Class closure: unbounded-self-action is n/a for this bounded change. It removes
an exception-driven extra send from one invocation and adds no autonomous retry
controller. It does not claim to close the broader wake loop or cross-invocation
replacement-custody class.

The full run on d9d9dfa92a65 completed with exit 1: 3 failed and 51,883 passed tests (3
failed/3,349 passed files); subsequent standalone integration and E2E stages did not
run. All 5,579 frozen inputs were unchanged. Two token-redaction tests depended on the
source spelling `throw new Error`; the runtime now assigns that error before attaching
private rejection evidence. Replacements exercise actual JSON and non-JSON rejection
paths, assert the sanitized request URL and absent fixture token, and independently
verify one wire request carries the correct token URL. This covers request-URL
redaction, not arbitrary response-body redaction.

The third failure's final stack identifies prepareBot at production-Boot test 104,
inside runWithSessionToken after its awaited observer refresh. The two recovery fixtures
previously checked authorization earlier, before issuing the token. They now also
observe the actual display authority immediately before their first preparation using
the existing bounded helper. No preparation, admission, review, or delivery is retried;
no production permission, timeout, or budget changes. The specific source of
configuration invalidation remains unproved, and the fixture does not claim atomic
readiness.

Independent Boot reviews concurred with this exact setup correction conditional on the
final preparation stack, now confirmed. Hooke concurred with both runtime-redaction
replacements and recommended always restoring global stubs/temp files even if
adapter.stop throws; that cleanup improvement is included. Focused validation and a
fresh complete full run remain required on the correction.

The corrected three-file run passed all 24 tests on the dashboard worktree, including
the real production-Boot restart cases. Runtime source is unchanged from its passing
build; full-suite validation and CI are still required.

The fresh full run on 1523f656a99c completed normally with exit 1: exactly two
failed and 51,886 passed tests (one failed/3,351 passed files). The only failing
file was guards-route.test.ts. Standalone integration/E2E stages did not run
after the aggregate failure. All 5,579 frozen source/test/config inputs were
verified unchanged after completion.

The receiver fixture used 1781300000000 (2026-06-12T21:33:20Z), which crossed the
durable store's real-clock 90-day retention threshold at 2026-09-10T21:33:20Z.
The preceding full run exercised that fixture before the threshold. Three
receiver-clock initializations now start at Date.now(), retaining their existing
relative advances and every persistence/age assertion. The sender timestamp
remains fixed, so receiver-versus-sender semantics are still tested. Production
retention policy and dashboard runtime behavior are unchanged.

Hooke independently concurred with this exact clock correction. All 20 tests
passed in both the isolated preparation and the dashboard candidate after the
patch was applied. The next full run must validate the resulting commit.
