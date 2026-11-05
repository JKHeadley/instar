<!-- bump: patch -->

## What Changed

With memory privacy turned on, a Linux agent saved memory correctly but could not answer anyone: the sandboxed session has its own network, so its reply scripts could not reach the agent's server (curl exit 7). Each scoped session on Linux now gets a small curl setting in its own folder that sends requests for the agent's server through the sandbox's own proxy, which already allows it. The session reaches nothing it could not reach on macOS. macOS is unchanged, and so is every agent with memory privacy off (the default).

## What to Tell Your User

Nothing changes unless you turned on memory privacy on a Linux machine. If you did, people now get replies again; their facts stay as separate as before.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Replies work from privacy sessions on Linux | automatic when memoryPrivacy.enabled is true |

## Evidence

Claude Code 2.1.318 on Ubuntu 24.04 with the real session settings, slack-reply.sh and telegram-reply.sh, against a stand-in server on port 4040: without the change, curl exit 7 and no reply; with it, both replies arrived carrying the session's limited token, outside hosts still reachable, and the agent home's files still unreadable. Unit: memory-session-policy. Integration: memory-privacy-spawn (Linux and macOS spawn flags).
