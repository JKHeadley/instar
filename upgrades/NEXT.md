# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Threadline sends from Codex no longer duplicate after the delivery succeeds.**

The MCP `threadline_send` tool used to default `waitForReply` to `true`, which
meant a send could be accepted locally and then keep the MCP tool call open while
waiting for a peer reply. Codex's tool layer times out long-running MCP calls at
about 30 seconds, so an already-delivered send could be retried as if it had
failed. That produced identical Threadline replies 2-3 times, and each duplicate
also surfaced into the mirrored Telegram topic.

The MCP default now matches the HTTP relay behavior: omitted `waitForReply`
returns after delivery is accepted. Callers that intentionally need a synchronous
request/response flow can still set `waitForReply: true`; the existing reply
waiter and timeout semantics remain available for that explicit mode. The
Threadline interop spec now documents the same default so downstream
implementations do not preserve the old synchronous behavior accidentally.

## What to Tell Your User

When I message another agent through Threadline, my reply should now show up once
instead of sometimes repeating after a short delay. The underlying send path now
confirms delivery promptly by default, so the system no longer mistakes a slow
wait for a failed send and tries the same message again. Direct back-and-forth
agent collaboration should be quieter and less spammy in mirrored Telegram
topics.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Threadline delivery acknowledgement by default | Automatic for MCP `threadline_send` calls that omit `waitForReply` |
| Explicit synchronous Threadline replies | Set `waitForReply: true` when the caller really needs to wait for a reply |

## Evidence

- **Live reproduction:** Codey's own Threadline ACK to Echo was accepted by the
  local relay, then the MCP tool call stayed open and timed out at about 30
  seconds because the tool default waited for a reply. Prior log samples on the
  same Threadline path showed identical accepted sends separated by roughly the
  same retry-sized gap.
- **Verified fix shape:** the MCP schema default now passes `waitForReply:
  false` into the send dependency when the caller omits it, while tests that
  explicitly set `waitForReply: true` still exercise the synchronous reply path.
- **Tests:** `npm test -- tests/unit/threadline/ThreadlineMCPServer.test.ts`,
  `npm test -- tests/e2e/threadline/ThreadlineMCPE2E.test.ts`,
  `npm run lint`, and `npm run build` passed. Side-effects review:
  `upgrades/side-effects/threadline-codex-send-timeout.md`.
