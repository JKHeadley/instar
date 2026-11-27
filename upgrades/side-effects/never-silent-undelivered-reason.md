# Side effects: never-silent notices log why they were undelivered

**Version / slug:** `never-silent-undelivered-reason`
**Date:** `2026-11-27`
**Author:** `Echo (Telegram Parity, CMT-2078 step 1)`

## Decision and authority

No authority changes. `NeverSilentDeps.sendNotice` may now return `{ undelivered: reason }` (reasons `no-adapter`, `held-quiet`, `no-message-id`) besides a message id or null. A new private `NeverSilentWatcher.deliverNotice` replaces the three `safeAsync(sendNotice)` calls: it returns the id, or a reason (`no-receipt` for null, `threw:<ErrorName>` for a thrown error, the name only when it matches `^[A-Za-z][A-Za-z0-9_]{0,39}$`). A returned label outside those three is logged as `unknown-reason`, so a future sender cannot put free text into the log. The waiting and status paths log the reason on their existing `notice-undelivered` row. The failed-move-by-tap notice, which logged nothing before, now logs `notice-undelivered` with kind `move-failed` when it does not go out. `src/commands/server.ts` senders return the matching reason instead of null.

## Data and resource effects

One extra string field on `notice-undelivered` rows in logs/never-silent.jsonl and in the feature-evidence context (neverSilentWiring passes string fields through). No message text, chat text or error message is written. Notice sending, retry timing, coverage and the evidence kind mapping are unchanged, so the ladder's error rate is computed exactly as before, with two declared exceptions. First, a sender that returns an empty string, undefined or a number was treated as delivered by the old `=== null` check and is now undelivered (`no-receipt`) and retried; no real sender returns these (the server wrappers return an id, a label, or null, and every test double returns a non-empty string or null). Second, the new `move-failed` rows count as errors like every other `notice-undelivered`, and that is the one measured change (rare: only after a failed tap move whose notice also fails).

## Rollback and verification

Revert the commit: `sendNotice` goes back to `string | null` and the reason field disappears. Files: src/monitoring/neverSilent/NeverSilentWatcher.ts, src/monitoring/neverSilent/neverSilentWiring.ts, src/commands/server.ts, tests/unit/neverSilent-watcher.test.ts. Verification: tests/unit/neverSilent-watcher.test.ts (each reason, error text kept out, a malformed error name dropped, and the existing failed-send retry test).

## Second-pass review

**Reviewer:** independent sub-agent (general-purpose), 2026-11-27 15:10 PT, read only. Verdict: CONCUR WITH CHANGES.

It found the waiting and status paths unchanged for coverage, notice records and retry; the Telegram and Slack senders deliver the same set as before; the types compile (contextual typing keeps the label literals); the new catch passes the silent-fallback, empty-catch and LLM-fallback ratchets; and the new tests and the existing retry test pass by trace. Applied: the returned label is checked against the three known labels and anything else is logged as `unknown-reason` (new test); the empty or non-string id case is declared above; the notes say "the chat service" since Slack returns the same labels.

## 6b. Operator-surface quality

No visible surface changes.

## Framework generality

Never-silent watcher internals and the server's Telegram and Slack notice senders. Nothing depends on an agent framework or model provider.
