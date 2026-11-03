## What Changed

- A reply a session sent while the server was starting got queued and sent later with the footer "unknown · unknown · unknown". The queue kept only the text, so the server could not tell who wrote it.
- `telegram-reply.sh` now saves a SHA-256 fingerprint of the session's origin credential with a queued message (new nullable `origin_session_digest` column in the pending-relay queue). The credential itself is never saved.
- On recovery, the server matches the fingerprint to the running session and fills in the real machine, harness and model. A server restart re-issues session credentials, so the session registry keeps each session's last four fingerprints for this lookup only. They never authorize a send.
- The machine name is now always shown on recovered queued messages, including rows from older scripts. Harness and model are claimed only when a live session matches; otherwise they stay "unknown".
- Existing agents get the new reply script on update (the previous script version is registered as a known shipped version).

## What to Tell Your User

If I reply while my server is restarting, the message used to arrive later signed "unknown". It now arrives with the right machine, tool and model in the footer.

## Evidence

- Unit: a row queued with a pre-restart credential fingerprint recovers with the footer `Echo · Mac Studio · Claude Code · claude-opus-5-5 (configured)`. Rows with no fingerprint or an unknown one show the machine only. An ended session no longer matches. A record claiming a harness without a session is refused at import.
- Unit: the registry matches only live sessions, keeps at most four earlier fingerprints, survives a restart, and never accepts an old credential for sending.
- Unit: the reply script stores the fingerprint for a 503 boot refusal, stores nothing without a credential, and never writes the credential to the queue file.

## Summary of New Capabilities

None — a fix to the label on messages delivered after a server restart.
