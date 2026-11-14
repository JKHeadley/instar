# Side-Effects Review — two Telegram-origin e2e tests stop depending on timer order

**Version / slug:** `telegram-origin-e2e-ordering`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1, test-only. Two files under `tests/e2e/`; no file under `src/`.

1. `telegram-origin-notice-policy.test.ts`: the harness returns `noticeMark()` and `suppressedSince(mark)`, read from the `onNoticeState` history (now append-only). The production-observer suppression case (three variants) asserts `{ suppressed: true, attempted: false }` since the mark, where it waited for the current state to equal `suppressed`; it then asserts the resting state: `suppressed` for the `unreadable` variant, `suppressed` or `unavailable` (both with reason `destination-policy`) for `opt-out` and `ownership`, never attempted; and keeps `wire` not called. The vault-rotation case keeps its original assertion and only gains the harness diagnostics as its failure message.
2. `telegram-origin-runtime-lifecycle.test.ts`, `admission-unavailable` variant: exactly one hub call is now asserted BEFORE the recovery pass, where the count is fixed. After the recovery pass the single-call assertion becomes "one or two calls; every call to thread 7848 with the recording-outage text". The `unknown-outcome` variant keeps exactly one call to thread 42.

## Decision-point inventory

None in production. The tests cover the outage notifier's suppress/attempt decision; what they assert about it is discussed below.

---

## 1. Over-block

Not applicable (no gate). Could a test now fail where it should pass? `suppressedSince` requires a `suppressed` state after the mark; in both cases the notifier reaches `suppressed` through `#fireReady` before any re-arm can replace it, and the history keeps it.

## 2. Under-block (what the tests no longer catch)

- **Notice-policy observer case:** a regression in which the notifier reports `suppressed` and then an attempt is caught (`attempted: false` covers every state since the mark; the resting state must not be attempted; `wire` not called). A resting state other than the ones listed is caught. Not caught, before or after: the reason attached to the `suppressed` state itself (neither version asserts it).
- **Lifecycle case, the real loss:** after the recovery pass the test no longer fails on a second hub alert. It did assert one, and its comment called the alert "once-per-outage". The product does not provide that in this fixture today (section 5): the count after recovery is one or two depending on timing. What is still asserted: exactly one alert before any recovery pass, at most two after one pass (so an alert storm fails), and where each went and what it said. Whether the second alert is wanted is filed with the mechanism as fb-de7ee113-bc8 for a product decision; if the decision is "one per outage", the stricter assertion should come back together with the product change that makes it true. <!-- tracked: fb-de7ee113-bc8 -->
- Not addressed: the other failures in this family (`all-durable-recording-sinks-unavailable` from the 250 ms / 500 ms evidence budgets; the hold reason in the corrupt-store case; `telegram-deterministic-notice-origin` line 80). They need a production seam. <!-- tracked: fb-de7ee113-bc8 -->

## 3. Level-of-abstraction fit

The defect is in what two tests observe, so the change is in the tests. The alternative, changing the product so the old assertions hold (keep `suppressed` as a resting state; one hub alert per outage), is a behaviour decision in an outbound-messaging subsystem and is not mine to make inside a flake fix.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No block/allow surface is added or changed. Tests only.

## 4b. Judgment-point check (Judgment Within Floors standard)

None.

## 5. Interactions (the mechanisms, by code reading on main at 9218f7e31)

- **`suppressed` is transient for a listed destination when recording is healthy.** `requestHoldNotice` sets `#recovered = false` (`TelegramOriginOutageNotifier.ts:151`) and queues the notice; on a 0 ms timer `#fireReady` suppresses it synchronously for a null, unauthorized, unowned or opted-out policy (185-196), before any tick can intervene (`recordingRecovered` returns early while the queue is non-empty or a fire is in flight, 110). The maintenance pass every 5000 ms (`TelegramOriginBoot.ts:370-383`) then calls `confirmRecordingHealthy` and `recordingRecovered`, which, seeing `#recovered` false, clears the ready set (115-118) and, for a destination that is still LISTED but opted out or unowned, records `unavailable` / `destination-policy` (126-127). This applies to the `opt-out` and `ownership` variants only. When the config is unreadable or the credential was rotated, `alertDestinations()` returns nothing (Boot:231-232), the pass iterates nothing, and `suppressed` is the resting state; those invocations were deterministic and their assertions are unchanged in substance. The sibling cases that close the store first (`failRecording`) never re-arm, which is why they do not flake.
- **Second hub alert, conditional.** First hold calls `requestHoldNotice` (`TelegramOriginRuntime.ts:192-204`). `recoverHeld` confirms recording (531); if the first notice has finished, `recordingRecovered` re-reserves one (if it is still queued or in flight the guard at Notifier:110 skips the re-arm); the re-admission fails again against the mocked `store.admit` (597) and requests it. The notifier spaces attempts 100 ms apart (`maxAttemptsPerSecond ?? 10`, Notifier 166-171). `h.network` is never cleared in the test, so the calls counted are the first alert plus at most one more.
- **Other tests:** no other test reads `noticeStates`; the harness change (no cap on the history) affects only memory in a short test.

## 6. External surfaces

None. No runtime code, state, config or operator surface.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Not applicable: test-only.

## 8. Rollback cost

Revert the commit. The old assertions return, with their timing dependence.

---

## Conclusion

Removes two timing-dependent assertions that blocked unrelated merges, keeps what each test proves about suppression and about where alerts go, and states plainly the one thing no longer asserted (the count of hub alerts), which is handed to the code's owner as a product question.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude), given the diff and the production code, not the author's conclusions; read-only (no test run)
**Independent read of the artifact: concur, with should-fix items that are applied in this commit**

Verdict: CONCUR, no blockers. Confirmed by reading: in all five invocations of the two changed notice-policy cases a `suppressed` state is always reported after the mark (the `no-current-boot-reservation` path is not reachable: `#recovered` is true when the test asks, ticks before the request skip a ready destination, and the fire goes from queue to `suppress` in one synchronous run); no state in the sequence is an attempt; the new assertion is slightly stronger than the old one. Confirmed: the second hub alert is real product behaviour in the `admission-unavailable` fixture and nothing in the code enforces one alert per outage.

Findings and what was done:
1. The transient-`suppressed` mechanism exists only for `opt-out` and `ownership`; `unreadable` and both rotation variants rest on `suppressed` and could not fail by this ordering. Applied: the rotation case keeps its original assertion; the observer case asserts the strict resting state for `unreadable`; the harness comment and section 5 say which variants the mechanism covers.
2. Removing the count entirely was weaker than needed. Applied as suggested: exactly one hub call is asserted before the recovery pass, and at most two after it.
3. The re-arm is conditional on the first notice having finished (guard at Notifier:110). Applied to the test comment and section 5.
4. Document corrections (PR list, the "accident of timing" claim for rotation). Applied.

Not checked by the reviewer: no test was run; the Local Verify records for the cited PRs; the contents of fb-de7ee113-bc8; `OriginConfigReader` and `OriginNoticePolicyObserver` beyond grep.

---

## Evidence pointers

- Local Verify `run-detail` records on the Studio, 2026-11-13: notice-policy `expected 'unavailable' to be 'suppressed'` on PR 3126 09:07Z (the opt-out variant) and PR 3124 12:51Z, flaky-retried on PR 3107 11:40Z (opt-out variant); runtime-lifecycle `called once, but got 2 times` on PR 3124 12:51Z and on PR 3106's isolation re-run 16:33Z.
- Session `echo-bug-cos-note-3124`, 16:38Z: both files pass alone on PR 3124's head, 55 of 55.
- With this change, both files alone on the M5 (scratch checkout of main e35c22d9a plus this diff), 17:16Z: 55 of 55 pass. A quiet machine: the old assertions also pass there. The failure under load was not reproduced; the fix rests on the code-reading in section 5 and the independent review.
