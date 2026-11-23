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

Focused unit, HTTP and lifecycle checks, typecheck, build and scoped independent implementation review passed. Seven real Telegram server-protocol scenarios passed in `docs/specs/reports/profile-confirmation-batch-live/`, with signed artifacts retaining both a setup failure and an open, separate agent-communication failure. The actual running package was bound to the tested compiled files; cleanup was verified. These are not a complete Local Verify result or healthy-destination certification. Slack is explicitly unproven. The approved specification records operator-delegated bounded closure with `full-convergence:false`, not full convergence or deployment certification.
