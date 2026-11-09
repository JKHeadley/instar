# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Telegram calls made through the server's single Bot API door (`telegramFetch` in `src/messaging/telegram-egress.ts`) work again on Node 26. That door hands Node's built-in `fetch` a connection pool (`dispatcher`) from the `undici` npm package (6.x) to lengthen the per-address connect wait. Node 26's built-in fetch bundles a newer undici that refuses that object with `TypeError: fetch failed`, cause `UND_ERR_INVALID_ARG` ("invalid onError method"), inside `Agent.dispatch`, before any connection opens. Every call through the door failed: an agent created on a machine whose system Node is 26 could not create its Attention, Updates or setup topics.

Now that one rejection is answered by sending the same request once with Node's default dispatcher, and the process remembers not to pass the package dispatcher again (one console warning says so). Any other error is unchanged, and a request whose body is a stream is never resent. On Node 24 nothing changes: the dispatcher is accepted and used as before.

## What to Tell Your User

If your agent runs on a computer with the newest Node version, its Telegram works again: it can open its own topics and setup conversations. Nothing to do on your side.

## Summary of New Capabilities

- Telegram works on Node 26: a refused connection pool falls back to Node's default instead of failing every call.

## Evidence

- `tests/unit/telegram-egress-dispatcher-rejection.test.ts` (4 tests): the dispatcher is still passed when accepted; the Node-26 rejection resends once without it and later calls skip it; a connection refusal is never resent; a stream body is never resent. The resend test fails on the unfixed code.
- `tests/unit/telegram-egress-boundary.test.ts` 51/51 unchanged.
- Found live on 2026-11-09: a new throwaway agent on the Mac Mini (Node 26.10.0 at /usr/local/bin/node) logged `Failed to create Agent Attention topic: TypeError: fetch failed`; the stack ends in undici 6.27 `Agent.dispatch` called from `node:internal/deps/undici`. The same snippet on Node 24.14.1 returns 200. Feedback fb-f5168dfd-cb6.
