# Secret Drop: only the agent's own requests reach its conversations

## What Changed

Secret Drop requests now record who made them when they are created: the agent with its own key, the owner's phone, a dashboard session, or anything else (unverified). Only a request made with the agent's key or from the owner's phone can name a conversation, send a "secret received" message into a session, or start one. Every step that could reach a session checks that stored record itself. The agent's helpers now make requests with the agent's key.

Unverified requests still get a working paste page, now with a fixed warning and without their description. They are marked `"origin": "unverified"` where the agent lists or retrieves them, cannot ask for a browser password, and must use field names that are safe to type in a command (a stored name that is not is offered as `#N`, which the retrieve script accepts). The route that takes requests without a key accepts only this machine's own helper and refuses anything a browser or proxy would send. Caller-written text in session messages is quoted as untrusted data. Long session notices are written to a folder only this user can use. Reading a secret with a dashboard session asks for the PIN step-up.

## What to Tell Your User

Nothing changes in normal use: asking for a secret, the paste page, phone requests and agent-to-agent hand-offs work as before. A session that was already running when this update arrived is told, in plain words, to restart to get "secret received" messages back; until then its links still work.

## Summary of New Capabilities

None. Security hardening of Secret Drop.
