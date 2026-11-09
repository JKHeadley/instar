# Telegram test groups through the browser broker

## What Changed
The Telegram origin broker can now make, list and delete Telegram forum groups for live proofs on the operator's enrolled web Telegram profile, through three typed routes. A created group has a title starting `Instar test - ` and ending with a short marker that only this agent can issue; the group holds exactly the operator and one approved test bot, and the bot gets only topic, pin and delete-message rights. Delete only removes a group whose live title carries a marker that checks out under this agent's key, so it can never reach a real chat. Creating needs an agent-held grant in the Telegram messaging config (`messageOrigin.testGroups`, expiring within 30 days); list and delete work without it. Caps: 5 live groups, 10 creates per day, Telegram flood waits honoured. While a reply waits behind any browser work, its delivery reservation is now kept alive, so slow browser work can no longer expire it.

## What to Tell Your User
When I need a Telegram test group for a live check, I can make one myself and delete it afterwards, instead of asking you to set one up. It is off until I turn it on for a specific test bot, and it can only ever touch groups I made.

## Summary of New Capabilities
- `POST /telegram/browser/PROFILE/test-groups`, `GET /telegram/browser/PROFILE/test-groups`, `POST /telegram/browser/PROFILE/test-groups/CHANNEL_ID/delete` (same authentication as the browser send route).
- Replies queued behind browser work keep their claim alive until they are sent.

## Evidence
Unit, integration and e2e tests listed in upgrades/side-effects/telegram-test-groups.md, including the real Web K page scripts run against a simulated account and the production boot path. Live proof on the Studio broker with the spare test bot follows the merge.
