# Upgrade Guide — WS2-SEND-2b: topic-operator send-side replication

<!-- bump: patch -->

## What Changed

The `topicOperator` store is now wired into the WS2 send-side — the first WS2-SEND-2b
store. Unlike the seamed-manager stores, its authoritative writer lives inside the
AgentServer (the topic-operator binding is established only from an authenticated sender),
so the replication emitter is plumbed into the AgentServer (a new optional dependency) and
attached to that canonical store, rather than to a loose manager object. The store already
fired its emit hook on every bind; this attaches the real emitter and flips topicOperator
PENDING→WIRED. Put-only by construction (a topic rebinds, never unbinds — a later bind
supersedes by HLC; no tombstone). Dark by default (`multiMachine.stateSync.topicOperator`).
No new route/verb/config-default/migration.

## What to Tell Your User

- **Which verified person runs a topic now travels between your machines (as advisory
  context)**: "If you run me on more than one machine, the verified operator I've bound to
  a topic on one machine now shows up as context on the others. Crucially, that crossed
  record is advisory only — it can never decide or override who I treat as the verified
  operator on another machine; only an authenticated message on that machine can do that.
  Only a privacy-minimized fingerprint crosses, never a name from a document. It stays off
  until you enable multi-machine sync." ⚗️ Experimental — ships dark.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Cross-machine visibility of topic-operator bindings (advisory; never overrides the local verified operator) | Automatic once `multiMachine.stateSync.topicOperator` is enabled (off by default) |
| Put-only supersede — a rebind replicates and the latest binding wins by HLC | Automatic |

## Evidence

A two-instance in-process E2E (`tests/e2e/ws2-topic-operator-cross-instance.test.ts`): a
binding established on instance A (`setOperator`) is read back on B through the bypass-proof
union reader as a foreign-origin record; a rebind of the same topic to a new operator
replicates as a fresh record (put-only supersede); the same binding (same topic+uid) on
both machines collapses to one record key across origins. `tsc --noEmit` clean (the new
AgentServer option flows correctly); the new e2e (3) + relationships e2e (3) pass; the
ws2-send-wiring integration ratchet (4) accepts the PENDING→WIRED move. Built on the merged
#1168–#1171.
