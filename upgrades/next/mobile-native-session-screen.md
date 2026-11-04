# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The Instar iPhone app can now show a session natively. A paired owner phone may read a session's screen with `GET /sessions/<name>/output` and type plain text into it with `POST /sessions/<name>/input`, both signed by the phone's device key. Two new entries in the device allowlist carry a new `ownerOnly` flag (MSP, unassigned, pending, revoked and unsigned requests are refused) and their own rate buckets. A device-only router mounted before the main routes handles them; Bearer requests to the same paths reach the existing handlers unchanged.

The device path only reaches sessions running on this machine, matched exactly (tmux name, then id, then name). It refuses control characters, so the phone cannot press keys. It redacts this agent's token, the dashboard PIN and view signatures from the screen text. It keeps a durable 3-minute record of accepted inputs, so a captured request can never be typed twice, even across a restart. It logs each typed message (without its text) in `logs/mobile-session-input.jsonl`. A session on another machine is answered with a plain reason naming that machine; nothing is proxied. Typing is limited to 12 a minute per phone and 12 a minute across all phones.

## What to Tell Your User

The session button in a chat now opens the session right in the app: you see what the session is doing, live, and can type to it, with no browser and no PIN. There is also a Sessions list on the agent's page. Only your own phone can do this, and it can only type plain text, not special keys. If the agent hasn't been updated yet, the app offers the dashboard instead.

## Summary of New Capabilities

- Watch a session's screen live in the app, refreshed every second and a half.
- Type to a session from the app (plain text, owner's phone only, logged without the text).
- A native list of the agent's sessions, with machine and how long each has run.
- Plain answers when a session has ended or runs on another of your machines.

## Evidence

- Spec docs/specs/mobile-native-session-screen.md converged at the 6-round cap with GPT-6 Astra and the clean-door reader; review found and fixed control characters acting as keys, replay across a restart (twice), credential text in pane output, wrong-session targeting and event-loop blocking.
- Unit: allowlist shape, owner-only flag, named buckets, text filter, exact resolution, miss classification, replay record (including after a restart), redaction, audit rotation, CLAUDE.md migration.
- Integration: both sides of the allowlist through the production authenticator (owner allowed; MSP, unassigned, pending, revoked, notify token, unsigned and credential-less refused; Bearer passes through), session and machine binding, peer lookups, replay, buckets.
- E2E: production AgentServer, a phone paired through redeem and confirm, reading and typing into a real session record.
