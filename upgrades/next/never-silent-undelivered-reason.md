# A never-silent notice that does not go out now says why

## What Changed

When a message waits too long for a reply, the never-silent watcher sends a short notice into the conversation. If that notice did not go out, the server logged only "notice-undelivered", with no reason: the send helper turned any error into nothing, and the server's senders also returned nothing when a notice was held quiet or came back without a message id. On the Studio, 59 of 106 notice events from 20 to 27 November were undelivered, and none of them says why.

Now every undelivered notice is logged with one bounded reason: `held-quiet`, `no-message-id` (Telegram or Slack gave no message id), `no-adapter` (no connection to that chat service), `no-receipt` (the sender could not say), `unknown-reason` (a label the watcher does not know), or `threw:<ErrorName>`. The reason also reaches the feature-evidence record. No message text or error message is copied. The notice after a failed move by tap also logs its outcome now. How notices are sent, retried and counted is unchanged; this is step 1 of CMT-2078.

## What to Tell Your User

Nothing changes in your conversations. When an "I am still working on it" notice fails to reach you, I can now see why and fix the cause.

## Summary of New Capabilities

No new capability. The never-silent log records why a notice was not delivered.

## Evidence

Before: logs/never-silent.jsonl on the Studio, 2026-11-20 to 2026-11-27, 59 `notice-undelivered` rows carrying only incident and kind (33 from one incident retried every sweep). After: tests/unit/neverSilent-watcher.test.ts asserts the reason for a held-quiet send, a send with no message id, a missing adapter, a sender that returns null, and a send that throws (named by error type, with the error text kept out of the log), and that a malformed error name is not copied.
