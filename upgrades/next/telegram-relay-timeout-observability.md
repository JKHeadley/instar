# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**A moved conversation's reply no longer hangs silently when the other machine
is briefly unreachable.** When you move a conversation to another machine, that
machine relays its replies through the machine that holds the Telegram
connection. That relay had two operational defects, both found by driving the
multi-machine feature live: it had no time limit (so when the receiving machine's
connection was momentarily restarting, the reply hung for over a minute with no
result), and it failed completely silently (a dropped reply wrote nothing to the
log, so there was no way to tell why it didn't arrive).

The relay is now bounded and observable: it gives the receiving machine a fixed
window (15 seconds by default, adjustable) and then fails fast, and every failure
writes one clear line saying exactly what went wrong (no reachable machine, a
rejection with its status code, or a timeout). The relay logic was also extracted
into its own well-tested unit.

It also no longer reports a false success: previously the relay could report
"delivered" even when the message never actually reached the chat (it accepted a
response that carried no real message id). Now the receiving machine returns the
real message id and the relay only counts a reply as delivered when that id is
present — otherwise it's treated as undelivered and surfaced, so a busy or flaky
moment becomes a real, visible failure (and a retry candidate) instead of a
silent loss dressed up as success.

## What to Tell Your User

Nothing to configure. If you run across more than one machine and move a
conversation between them, a reply that can't be delivered now fails quickly with
a clear reason in the log, instead of hanging for over a minute and vanishing
without explanation. Single-machine setups are unaffected.

## Summary of New Capabilities

- `relayOutbound` (`src/core/TelegramRelay.ts`) — the tokenless-standby reply
  relay, extracted as a pure injectable unit with a bounded `AbortController`
  timeout and a log line on every failure path. `server.ts` wires
  `telegram.outboundRelay` to it. New optional `multiMachine.relayTimeoutMs`
  (default 15000).

## Evidence

- Reproduction (live, 2026-06-01): driving the multi-machine reply proof, a
  relayed reply hung 25s then 70s with no result and no log line; root cause was
  the holder's tunnel being mid-restart, and the relay `fetch` having no timeout.
  Once the tunnel was back, the relay completed (a tone-gate response and an `ok`
  came back through the full standby→holder chain), confirming the path itself
  works — but the hang + silence were real operational defects on the way there.
- Tests: `tests/unit/telegram-relay-timeout-observability.test.ts` (7) drive the
  real `relayOutbound` with an injected fetch + logger: 2xx returns messageId and
  posts the right URL + `Bearer` header; self-hold no-ops; no-peer-URL logs;
  non-2xx logs the status; **a hanging holder aborts within the timeout (elapsed
  under 2s) and logs `timeout after Nms`**; a network error logs its message; the
  `silent` flag passes through. 7/7 green; `tsc` clean.
