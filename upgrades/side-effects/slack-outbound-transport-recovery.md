# Side-effects Review — Slack outbound transport recovery

## Class review

The missing standard was transport recovery after interface changes: retrying the same undici pool was not evidence of a fresh network path. The process gap was no focused fault-injection check for repeated `fetch failed` across a Wi-Fi transition.

## Decision

The client keeps normal API retry behavior. On three consecutive network fetch failures it destroys and replaces the global undici dispatcher; successful calls clear the streak.

## Evidence

- Tier 1 focused Socket Mode reconnect suite: 17/17 passing.
- ELI16: stale sockets are thrown away after three failed tries; the next try gets a fresh network path.
