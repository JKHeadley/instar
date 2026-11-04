# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

A session that hits its subscription account's usage limit now moves to another account with room and carries on, instead of sitting stuck until the limit resets. The watchdog has a separate usage-limit signal, the move covers sessions that were started on the default login without an account label, new sessions are labelled with a pool account when they start, and a new session never starts on an account the agent already knows is full. The standby message now recognises the current Claude Code limit screen, which it used to read as "recovered". All of this is one switch, `subscriptionPool.wallRescue.enabled`, on by default and active only when the agent has 2 or more working accounts of the same kind. Existing agents get the setting on update; an explicit `false` is kept. Status: `GET /subscription-pool/wall-rescue`.

## What to Tell Your User

If you have more than one subscription account connected, a conversation that runs out of usage on one account now switches to another account with room and keeps going on its own. You'll only hear about a usage limit when none of your accounts has room left, and then the message says plainly when it resets. If you have one account, nothing changes.

## Summary of New Capabilities

- Usage-limit rescue: a conversation at its account's usage limit moves to an account with room and continues, labelled or not.
- New sessions start on a pool account with room, never on one known to be full.
- `GET /subscription-pool/wall-rescue` shows whether the rescue is active, how many accounts qualify, and what happened recently.

## Evidence

Incident 2026-11-04 (feedback fb-6e43a66a-75d, fb-d2862f4d-b52): two sessions sat at a 100% weekly wall while the pool held accounts at 10% and 47%. Default-on approved by the operator on 2026-11-04 (topic 134156). Unit, integration and end-to-end tests cover the wall signal on a real pane layout, untagged resolution, the 2-account condition, the brakes, spawn labelling and the migration.
