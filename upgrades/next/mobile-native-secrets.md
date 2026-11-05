# Native Passwords & keys for the iPhone app

## What Changed

One read-only route for the Instar iPhone app, for an owner phone or the agent's token: `GET /mobile/secrets`. It answers what's waiting on each machine that replies, plus this machine's key names, vault state and sync state. It never carries a value, a length, a token or a Secret Drop link.

## What to Tell Your User

Your iPhone app can now show which passwords or keys I'm waiting for and which ones I already hold, by name only. Handing one over still happens on the web page I send you.

## Summary of New Capabilities

- **Passwords & keys in the app.** What's waiting on each machine, the names of what I hold, and whether my vault opens and syncs, without opening the dashboard.
- **Right now in the app.** A one-screen glance at what needs you, what's running, promises, machines and health, built from reads the phone already has.
