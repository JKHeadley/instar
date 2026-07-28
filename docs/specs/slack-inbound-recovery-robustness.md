# Slack Inbound Recovery Robustness

## Problem

Slack thread sessions are persisted under routing keys shaped like
`<channel-id>:<thread-ts>`. Startup and reconnect recovery treated those keys as
raw Slack channel IDs and passed them to `conversations.history`, which Slack
rejects with `channel_not_found`.

Socket Mode also treated a successful send of undocumented `{"type":"ping"}`
JSON as proof that inbound delivery was healthy. Slack ignores that payload, so
a half-open connection could accept local writes while delivering no events.

## Contract

1. Any session routing key must be reduced to its raw channel ID before it is
   passed to a Slack channel API.
2. Multiple channel-root and thread checkpoints for one channel produce one
   history request, starting at the oldest checkpoint.
3. Five minutes without any Socket Mode event bounds a potentially half-open
   connection: the client records a disconnect and rotates the socket.
4. Recording the disconnect is mandatory because the next successful connection
   uses that timestamp to recover the latest authorized user message missed
   during the blind window.
5. Recovery remains bounded to one replayed user message per raw channel.

## Safety and Failure Behavior

- No new Slack scopes, endpoints, credentials, or message payloads are added.
- Reconnection uses the existing `apps.connections.open` flow and existing
  exponential backoff.
- Stale socket events remain protected by the existing epoch and socket-identity
  guards.
- Recovery ignores bot messages, unsupported subtypes, and unauthorized users as
  before.

## Verification

- Unit coverage proves composite thread keys never reach `conversations.history`.
- Unit coverage proves checkpoints are deduplicated by raw channel and the
  oldest timestamp wins.
- A timer-driven unit test proves dead silence rotates the connection without
  sending arbitrary JSON.
- Existing reconnect, socket-leak, and thread-routing suites remain green.
