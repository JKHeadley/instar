## What to Tell Your User

From the app's Passwords & keys screen you can now ask for a password or key, and cancel a request that's waiting. Each one needs Face ID. The app never holds the link: open the console to copy or share it. This is on for development agents and off for others until it's promoted.

## Summary of New Capabilities

- `POST /mobile/secrets/requests` and `POST /mobile/secrets/requests/<key>/cancel`: owner phone only, each with a fresh Face ID proof, behind `mobilePairing.permissionActions`.
- `GET /mobile/secrets` now says what the phone can do here (`actions`).
