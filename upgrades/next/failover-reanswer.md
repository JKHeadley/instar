<!-- bump: patch -->

## What Changed

A machine that accepts a forwarded Telegram message now records the original inbound key before answering, so its reply can close the router's open record. Recovery checks pooled topic history and prior ownership before considering a replay. A possible earlier reply or an incomplete peer read holds the message for verification. A new session receives pooled conversation history and a clear warning if some history may be missing. Echo can reconcile an old stuck row against a reviewed exact reply through a loopback-only audited route.

## What to Tell Your User

A temporary machine connection problem will no longer make me answer an old topic message again without checking the previous machine. If I cannot confirm the earlier conversation, I will wait instead of telling you the message was unanswered.

## Summary of New Capabilities

Cross-machine replies now carry the original message key. Legacy stuck rows can be reconciled against exact replies without replay.

## Evidence

The Nov 2 reply to telegram:136471:136473 exists only in the Mama PC's topic history. Focused unit tests, the reconciliation route integration test, and the two-server link-break test pass.
