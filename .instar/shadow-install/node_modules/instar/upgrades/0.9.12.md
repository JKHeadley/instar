# Upgrade Guide: Instar (latest)

## What Changed

### Session Continuity Fix — No More Generic Greetings After Respawn

Previously, when a session respawned (e.g., after a crash or timeout), the new session would greet the user with a generic "Hey! What can I help you with?" — completely ignoring the conversation history. This happened because conversation context was delivered as a parenthetical file reference at the end of the user's message, which Claude consistently skipped in favor of responding to the greeting.

**Now**: Conversation context is **inlined directly** into the bootstrap message, placed **before** the user's message, with explicit continuation framing. The agent receives:

```
CONTINUATION — You are resuming an EXISTING conversation. Read the context below...
[conversation summary + recent messages]
IMPORTANT: Your response MUST continue the conversation above...
The user's latest message:
[telegram:N] actual message
```

This makes it structurally impossible for the agent to miss the context — it's the first thing in the input, not a skippable parenthetical.

**Three changes work together:**
1. **Bootstrap restructured** (`server.ts`): Context is inlined before the user's message with strong continuation framing
2. **CLAUDE.md template updated** (`templates.ts`): New "Session Continuity" section explains the CONTINUATION protocol
3. **Auto-migration** (`PostUpdateMigrator.ts`): Existing agents get the Session Continuity section on next update

### Technical Details

- Context is truncated to 4KB inline (summary + ~10 recent messages) to keep injection manageable
- Full history is still written to a temp file and referenced for deeper lookup
- The session-start hook continues to load context independently (belt and suspenders)

## What to Tell Your User

- **Seamless conversation recovery**: "When my session restarts now, I'll pick up right where we left off instead of starting fresh. You won't need to repeat context or re-explain what we were working on."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Inline conversation context on respawn | Automatic — context injected directly into the session bootstrap |
| CONTINUATION protocol | Automatic — CLAUDE.md teaches the agent to honor continuation framing |
| Session Continuity migration | Automatic — PostUpdateMigrator adds the section to existing CLAUDE.md files |
