# Upgrade Guide — WS2-SEND-2b: topicOperator send-side replication

<!-- bump: patch -->

## What Changed

The `topicOperator` store is now wired into the WS2 send-side (a PII kind; WS2-SEND-2b).
Its authoritative writer is the AgentServer's own `TopicOperatorStore`, so the generic
emitter (#1168) is attached to `server.getTopicOperatorStore()` right after the AgentServer
is constructed, and `topicOperator` flips PENDING→WIRED in the send-wiring ratchet. The
union reader + disclosure-minimized projection already shipped (WS2.6). PUT-ONLY by
construction — a topic rebinds, never unbinds. Dark by default
(`multiMachine.stateSync.topicOperator`). No new route/verb/config-default/migration.

## What to Tell Your User

- **Who-runs-which-topic now travels across machines**: "If you run me on more than one
  machine, the verified operator I bound for a topic on one machine is visible as advisory
  context on the others — so a topic's operator isn't re-learned from scratch per machine.
  Only the platform-verified identity crosses (the verified user id + display name) — a name
  that merely appears in a message can never become an operator. Crucially, a binding that
  arrives from another machine is treated as a HINT, never as the final word on 'who is my
  operator here' — only a binding I make locally from an authenticated sender is
  authoritative. It stays off until you ask me to turn on multi-machine sync." ⚗️
  Experimental — ships dark.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Cross-machine visibility of verified topic-operator bindings (advisory) | Automatic once `multiMachine.stateSync.topicOperator` is enabled (off by default) |
| Put-only by construction — a rebind supersedes by HLC; a topic never unbinds | Automatic |
| Know-Your-Principal preserved — a replicated record is never authoritative for inbound resolution | Automatic (local authenticated bind always wins) |

## Evidence

Verified by a two-instance in-process E2E
(`tests/e2e/ws2-topicoperator-cross-instance.test.ts`): a `setOperator` bind on instance A
is read back on B through the bypass-proof union reader as a foreign-origin record keyed on
(topicId + verified uid), carrying only the verified uid + lowercased names + platform; and
an idempotent re-bind with a later `boundAt` re-replicates the latest record (put-only —
there is no delete path). `tsc --noEmit` clean; the new e2e (2) passes; the ws2-send-wiring
integration ratchet (4) accepts the PENDING→WIRED move.
