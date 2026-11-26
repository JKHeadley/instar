# Side-Effects Review — a quiet standby does not connect to the Threadline relay

**Version / slug:** `threadline-relay-standby`
**Date:** `2026-10-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (one boolean gate on an opt-in connection, reusing an existing per-machine flag)`

## Summary of the change

instar#2122: "Both machines connected to the Threadline relay with the same identity and displaced each other. Disabled on the standby for now." The relay admits one connection per agent identity (the agent identity is shared across a multi-machine agent by design), so two machines of one agent knock each other off. `bootstrapThreadline` gains `relayStandby`; `server.ts` passes `!shouldOwnTelegramPoll(config)` — the SAME per-machine flag (`multiMachine.telegramPolling: false`) the lifeline already uses to keep a standby off the Telegram poll. A standby logs `relay connection SUPPRESSED (standby…)`, keeps MCP tools, local discovery and handshake, and never opens the relay socket. CLAUDE.md template + migration gain one awareness line so a standby agent explains "unreachable" correctly.

## Decision-point inventory

- Whether this machine opens the relay connection: `relayEnabled && !relayStandby`.

## 1. Over-block

A standby cannot be reached by peers over the relay; the awake machine answers for the agent (the Threadline Conversation Coherence model already says a conversation lives on one machine). Single-machine agents (flag absent) are unchanged. A standby that becomes awake needs a restart to connect — the same restart `telegramPolling` already requires.

## 2. Under-block

Lease-following (connect on acquire, disconnect on demote) would remove the restart; this ships the static rule Luna applied by hand, now structural. Two machines both configured as pollers still displace each other, as before.

## 3. Level-of-abstraction fit

The bootstrap owns the connection decision; the server supplies the machine role from the existing flag.

## 4. Signal vs authority compliance

No authority over messages; a connection gate.

## 4b. Judgment-point check

Not a competing-signals decision.

## 5. Interactions

`shouldOwnTelegramPoll` reads `multiMachine.telegramPolling` only (default true), so the gate is dark for every agent that has not set the standby flag. The listener daemon path (`daemonHandlingRelay`) is downstream of `relayEnabled` and so also stays off on a standby.

## 6. External surfaces

One boot log line on a standby; one CLAUDE.md bullet.

## 7. Multi-machine posture (Cross-Machine Coherence)

This change exists for multi-machine: one relay connection per agent, held by the awake machine. Machine-local by design (a socket is per machine).

## 8. Rollback cost

Revert; or set `multiMachine.telegramPolling` back to true on the standby.

## Conclusion

Makes structural what Luna did by hand on the Studio.
