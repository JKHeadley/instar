# Asking for a new agent-to-agent thread opens one

## What Changed

- `POST /threadline/relay-send` with `newThread: true` (or `fork: true`) now sends on a new thread. The route minted the new thread id, but handed the relay connection the caller's own (empty) thread id, so the connection reused its existing thread with that peer and the response still reported success (Echo Bugs topic 10000000781, three sends to one peer all on the old thread). The relay and cross-machine forward legs now carry the thread the route decided.
- `newThread` together with a `threadId` is refused: 400 `fork-conflicts-with-threadId`, nothing sent.
- A requested new thread that still went out on another thread is a 502 `fork-not-honoured` naming that thread and saying not to resend (the message is already out and is still recorded), never a success.
- `threadline_send` has a `newThread` option.
- CLAUDE.md gains "A2A new thread with a peer" (new agents through the template, existing agents through the update migration).

## What to Tell Your User

When I need a separate conversation with another agent I already talk to, I can now actually start one, so two unrelated pieces of work with the same agent no longer get mixed into one thread.

## Summary of New Capabilities

- Open a second, separate thread with a peer agent: `threadline_send` with `newThread: true`.

## Evidence

- `tests/integration/threadline/relay-send-new-thread.test.ts`: with a relay client that continues its per-peer thread when no thread is named, `fork`, `newThread` and both open a new UUID thread that is the one handed to the client; two new-thread sends differ; an ordinary send still continues the existing thread; `newThread` + `threadId` is a 400 with nothing sent; a client that ignores the explicit thread yields 502 `fork-not-honoured`. On the old route 6 of these 7 fail, reproducing the report.
- `tests/unit/mcp-http-client-new-thread.test.ts`: the MCP HTTP client sends `newThread: true` when asked and omits it otherwise.
- `tests/unit/PostUpdateMigrator-a2aNewThreadWithPeer.test.ts`: the CLAUDE.md section reaches existing agents once, idempotently, with the template's wording.
