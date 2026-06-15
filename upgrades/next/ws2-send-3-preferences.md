# Upgrade Guide — WS2-SEND-3: preferences send-side replication (completes ACT-922)

<!-- bump: patch -->

## What Changed

The `preferences` store is now wired into the WS2 send-side — the LAST of the 7 replicated
stores. Unlike the others, `preferences` had no emit seam (it rode the deprecated
`preferences-sync` verb), so this authors one on `PreferencesManager` (a
`setReplicationEmitter` + a best-effort emitPut at the end of `recordPreference`) and plumbs
the journal emitter to the correction-loop's PreferencesManager (the sole writer) through the
existing RouteContext replication channel. `ws2SendWiring`'s PENDING set now holds only
`userRegistry` (its own increment, WS2-SEND-2b). PUT-ONLY (recordPreference upserts on
dedupeKey; no delete path). Dark by default (`multiMachine.stateSync.preferences`).

## What to Tell Your User

- **What I've learned about how you like to work now travels across machines**: "When you
  correct me the same way enough times, I save it as a durable preference. If you run me on
  more than one machine, a preference I learn on one now applies on the others — so I don't
  have to re-learn 'lead with the action' separately per machine. Only the preference text +
  how confident I am crosses; a preference that arrives from another machine is advisory, not
  a hard rule. It stays off until you turn on multi-machine sync." ⚗️ Experimental — ships
  dark.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Cross-machine replication of learned preferences (dedupeKey-keyed) | Automatic once multi-machine preference sync is enabled (off by default) |
| Same preference (same dedupeKey) on two machines collapses to one record | Automatic (read path) |
| An upsert re-recording the same preference re-replicates the refreshed learning and confidence | Automatic (record-preference path) |

## Evidence

Verified by a two-instance in-process E2E
(`tests/e2e/ws2-preferences-cross-instance.test.ts`): a preference recorded on instance A is
read back on B through the bypass-proof union reader as a foreign-origin record (dedupeKey-
keyed); and an upsert (same dedupeKey, refreshed learning + raised confidence) re-replicates
the latest record, over the real journal serve/apply path. `tsc --noEmit` clean; the new e2e
(2) passes; the existing `PreferencesReplicatedStore` (22) + `PreferencesManager-replication`
(6) unit suites stay green with the authored seam; the `ws2-send-wiring` integration ratchet
(4) accepts the PENDING→WIRED move.
