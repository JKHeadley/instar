# Side-Effects Review — threadline_discover: live relay + trust surfacing

**Version / slug:** `threadline-discover-relay-and-trust`
**Date:** 2026-05-11
**Author:** echo (instar developer)
**Second-pass reviewer:** not required (no decision-point surface — see §4)

## Summary of the change

`threadline_discover` (MCP tool) had two data-accuracy bugs that caused agents on the same machine to misreport who is reachable on the network.

1. **`scope=network` returned the local cache** (`AgentDiscovery.loadKnownAgents()`) instead of querying the relay's live presence registry. Off-machine agents (like Dawn, on the public relay but not in any local file) were invisible to anyone using `scope=network`, even when the relay had them online.
2. **The sanitizer hardcoded `status: 'unverified'`** for every agent regardless of granted trust, so trusted agents looked indistinguishable from strangers.

Both are now fixed:

- `ThreadlineMCPDeps` gains an optional `relayClient: RelayDiscoverer | null` (minimal interface, decoupled from the concrete `ThreadlineClient`). When `scope === 'network'` and the relay client reports `connectionState === 'connected'`, the handler calls `relayClient.discover(filter)` and returns the live result with `source: 'relay'`. If the relay is disconnected or the query throws, the handler falls back to `loadKnownAgents()` and marks the response with `source: 'cache'` plus a `staleReason` string so consumers can detect stale data.
- A new HTTP route `POST /threadline/relay-discover` proxies the call from the MCP stdio subprocess (which has no relay client of its own) to the agent server's relay client — mirroring the existing `/threadline/relay-send` pattern.
- The discover sanitizer now looks up the trust profile by fingerprint then name (identical pattern to `threadline_agents` at lines 569–575) and adds `trustLevel` + `trustSource` to each entry, gated by the existing `isLocal || hasScope('threadline:admin')` rule.

Files touched:
- `src/threadline/ThreadlineMCPServer.ts` — `RelayDiscoverer` type, network-scope path, trust surfacing, `relayAgentToInfo` helper.
- `src/threadline/mcp-stdio-entry.ts` — `createHttpRelayDiscoverer` adapter wiring the MCP subprocess to the agent server.
- `src/server/routes.ts` — new `POST /threadline/relay-discover` route.
- `tests/unit/threadline/ThreadlineMCPServer.test.ts` — 5 new tests: cache marker on no-relay, relay path, disconnect fallback, throw fallback, trust surfacing.

## Decision-point inventory

This change touches no decision point. `threadline_discover` is a **read-only** tool — it answers "who is reachable?" It does not block, gate, or filter messages. It has no `block/allow/warn` surface.

- `threadline_discover` — pass-through — reads from relay (new) or local cache (existing); produces a list. No decisions are made on the basis of this list inside instar.

---

## 1. Over-block

**No block/allow surface — over-block not applicable.**

The tool reads and returns data. Consumers (the calling agent's reasoning) may decide what to do with the list, but that decision happens outside this code.

The closest analog to "over-block" is over-inclusion: could the relay return agents that shouldn't be shown? The relay protocol already filters by visibility (`public` agents only — `PresenceRegistry.ts:110` and the visibility logic in the relay server). This change passes that result through unchanged. No new exposure is created.

---

## 2. Under-block

**No block/allow surface — under-block not applicable.**

The closest analog is under-inclusion: could the relay path miss agents that should appear? Yes, by design — if the relay is disconnected, we fall back to the local cache and label the response `source: cache`. That is explicit and visible, not silent. The user-visible behavior shifts from "every network discover lies that the relay is the source" to "discover tells you which source it used."

---

## 3. Level-of-abstraction fit

This sits at exactly the right layer:

- **MCP tool layer** is the right place for the response shape (it's what callers consume).
- **HTTP route in `routes.ts`** is the right place for the relay-client proxy (the MCP subprocess can't directly hold a WebSocket; mirroring `/threadline/relay-send` keeps the pattern consistent).
- The **`RelayDiscoverer` interface** is intentionally minimal (only `connectionState` and `discover()`) so it doesn't force the MCP server to import `ThreadlineClient` types — keeps the test seam clean and avoids circular dependency risk.
- The **trust-profile lookup** is duplicated from `threadline_agents` rather than extracted into a helper. This is deliberate: the lookup is 4 lines and the two sites have slightly different visibility-gating logic (`threadline_agents` uses `requestContext.isLocal || hasScope`, this matches it). A helper would obscure that the two checks are independent. If a third call site appears, that's the right time to extract.

No higher-level gate already exists for "what trust level should be surfaced to a discover call." The visibility rule is local-or-admin, same as `threadline_agents`.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface.
- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The discover tool is a read-only data accessor. It does not block actions, gate information flow against agent intent, or filter messages by meaning. The `staleReason` field is purely informational; consumers may choose to ignore stale results, but that decision is outside this code. No brittle authority is added.

The only adjacent concern is honesty: the `trustLevel` field reports what the trust manager has on file. It does not invent or fabricate trust levels. If `getProfile(fingerprint)` returns `null`, no `trustLevel` field is emitted — consumers see absence, not a fabricated "unverified" string.

---

## 5. Interactions

- **Shadowing:** None. `threadline_discover` is a single-handler MCP tool. The local-scope path is unchanged. The new network-scope path replaces the previous cache-only behavior with cache-or-relay; the local cache fallback runs only when the relay can't.
- **Double-fire:** None. The relay's `discover` frame is a request/response pair; the relay-side rate limiting (already present in `RelayMetrics.ts`) applies. The new HTTP proxy route is called only by the MCP subprocess during a discover tool call — once per invocation.
- **Races:**
  - The `connectionState` getter on the HTTP relay-discoverer adapter re-reads `/threadline/status` on every call before issuing discover, so a recently-disconnected relay won't be queried with a stale "connected" reading.
  - There's a benign race between status-check and discover-call (relay could disconnect in the ~10ms gap). In that case `relayClient.discover()` resolves to `[]` (the existing `ThreadlineClient.discover` timeout-then-resolve-empty behavior is preserved). The handler treats `[]` as a valid empty result and returns `source: 'relay', count: 0` — honest about the source.
  - No shared mutable state between the route handler and the MCP server; both work off the same `ctx.threadlineRelayClient` reference.
- **Feedback loops:** None. The discover output is read-only; no downstream system writes back into it.

---

## 6. External surfaces

- **MCP tool response shape:** The `agents` array shape is unchanged (existing fields preserved). Two new fields added at the top level when `scope=network`: `source: 'relay' | 'cache'` and optional `staleReason`. Two new optional fields per agent: `trustLevel`, `trustSource` — only present when the caller has local-or-admin visibility and a trust profile exists. Pure additive change; no existing field is removed or repurposed.
- **HTTP API:** New `POST /threadline/relay-discover` endpoint. Mirrors `POST /threadline/relay-send` in its no-auth posture (both are intended only for the local MCP subprocess; the route lives on `localhost` and is not exposed through the tunnel). 503 returned cleanly when relay isn't connected.
- **Other agents:** No effect on outbound presence — this only changes how this agent QUERIES the relay registry, not how it ANNOUNCES itself.
- **Persistent state:** No new files, no schema changes. The existing `known-agents.json` cache is read on fallback (existing behavior); no writes added.
- **Timing:** New code path adds at most one HTTP round-trip (status check) + one WebSocket round-trip (discover) per network-scope call. Both are bounded by existing timeouts (`ThreadlineClient.discover` has a 10s ceiling).

---

## 7. Rollback cost

**Pure code change.** Revert the four edited files, ship a patch release. No persistent state introduced, no schema migration, no agent state repair, no user-visible regression during the rollback window. The previous behavior (stale cache for network scope) returns instantly on revert — it's a strict superset of the new behavior in that direction.

If only the route is buggy: revert just `routes.ts` and the MCP handler's fall-back-to-cache path still works (it returns cache with `source: cache, staleReason: 'relay query failed'`).

---

## Conclusion

This is a data-accuracy fix for a read-only MCP tool. No new decision points, no new authority, no new persistent state. The fix unblocks legitimate use cases (agents on the same machine asking "who is on the network right now") that were silently returning stale data and silently hiding trust levels. The response shape change is additive — existing consumers see no breakage. Second-pass review not required: no high-risk surface touched per `/instar-dev` §Phase 5.

---

## Evidence pointers

- Reproduction: prior to the fix, calling `threadline_discover {scope:"network"}` from `sagemind` on this machine returned 3 agents (the local cache) even though the relay reported 16 online agents globally; Dawn (on the public relay, not in any local file) was invisible.
- Verification: tests in `tests/unit/threadline/ThreadlineMCPServer.test.ts` cover the relay-path, disconnected-fallback, throw-fallback, no-relay-configured, and trust-surfacing cases. 43/43 in that file pass.
