# Slack Inbound Recovery Robustness — Side Effects

## Runtime Changes

- A Socket Mode connection with no inbound event for five minutes is rotated
  through the existing reconnect/backoff path.
- Forced reconnects now notify the adapter of the disconnect, enabling its
  existing missed-message recovery after the new socket connects.
- Startup and reconnect recovery deduplicate thread routing keys to raw Slack
  channel IDs before history requests.

## External Effects

- Idle Slack installations may call `apps.connections.open` more often: at most
  once per five-minute silent interval, further bounded by existing backoff.
- Recovery may issue one `conversations.history` request per raw channel with a
  recent session.
- No user message is sent by the connection rotation itself.

## Rollback

Reverting the two Slack source changes restores the prior heartbeat and recovery
behavior. No stored-state migration or cleanup is required.
