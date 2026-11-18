# A missing or unreadable API key is safe and visible

<!-- bump: patch -->

## What Changed

If the agent's API key is stored in the secret store but could not be loaded, requests that need the key now get a clean `503 agent-credential-unavailable` refusal instead of crashing. Everything with its own proof keeps working: paired phones, the agent's other machines, other agents, document pages and the PIN screen. The server re-reads the store with backoff (1 minute, doubling to 30), puts the key back in use the moment it loads, and tells the owner after 3 failed tries. It stops after 24 hours and says so.

An agent with no key at all behaves exactly as before. Each request served without a key is now counted, and the existing "Reply fix auth" notice stays the one notice. The "fix auth" reply now makes a 32-byte key, checks that it was saved, puts it in use at once, and posts no part of it. On an agent that runs on more than one machine it does not set a key on one machine alone.

The Telegram relay sends the key only when it is a real string, and re-reads it when the server refuses it, so a changed key no longer stops message delivery. Sessions are never given the text "undefined" as their key.

## What to Tell Your User

- **Safer key handling**: "If the secure store that holds my API key ever fails to open, I now refuse requests cleanly and keep retrying instead of breaking, and I'll tell you if it lasts. If I have no key at all, I'll keep offering to set one up for you."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Unreadable-key refusal and self-repair | Automatic |
| Safer "fix auth" reply | The owner replies "fix auth" in the Agent Attention topic |
| Relay picks up a changed key | Automatic |

## Evidence

- Unit: `tests/unit/identity-piece1h-agent-key.test.ts` (middleware, bearerMatches, session env, fix auth, relay helpers, re-read backoff, no unguarded hashing of the key).
- Integration: `tests/integration/identity-piece1h-agent-key.test.ts`. E2E: `tests/e2e/identity-piece1h-agent-key-alive.test.ts`.
- Throwaway: see the PR.
