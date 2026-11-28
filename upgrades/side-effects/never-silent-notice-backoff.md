# Side effects: failed never-silent notices back off and count once per failure streak

**Version / slug:** `never-silent-notice-backoff`
**Date:** `2026-11-28`
**Author:** `Echo (Telegram Parity, CMT-2078 step 2)`

Stacked on `never-silent-undelivered-reason` (CMT-2078 step 1, PR 4025); this branch contains that commit.

## Decision and authority

No authority changes. `NeverSilentWatcher` keeps an in-memory map `noticeRetry`, keyed by incident id and notice kind (`waiting` or `status`), holding the failures in a row and the next allowed try. `sendWaitingIfUncovered` and `sendStatus` return early while the wait has not passed (in `sendStatus` the check runs before the ask button state is written, so a skipped try changes nothing). A failed try records `attempt` (its number in the failure streak, 1 = first) on the existing `notice-undelivered` row, plus `firstFailure: true` on the first try of the streak whose reason is a real failure (not `held-quiet` or `no-message-id`, the set `NOTICE_HELD_REASONS`), and sets the wait to 30 s doubling per failure, capped at 15 minutes (`NOTICE_RETRY_BASE_MS`, `NOTICE_RETRY_MAX_MS`). A delivered notice deletes its entry. The map holds at most 500 entries and drops the oldest. The failed-move-by-tap notice (`move-failed`) is a one-off and is not backed off.

The evidence mapping moved into an exported pure function `neverSilentEvidenceKind` in neverSilentWiring.ts. Changed: a `notice-undelivered` row with reason `held-quiet` or `no-message-id` is neither an error nor fired (the Pipeline Strategy condition of 2026-11-27, message f7a6ebe7); a row with a try number is an error only when it carries `firstFailure`, so a streak that starts held and then really fails still counts once. A row without a try number (the one-off `move-failed` notice) is an error as before unless it was held. Everything else maps as before.

Known judgment call: Slack reports `no-message-id` when its send returns no `ts` (src/commands/server.ts, the Slack notice sender), which may be a real Slack failure; it is not counted as an error, as the Pipeline Strategy condition asks, and it stays visible in the log with its reason.

## Data and resource effects

Fewer notice sends while a chat service is failing (five tries in ten minutes instead of about twenty-one), and fewer rows in logs/never-silent.jsonl. The ladder's error rate for monitoring.neverSilent changes meaning: from per try to one per failure streak of an incident and kind (a restart, an eviction from the map, or a delivered notice followed by a new failure starts a new streak, and each streak counts once), so the first review after this change must report both counts side by side; the per-try count comes from the log rows, which keep every try. A status notice whose revision changes during the wait waits too: a new status revision is not sent at once while a failed status notice of the same incident is waiting. The same holds for the waiting notice: a new message that arrives during a waiting-notice wait waits too, up to 15 minutes, before its notice is tried. That trades a possibly faster update for not hammering a failing service, and the wait is at most 15 minutes. An existing quirk now lasts longer: `sendStatus` writes the open ask (with `sentAt`) before the send, so after a failed send the incident shows an open ask whose button has not gone out yet, until the next try (before, about 30 s; now up to 15 minutes). Retries reuse the same nonce, so a later tap still works; nothing reads `ask.sentAt` as proof the button was shown. After a server restart the map is empty, so the first sweep tries at once, as today.

Self-action: no kill, retry-on-self or restart path is added; the retry here is of an outbound notice and is now slower, not faster.

## Rollback and verification

Revert the commit: the watcher retries every sweep again and the evidence counts every try. Files: src/monitoring/neverSilent/NeverSilentWatcher.ts, src/monitoring/neverSilent/neverSilentWiring.ts, tests/unit/neverSilent-watcher.test.ts. Verification: tests/unit/neverSilent-watcher.test.ts (39 tests on the M5, 2026-11-28 03:31 PT, exit 0): the doubling wait, the 15-minute cap, the reset after a delivered notice, a held-then-failing streak counted once, a failing status notice backing off with no ask state written on a skipped try, the evidence mapping, and the existing failed-send retry test (now waits 30 s). Type check: npx tsc --noEmit -p . exit 0 on the M5. Re-run after merging main d42c7aa6d (merge 97dff7665, 2026-11-28 03:38 PT): 39 passed, tsc clean.

## Second-pass review

**Reviewer:** independent sub-agent (general-purpose), 2026-11-28 03:28 PT, read only. Verdict: CONCUR WITH CHANGES.

It traced the backoff (no off-by-one; tries at 0, 30, 90, 210 and 450 s in ten minutes; the cap lands on the 30 s tick grid), confirmed the status skip runs before any ask state is written and the waiting skip before `markCovered`, that no path leaves a person without a notice for good (retries continue at most every 15 minutes while the conversation is overdue, and eviction only makes a retry sooner), that the move-failed path is excluded, and that no other test or caller relies on retry-every-sweep or the old evidence mapping (git grep over src and tests; the integration and e2e double ticks use succeeding senders). Applied: the misplaced restore-flap comment moved back; a streak that starts held and then really fails is now counted once (`firstFailure`, new test); a status-notice backoff test with the one-tap ask; the notes now say one error per failure streak, declare the waiting-notice wait, the open-ask quirk and the Slack `no-message-id` judgment call. Second look, 2026-11-28 03:31 PT: CONCUR, with four wording fixes (field comment says first real failure, title and note say failure streak, the ELI16 names the no-message-id case), all applied.

## 6b. Operator-surface quality

No visible surface changes.

## Framework generality

Never-silent watcher internals only. Nothing depends on an agent framework or model provider.
