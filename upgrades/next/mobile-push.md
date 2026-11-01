# Phone notifications from the Instar iPhone app

<!-- bump: patch -->

## What Changed

When the Attention hub posts (an item, or a hub notice such as lost messages), every paired phone that registered for notifications gets an Apple push sent directly by the agent with the operator's APNs key (vault `apns_key_p8`, `apns_key_id`; `mobilePairing.push.teamId`). The payload carries no item text; the phone fetches the title with a per-device read-only token (`GET /mobile/attention/:id`). Per phone: a 2-minute fold, hourly after 40 in a rolling 24 hours, URGENT sooner, Apple 429 backoff; durable across restarts. Other machines of the agent receive the trigger (`POST /mobile/push/notify`) and the same condition notifies once. Registration: `POST /mobile/device/push` (device-signed, revisioned). Status: `GET /mobile/push`. Gate: `mobilePairing.push.enabled` (follows `mobilePairing`, development-agent gated). The service is built on every agent, with or without Telegram; only the hub-post hook needs Telegram.

## What to Tell Your User

Once your phone is paired and notifications are on, it buzzes when something needs you, with the agent's name and what it is about, even when the phone is locked. Busy days are folded so it never floods.

## Summary of New Capabilities

- Push notifications for the Instar iPhone app (`POST /mobile/device/push`, `GET /mobile/push`).

## Evidence

Spec converged at the 6-round cap with GPT-6 Astra and an internal reviewer. Tests: 15 unit (schedule timeline, throttle and URGENT, restart, APNs answers, revision ordering), 4 integration (registration, title read token, peer trigger dedupe, hub hook), production-boot check.
