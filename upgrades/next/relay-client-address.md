# The relay takes the caller address only from its own proxy

<!-- bump: patch -->

## What Changed

SEC-139. The relay derived every caller address from the first `x-forwarded-for` entry, which the caller writes, so per-address rate limits (sign-in attempts, messages, registry, A2A) could be bypassed by changing it on each request, and A2A thread scoping could be aimed at another caller's address. Now `resolveClientAddress` (`src/threadline/relay/clientAddress.ts`) is the single source for the WebSocket, registry and A2A paths: it trusts only the header named by `RELAY_CLIENT_IP_HEADER` (set to `fly-client-ip` in `fly.toml`), takes the right-most entry when that header is `x-forwarded-for`, requires a valid IP, folds IPv4-mapped IPv6, keys IPv6 callers by their /64 network for rate limits (one subscriber usually holds a whole /64) while A2A thread scope keeps the exact address, and otherwise uses the socket address. The relay's own per-address state is bounded too: `RelayRateLimiter` and the registry rate-limit maps delete idle keys (swept at most once a minute) and have hard ceilings: 100,000 keys for the rate limiter, dropping the least recently used first and never the global window, and 50,000 per registry map, dropping the entries whose window started earliest.

The A2A bridge also allows one waiting message per conversation, so an agent reply can only go to the caller that asked; a second message before the reply gets error -32005.

Self-hosted relays behind a proxy must set `RELAY_CLIENT_IP_HEADER` to the header their proxy sets; without it every caller shares the proxy's address.

## What to Tell Your User

- **Relay hardening**: "The public relay no longer believes a caller about its own address, so its speed limits can no longer be dodged by writing a fake one, and it cannot be made to fill its memory with fake callers."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Trusted caller-address header for the relay | Set `RELAY_CLIENT_IP_HEADER` for a relay behind a proxy (Fly: already set) |

## Evidence

- `tests/unit/threadline/relay/clientAddress.test.ts` (new, 8): the forwarded header is ignored unless named, the named header must be one valid IP, right-most `x-forwarded-for`, address folding, IPv6 keyed by /64.
- `tests/unit/threadline/relay/RelayRateLimiter.test.ts` (+4) and `relay-registry-rate-bounded.test.ts` (new, 4): idle keys forgotten without lifting active limits, key ceilings keep active keys and the global window, setting wired to the bridge, `fly.toml` names the header.
