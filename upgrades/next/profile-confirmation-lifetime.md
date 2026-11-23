<!-- bump: patch -->
# Longer-Lived Conversation Change Questions

## What Changed

Identified conversation-change questions default to a full day and state their fixed deadline. Intentional reminders remain visibly distinct without extending the deadline. Delivery callbacks belong to the precise send attempt, and unrelated messages cannot become confirmation receipts. Saved settings remain recorded when acknowledgment or later runtime work fails.

## What to Tell Your User

Use Reply on the question and send yes before its displayed deadline. If delivery was interrupted, I will check the current settings and running conversation before asking again.

## Summary of New Capabilities

The optional topicProfiles.proposalConfirmTtlMs setting controls new identified requests. Deferred runtime changes recheck the original ownership boundary before launching or stopping a session. Pending requests are still local to the running server; restart recovery and one question covering several conversations are separate follow-up work.

## Evidence

Focused unit, HTTP and production-composition lifecycle checks cover deadlines, send-attempt ordering, final ownership checks and saved outcomes. The design review closed under an explicitly bounded operator authorization, not full convergence. Fresh live-channel proof and complete Local Verify remain release requirements.
