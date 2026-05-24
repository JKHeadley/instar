# Instar Upgrade Guide — vNEXT (Threadline relay robustness)

<!-- bump: patch -->

## What Changed

Two reliability fixes to agent-to-agent Threadline messaging. Both made cross-agent sends fail in confusing ways for *every* agent that relied on the defaults.

### Fix 1 — honest send errors (no more misleading "Missing required fields")

The MCP `threadline_send` tool routes through `sendMessageViaHttp`, which POSTs to `/threadline/relay-send`. That route already attempts local same-machine delivery first, then falls back to the cloud relay — so when the relay is down *and* the target isn't a co-located agent, it correctly returns `503 "Relay not connected and local delivery unavailable"`.

But the helper then *ignored* that honest 503 and fell through to a SECOND POST to `/messages/send` with a threadline-shaped body `{targetAgent, message, …}`. `/messages/send` expects an inter-agent envelope `{from, to, type, priority, subject, body}`, so it rejected the request with `400 "Missing required fields: from, to, type, priority, subject, body"`. Agents (and operators) saw a cryptic schema error instead of the real cause ("relay's down / target unreachable").

Since `/threadline/relay-send` already does local-first delivery, that fallback was both **broken and redundant**. It's removed. The helper now surfaces the relay-send result verbatim — success, `404 agent-not-found`, or the honest `503`. It also forwards the previously-dropped `originTopicId` (THREAD-TOPIC-LINKAGE). The HTTP helpers were extracted from `mcp-stdio-entry.ts` into a testable `src/threadline/mcp-http-client.ts`.

### Fix 2 — single source of truth for the deployed relay URL

The default relay URL was duplicated across ~10 call sites. Some used the live `wss://threadline-relay.fly.dev/v1/connect`; others still used a dead `wss://relay.threadline.dev/v1/connect` host (DNS SERVFAIL). The dead default was the fallback in:

- `mcp-stdio-entry.ts` (registry client connection),
- `client/ThreadlineClient.ts` (relay client default),
- the `instar listener` DNS preflight (`commands/listener.ts`), which therefore *always* reported a false "Cannot resolve … check network".

Any agent that didn't explicitly set `threadline.relayUrl` silently connected to a host that no longer exists. New `src/threadline/constants.ts` exports `DEFAULT_RELAY_URL` + `DEFAULT_RELAY_HOST`; every call site now imports it. `grep -r "relay.threadline.dev" src/` is now empty.

## What to Tell Your User

Talking to other agents is more reliable, and when it fails it tells you the truth. Before, if the relay was offline and you messaged an agent that wasn't on your machine, you'd get a baffling "missing required fields" error that pointed nowhere. Now you get the real reason — "relay not connected" — so you (or I) can actually fix it. The deeper one: the address some code used for the agent relay had gone stale (it pointed at a server that no longer answers), so any agent leaning on the default couldn't reach the network at all. There's now one correct address used everywhere. No action needed on your end.

## Summary of New Capabilities

- **Honest Threadline send errors** — `threadline_send` surfaces the real relay-send outcome (including the honest 503 "relay not connected") instead of masking it behind a misleading 400 from the wrong endpoint.
- **Single source of truth for the relay URL** — `src/threadline/constants.ts` (`DEFAULT_RELAY_URL` / `DEFAULT_RELAY_HOST`); the dead `relay.threadline.dev` default is gone from every code path, including the `instar listener` DNS preflight.
- **`originTopicId` forwarded** — the MCP send helper now forwards the originating Telegram topic to `/threadline/relay-send` (was silently dropped).

## Evidence

- **Reproduction**: with the relay client disconnected and no local target, the OLD helper POSTed a threadline-shaped body to `/messages/send` → `400 "Missing required fields: from, to, type, priority, subject, body"`. Confirmed live in the field report (topic 12304) and by code trace.
- **Verified fixed** — `tests/integration/threadline/relay-send-honest-error.test.ts` (2 tests): the real `/threadline/relay-send` route returns `503` with the honest message, and the real `sendMessageViaHttp` helper surfaces it verbatim while a request-path recorder proves `/messages/send` is **never** called.
- **Regression guard** — `tests/integration/threadline/relay-send-local-roundtrip.test.ts` (1 test): co-located delivery still round-trips end-to-end through the fixed helper (`deliveryPath: "local"`).
- **Unit** — `tests/unit/threadline/mcp-stdio-send-path.test.ts` (8 tests): honest-error surfacing, success mapping, 404, 200-with-success:false, network error, `originTopicId` forwarding, non-JSON body; plus the relay-URL constant guard (`DEFAULT_RELAY_URL` === fly.dev, never the dead host).
- **No regression**: full threadline unit + integration + MCP e2e sweep = 212 tests green; `grep -r "relay.threadline.dev" src/` returns zero hits; `npm run build` clean.

## Rollback

Two commits, fully isolated to Threadline. Revert the `src/threadline/constants.ts` introduction (call sites fall back to inline literals) and restore the `/messages/send` fallback block in `mcp-stdio-entry.ts`. No schema, migration, or config changes.
