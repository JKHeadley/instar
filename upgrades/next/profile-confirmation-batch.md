<!-- bump: patch -->
# One Answer For Several Conversation Changes

## What Changed

Adds a registered Telegram question that can describe several conversation changes together. One exact reply saves the validated settings as a group, followed by one aggregate result that distinguishes saved or preview settings from restarts that remain pending, skipped or failed. Conversations with identical names include native links beside their individual effects. Duplicate deliveries share their result rather than repeating the change or its completion attempt.

The profile store separates working changes from publicly readable durable settings, waits for boot preparation before launching a session and coordinates supported restores with writes. Current assignment and session checks fence delayed runtime actions and stale profile transfers, including same-value reaffirmations.

## What to Tell Your User

I can list several conversation changes in one question. Use Reply on that question and send yes once before its shown deadline. I will report which settings were saved and whether any restarts still need attention.

## Summary of New Capabilities

Agents can request a batch through `POST /topic-profile/propose-batch` with `confirmIn` and `targets` containing `topicId` and `patch`. Compatible pending questions can become one registered reminder. Verified owner-turn context can fund a new or corrected question without granting permission to apply it. Existing single-target APIs and the existing long deadline remain compatible. No new configuration or feature flag is added.

Pending permission still does not survive server restart. Restart intent continuity is the assigned next slice. Slack and App consent and destination runtime health are not established by this change.

## Evidence

Implementation and focused supporting checks are in progress. Separate observed supporting runs include 49 request tests and six rendering tests; these are not complete-gate or live-channel evidence. Exact-head Local Verify, integrated ingress/HTTP lifecycle proof, independent implementation review and fresh signed Telegram evidence remain pending. Slack is explicitly unproven. The approved specification records operator-delegated bounded closure with `full-convergence:false`, not full convergence or deployment certification.
