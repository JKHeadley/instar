---
slug: slack-outbound-transport-recovery
summary: Rebuild the Slack Web API HTTP transport after repeated network fetch failures so Wi-Fi changes do not strand outbound delivery on stale keep-alive sockets.
---

# Slack outbound transport recovery

## What changed

After three consecutive network-level `fetch failed` errors, the Slack API client replaces the undici dispatcher and retries through a fresh connection pool. Successful calls reset the failure streak.

## Verification

Tier 1 focused evidence: `tests/unit/slack-socket-reconnect.test.ts` — 17/17 passing. Slack API response and retry semantics are unchanged.

## User impact

After a laptop network change, outbound Slack delivery can recover without waiting for a server restart.
