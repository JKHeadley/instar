# Slack session reply relay — plain-English overview

Instar already knows how to receive a Slack message, decide whether the sender is allowed, create the right working session, and send text through Slack. The live test found a smaller missing link: the new working session was told to use a reply helper that was not installed. It was like routing a call to the right person and giving them a disconnected handset.

The fix reuses the reply machinery that already exists. It installs the helper in the common runtime scripts location available to Codex, Claude, and Gemini sessions. Generated Slack instructions point there. Claude installations may keep a compatibility copy, but it is no longer the required path.

The session is not allowed to choose a channel or thread. It presents the private session binding it received at creation, and the server resolves that binding back to the verified source conversation. A thread session therefore stays in its exact thread; a root-channel session stays at the root. A forged or missing binding is refused. The helper never receives Slack credentials and never calls Slack directly.

Both new and upgraded agents are covered. One installer handles fresh setup, late Slack setup, normal startup, migration, and update recovery. It replaces only byte-for-byte-known old shipped helpers. A customized file is preserved and gets a visible update candidate instead of being overwritten. Writes are atomic, safe under concurrent updates, and independently reconcile the common copy and the temporary Claude compatibility copy.

On two machines, the Slack session stays on the machine that owns the verified conversation and live Slack connection. A transfer to a machine without that authority is refused before the session starts. If the owning machine is dark, Instar reports unavailable rather than pretending a reply was delivered. A later authenticated Slack message can establish a new owner safely.

The helper has hard connection and total time limits. A timeout after sending is called “outcome unknown” and is not retried automatically, because Slack may already have received it. One invocation has one delivery id; a deliberate retry can reuse that id so the server suppresses a duplicate. This does not claim that a model independently running the helper twice is exactly-once.

The tests cover three levels: small installer and binding rules, the full authenticated local HTTP route, and a production-like spawned non-Claude session. The final test is the exact live failure turned into a regression: a directed Slack thread creates a session and that session uses the real installed common helper to send one invocation-level answer inside the same thread, never the channel root. Upgrade, rollback, compaction, and a two-machine refusal canary are included. Reverting is ordered so no live prompt is ever left pointing at an absent helper.
