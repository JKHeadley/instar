# Side effects: the relay takes the caller address only from its own proxy (SEC-139)

In plain words: the relay stops trusting the caller-written forwarding header, uses the header its own proxy sets, and forgets old per-address records.

Tier 1. Size: 5 source files (`clientAddress.ts` new, `RelayServer.ts`, `RelayRateLimiter.ts`, `A2ABridge.ts`, `types.ts`), `src/commands/relay.ts`, `fly.toml`; 2 new and 1 extended test files. Rebased onto main after SEC-134 (#3589) merged.

## What changes
- Caller address, everywhere in the relay (WebSocket connect, registry HTTP, A2A bridge): `resolveClientAddress(req, RELAY_CLIENT_IP_HEADER)`. No header named → socket address. Named header → its value when it is one valid IP (right-most entry for `x-forwarded-for`), else socket address. IPv4-mapped IPv6 folded to IPv4. Rate limits key IPv6 by its /64 network in one canonical form (callers sharing a /64 share a bucket, the usual practice, since one subscriber usually holds a whole /64). A2A thread scope (SEC-134) keeps the exact canonical address, so two hosts in one /64 never share a thread (`resolveClientAddressParts` returns both forms).
- **On Fly the setting is required.** Fly's proxy terminates connections, so the socket address is Fly's. `fly.toml` sets `RELAY_CLIENT_IP_HEADER = "fly-client-ip"`. If it were missing, every caller would share one address and the per-address limits would act as one global limit. A test checks `fly.toml` carries it.
- Fly's documentation describes `Fly-Client-IP` as the client address seen by Fly Proxy and recommends it; it does not state in writing that a client-supplied copy is replaced. That is verified on the live relay after deploy (below). If a forged value were honoured, the result is no worse than today.
- `RelayRateLimiter`: `check` reads without creating; emptied windows are deleted; a sweep at most once a minute drops keys idle over an hour; ceiling 100,000 keys; `record` moves a key to the end, so the ceiling drops the least recently used keys and never `global:min`. An active key or window is not dropped unless more than 100,000 other keys were used more recently. Limits unchanged. The A2A bridge limiter's ceiling (SEC-134) gets the same least-recently-used order.
- A2A bridge: one waiting task per thread. An agent reply resolves the waiting task of its thread, so a second caller in the same thread could otherwise receive the reply meant for the first. A second message in a thread whose reply is still awaited gets JSON-RPC -32005 (HTTP 409, "A message in this conversation is still waiting for its reply; try again when it has been answered") and is not forwarded. A client that sends one message at a time per conversation, the normal A2A pattern, sees no change. A caller whose connection closes before the reply frees its thread at once (task cleared, concurrency slot released), so a retry with the same contextId is not refused; otherwise the thread frees on the reply, the 5-minute timeout, a cancel or a failed delivery.
- Registry rate-limit maps (`registryRateLimits`, `registryAgentRateLimits`): expired entries swept at most once a minute; ceiling 50,000 per map, dropping the entries whose one-minute window started earliest (an entry moves to the end when its window restarts). Under a flood of more than 50,000 new addresses in a minute, an older caller's count can restart early; that is the cost of the fixed bound and needs more addresses than one caller can forge once the header is trusted only from the proxy.
- Self-hosted relays behind a proxy that relied on the old header reading now see the proxy address unless they set `RELAY_CLIENT_IP_HEADER`. Documented in the relay command header and the upgrade note.
- The deploy workflow's isolated smoke run has no proxy and no setting, so it keys by the socket address, as it should.

## Post-deploy verification (part of CMT-026, one deploy with SEC-134)
1. `GET /health` reports the merged revision in `buildRevision`.
2. From one machine, 21 `POST /a2a/<random hex>/messages` within a minute, each with a different forged `Fly-Client-IP` and `X-Forwarded-For`. Expected: the 21st answers 429 (all counted as one caller, A2A limit 20 a minute). A forged value that is honoured would never reach 429; that result means the header is spoofable and is reported to the Chief of Staff at once. Run it over IPv4 and, where the machine has IPv6, over IPv6 too. The probe only spends the tester's own one-minute bucket and changes no state.

## Multi-machine posture
Relay process memory only; machine-local by design (the relay runs as one instance, `max_machines_running = 1`).

## Signal vs authority
Input trust and resource bounds on existing rate limits. It refuses nothing new.

## Rollback
Revert and redeploy the relay. If `fly-client-ip` were ever absent, `RELAY_CLIENT_IP_HEADER = x-forwarded-for` (right-most entry) is a fallback, and it is only as safe as Fly appending its own entry to that header.

## Tests
- `clientAddress` (8), `RelayRateLimiter` (+4), `A2ABridge` (+3: two hosts in one /64 keep separate threads; a second waiting message in a thread is refused with 409 and allowed again after the reply; a disconnecting caller frees its thread for an immediate retry; two older tests now answer before sending again), `relay-registry-rate-bounded` (4), `A2ABridge` (32), `MessageRouter`, `SybilProtection`: all pass. The WebSocket and registry paths are covered by the shared helper's tests and a source-level wiring check, not by an end-to-end forged-header request.

## Second-pass review

**Reviewer:** independent Claude reviewer subagent, three rounds, each concurring. Round 1 notes: the limiter ceiling dropped by insertion order, so a flood could push out the global and per-agent windows; each IPv6 address was its own caller; doc overclaims and test gaps. Fixed: least-recently-used ceilings that never drop the global window, IPv6 rate keys by /64, docs reworded, tests added. Round 2 noted that /64 keying would also widen A2A thread scope; fixed by returning both forms (exact address for thread scope, /64 for rate limits) with a test that two hosts in one /64 keep separate threads. Round 3: concur, cosmetic notes applied.

Left as stated: no end-to-end forged-header test through the WebSocket or registry paths (helper tests plus a source wiring check cover them); whether Fly replaces a client-supplied Fly-Client-IP is confirmed by the post-deploy probe.

Round 4 (the one-waiting-message rule, added after the thread-join question from the Chief of Staff): concur. Its main note, that a caller who disconnected would be refused for up to 5 minutes on retry, is fixed by clearing the task when the caller's connection closes, with a test.

