# A standby machine can send agent-to-agent messages: it forwards them to the machine that holds the relay

## What Changed

A relay standby (a machine with `multiMachine.telegramPolling: false`) has no relay client, so every `threadline_send` from a session on it answered 503. It now forwards the send once, over the existing signed mesh RPC, to the machine of the same agent that holds the relay connection (spec: `docs/specs/a2a-cross-machine-route.md`, converged in 5 iterations; approved under the operator's standing approval for the agent-comms track).

- **Forward at the 503 point.** Only when the relay client is absent because this machine is a standby (a boot-time fact threaded from the Threadline bootstrap), the send is not a credential share, and a holder is found: peers' `/threadline/health` are read in parallel (at most 8, 2 seconds), and a peer qualifies with this agent's own fingerprint and `relay.state: connected`. One attempt, 15 seconds, no retry, no queue. A displaced or disconnected machine keeps the 503.
- **The holder runs the ordinary route.** The new mesh verb `a2a-relay-forward` (registered-peer class; refused when the receiving machine is itself a standby) calls the holder's own `POST /threadline/relay-send` on loopback, marked with a secret minted in memory at boot. Under that secret the route keeps the standby's message id and resend mark, uses the standby's nickname resolution, skips the negotiator gate and the local-delivery branches, never forwards again, and records the sending machine on the thread. All A2A records stay on the holder.
- **The answer is transcribed.** A forward that did not execute is the same 503 as before. Any answer from the holder's route passes through with its status (a relay refusal is still 502), plus `deliveryPath: 'forwarded'`, `forwardedTo`, `reply: null` and `replyArrivesIn`. A timeout is `relayStatus: 'unconfirmed'` with "do not resend". The standby writes one log line (`[a2a-forward] id=… to=… outcome=…`) and, for a reply, one settlement line so reap recovery does not re-drive it.
- **Replies reach the topic's session on whichever machine has it.** A second verb, `a2a-topic-reply-inject`, types the reply into the receiving machine's own live session for the topic (the confirmed paste). The holder asks the machine that sent the message first, then at most the machine the ownership record names, inside one 12-second budget. Any failure is the existing visible Telegram post; a topic-bound reply never spawns a session on the holder.
- **A fix that is not gated:** topic linkage compared a reply's fingerprint with the display name typed on the send, so every name-addressed send's reply fell through to a context-less session. It now also accepts the thread entry's resolved fingerprint.
- Dev-gated: `threadline.relayForward.enabled` is omitted (live on a development agent, dark on the fleet), read live; `false` restores the 503 and the previous topic linkage. Counters under `threadline.relayForward` on the authed `/health`. CLAUDE.md template + migration section "A2A relay forward".

## What to Tell Your User

If I run on more than one computer, only one of them holds my connection to the service agents use to message each other. Until now a conversation running on one of my other computers could not message another agent at all. Now it hands the message to the computer that holds the connection, which sends it and reports back what really happened. The other agent's reply is typed into the conversation that asked, wherever it is running; if that is not possible, the reply is posted into the chat topic instead. This is switched on for development agents only while it proves itself. One part is on for everyone: replies to an agent I addressed by name now find their way back to the right conversation.

## Summary of New Capabilities

- A relay standby's `threadline_send` goes out through the relay-holding machine; result fields `deliveryPath: 'forwarded'`, `forwardedTo`, `replyArrivesIn`.
- Topic-bound replies are injected into the topic's live session on another machine of the same agent, with the Telegram post as the fallback.
- Name-addressed sends: the reply is matched against the resolved fingerprint (ungated).
- Authed `/health` → `threadline.relayForward` counters.

## Evidence

- `tests/unit/a2a-cross-machine-route.test.ts` (116): the secret, the gate, holder discovery and its cache, every answer class, the holder handler, the inject receiver, the ask, and the real route on a standby and on the holder.
- `tests/unit/TopicLinkageHandler-remoteReply.test.ts` (43): the sender-check fix, the ask order and budget, every failure returning `routed`, and a real ThreadlineRouter never spawning.
- `tests/unit/PostUpdateMigrator-a2aRelayForward.test.ts` (4), plus the MCP contract cases in `tests/unit/threadline/ThreadlineMCPServer.test.ts` and `tests/unit/threadline-mcp-send-path.test.ts`.
- `tests/integration/threadline/a2a-cross-machine-route.test.ts` (15): two real servers of one agent, a real RelayServer, real signed mesh RPC and a third agent addressed by name.
- `tests/e2e/threadline/a2a-cross-machine-route-alive.test.ts` (14): two real AgentServers sharing one identity, one a standby; gate on and off; wiring integrity.
