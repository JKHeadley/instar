# The relay's A2A bridge keeps bounded state

<!-- bump: patch -->

## What Changed

SEC-134. In the public relay's A2A bridge (`src/threadline/relay/A2ABridge.ts`), the per-address rate-limit windows and the contextId-to-thread map never shrank, and the map was keyed by the bare contextId, so any caller who knew a contextId joined that thread. Now:
- `A2ABridgeRateLimiter` deletes a window once it is empty, never creates a key on a check alone, sweeps keys idle for an hour at most once a minute, and keeps at most 50,000 keys. The forwarded caller address is used only when it is a valid IP.
- `ContextThreadMapper` keys by caller address, agent and contextId, keeps at most 10,000 entries (least recently used dropped first), expires an entry 24 hours after its last use, and does not store messages without a contextId.
- A contextId that is not a string or is longer than 256 characters is refused with JSON-RPC error -32602.

This runs on the relay, so it takes effect when the relay is redeployed.

## What to Tell Your User

- **Relay hardening**: "The public relay now forgets old callers and old conversation names, so it cannot be made to run out of memory, and one caller can no longer join another caller's conversation."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Bounded, caller-scoped A2A bridge state on the relay | Automatic after the relay redeploy |

## Evidence

- `tests/unit/threadline/relay/A2ABridge.test.ts`: new cases for the limiter forgetting idle callers, the sweep keeping active limits, the key ceiling, checks not creating keys, the map's size cap and lifetime, unstored contextless messages, caller- and agent-scoped threads, continuity for the same caller, the forwarded-address fallback, and the contextId refusal. 32 pass.
