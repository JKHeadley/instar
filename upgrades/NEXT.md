# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Agent-to-agent reply-waits no longer flood the user's chat with "⏳ awaiting
reply" heartbeats.** When an agent sent a Threadline message to another agent,
`TopicLinkageHandler` created the reply-tracking commitment with
`beaconEnabled: true` **and** the user's topic id attached. `PromiseBeacon` then
fired cadenced `⏳ … awaiting reply` heartbeats straight into the user's Telegram
topic for what is purely an agent-to-agent conversation — observed in the wild as
dozens of heartbeats burying one topic, making real work invisible and reading as
"stuck."

The reply already routes back on its own: the threadline-reply commitment carries
`relatedThreadId` + `topicId`, and the inbound dispatch matches on those when the
reply lands — entirely independent of the beacon. So the heartbeat was pure
housekeeping noise. The fix sets `beaconEnabled: false` on these reply-wait
commitments. This is a direct application of the **Near-Silent Notifications**
standard: routine agent-to-agent status belongs in logs, never the user's chat.

## What to Tell Your User

Nothing to configure. If your agent talks to other agents over Threadline, it will
no longer spam your chat with "⏳ awaiting reply" heartbeats while it waits for a
peer — the peer's reply still arrives and routes to the right place exactly as
before. Beacons that were already running before this update auto-pause on their
own; new ones won't be created.

## Summary of New Capabilities

- `TopicLinkageHandler` creates threadline-reply commitments with
  `beaconEnabled: false` — the reply-routing (relatedThreadId + topicId) is
  preserved; only the user-facing heartbeat is suppressed.
- No change to user-facing PromiseBeacons for genuine commitments *to the user*;
  this scopes the suppression to agent-to-agent reply-waits only.

## Evidence

- `tests/unit/TopicLinkageHandler.test.ts` — the threadline-reply commitment now
  asserts `beaconEnabled === false` (regression pin).
- `tests/unit/CommitmentTracker-threadline-reply.test.ts` — the tracker still
  honors an explicit `beaconEnabled: true` (mechanism unchanged); stale "matches
  call-site" comment corrected. 32/32 green across both files.
