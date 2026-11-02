## What Changed

- Pairing a phone without Telegram: when the dashboard stops showing a waiting phone's code (it expired, the pairing ended, or the phone list could not be read), the same code can no longer be used to confirm either.
- The agent's instructions now state the honest limit of the dashboard path: the agent can read the dashboard PIN, so a phone approved on the dashboard only proves someone could unlock the dashboard, which is weaker than a private Telegram chat. Existing agents get the corrected sentence on update.
- A new end-to-end test proves an agent with a Telegram owner still sends the pairing code to the private chat.

## What to Tell Your User

Nothing changes in how you pair a phone. One small safety tidy-up: a pairing code that is no longer shown on the dashboard can no longer be used.

## Evidence

- Integration test: with the phone list unreadable, the shown code and the confirmable code are both dropped, and confirming with the old code answers "expired".
- End-to-end test: a real server with a Telegram adapter that knows its owner sends the code to the private chat and shows nothing on the dashboard.
- Unit test: an agent with the first wording has that one line replaced in place, once.

## Summary of New Capabilities

None — corrections to the increment-3 pairing feature.
