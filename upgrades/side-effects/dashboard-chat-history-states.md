# Dashboard Chat History States: Side Effects

## Summary

Tier 1 reversible repair of the existing interactive Chats page. Loading, empty response and failed read become visible; retry reads history. It introduces no send, enrollment, approval or merge authority. Accounts and held features are untouched. Source work is isolated from current cached main ec9401e5bdf28ed5ab1ff13f88e0032cc7895fc6.

## Over-block

An existing pending history request prevents a second history retry or focus-triggered duplicate. It does not disable the composer or replace typed text. Navigation retains its normal behavior.

## Under-block

These states do not repair missing server history or certify that an empty result is complete. Wording states what was returned. Real rendering and release proof remain separate.

## Level of abstraction and signal versus authority

This is presentation of read outcomes, with request/view lifecycle invariants. No detector gains blocking authority. Existing browser signing, request limits, recovery and messaging authorities remain in place. Reference: docs/signal-vs-authority.md.

## Interactions

Initial page recovery can resume existing unfinished work through its existing path. The new history-retry action must never invoke that path. Focus and background history share or defer to an existing read. Background successful history must clear a stale failure notice. Per-view timers and late responses cannot mutate another chat. Messages received before the initial result remain visible. Unrelated send/status text and the draft remain separate.

## External surfaces

Visible chat-state wording and a retry button. The button uses the existing signed history GET. No new endpoint, browser approval, credentials, message write or server configuration. Static dashboard assets ship through the existing update path; no migration or new agent capability is introduced.

## Multi-machine posture

The page continues reading the existing pooled history routes and cross-tab broadcast results. It does not create a new state store or infer completeness from a local empty response. View-only pending state is ephemeral browser UI, not durable agent state. No cross-machine ownership authority changes.

## Rollback

Revert this page repair and its documentation/tests; no state migration is required. Session-storage unfinished messages are not deleted or rewritten by a history retry.

## Verification and independent review

Initial three missing-state tests failed against the unchanged source; the old-view test already passed. The first candidate passed four focused cases. Independent Sol source review then found retry invoking send recovery, focus duplicating a read, and stale failure after background recovery. Actual seeded-send and background-recovery regressions failed on the first candidate, then passed after correction. A final review found the reverse overlap ordering; the corrected per-view/path promise map and focus-first regression address it. Final targeted page/model run: 98 passed, zero failures. TypeScript no-emit, JavaScript syntax and diff checks pass. The independent reviewer concurred with the bounded final source and artifact after three source passes; no extra review round is planned. A fresh headless Chromium1255 exercise on a disposable local server passed loading, ten-second waiting, empty, failed and retry/recovered states at1280x728 and390x844, preserving the draft. It verified14 signed history/event GETs, accounted for2 intentional503 history failures, accepted2 ephemeral read reports, made0 message/other writes and had0 JavaScript errors. The owned browser exited and its PID was absent. Root inspected the private captures. Initial fixture startup failures and a strict error-accounting failure are retained; the final fixture corrected its missing static import and read-report handling. This is narrow synthetic UI evidence, not live account history or whole-screen layout approval. Full suite is delegated to throughput, never claimed here.

## Class-Closure Declaration

Defect class unbounded-self-action, closure n/a: no autonomous controller or new external action. The ten-second timer only changes explanation and is cancelled at view/read completion.
