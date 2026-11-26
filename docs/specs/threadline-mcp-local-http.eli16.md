# Serving the agent-messaging tools from the server that's already running — plain-English overview

## What this change is

Every time an agent starts a working session (a Claude Code or Codex window), Instar also starts a small helper program for it. The helper gives that session its agent-to-agent messaging tools, such as "send a message to another agent" or "read the history of a conversation". Each helper is its own copy of the same program: it loads the agent's identity, reads the same files, and takes roughly 45 MB of memory and about a sixth of a second to start. Ten sessions means ten identical helpers.

But every one of those helpers just forwards its work to the agent's main server, which is already running and already knows everything the helper loads. So this change lets the main server offer the same tools directly, over a local connection on the same machine, and stops starting a helper per session.

## What already exists

- The helper and its tools (they don't change; the same code answers).
- The main server, which already does the real work behind every tool.
- A larger, earlier design for offering these tools to outside programs over the network. This change is the small, local-only piece of it, for the agent's own sessions.

## What's new

- A local-only door on the server for these tools. It refuses anything that doesn't come from the same machine.
- A per-session pass: each session gets its own secret pass when it starts, so the server always knows which session sent a message. That pass only opens this one door.
- The passes survive a server restart (only fingerprints of them are stored), so sessions keep their tools when the server restarts.

## Safeguards

- Off by default. Switched off, nothing at all changes.
- If the door isn't working when a session starts, that session simply gets the old helper, so no session is ever worse off than today.
- The tools run exactly the same code as before, so their checks, permissions and logs are unchanged.
- The pass can't be used from another machine or through the public tunnel, and the agent's main key is not accepted on this door.

## What a reader needs to decide

Whether a single shared door is an acceptable replacement for one helper per session. Today every helper already needs the server to work, so this removes copies without adding a new dependency. It ships off and is measured before anyone switches it on.
