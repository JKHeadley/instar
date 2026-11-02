---
title: "Planned restart waits for an active local verification"
slug: "planned-restart-local-verify-hold"
author: "echo"
status: draft
date: 2026-11-01
parent-spec: "local-verify-merge-authority"
---

# Planned restart and local verification

## Observed failure

On 2026-11-01, two planned server restarts requested by Telegram repair work
interrupted the same PR #2525 verification at 04:48:26 and 04:57:57 UTC. The
local-verify audit records 302,324 and 480,567 milliseconds of discarded work.
The supervisor log names the requesters and says it initiated both restarts.
AutoUpdater's existing `LocalVerifyService.restartHolds()` protects update
restarts, but other writers of `state/restart-requested.json` do not consult it.
The foreground watcher also consumes that flag and can race the supervisor.

## Decision

Both restart consumers must defer a `plannedRestart: true` request while this
machine has a live local-verify child. The existing durable
`state/local-verify/inflight.json` is the cross-process signal. It is written
before the verifier child starts and cleared on completion. A positive child
PID must still exist; the short pre-spawn marker with a null PID is honored for
30 seconds. A marker or request older than three hours never defers. Unplanned or
emergency restarts are unchanged. The restart flag remains in place while
deferred, and the service starts no new verify while a planned restart waits.

The request's one-hour expiry must not silently lose a planned restart
that waited for verification. When a consumer actually defers the request,
it atomically records a marker keyed to that exact request. Only a matching
deferred request remains deliverable for four hours from `requestedAt`: at most
three hours of hold plus one hour for the supervisor to consume it. The verifier
continues to pause new starts while that exact deferred request is deliverable.
A request that was already expired when the first live verify was observed
cannot gain this proof retroactively. A request
that was never deferred keeps its original one-hour expiry. Older expired
requests retain the existing discard behavior. The foreground watcher already acts on expired requests. This
bound prevents an old file from restarting the server days later. The hold
never certifies a partially completed verification; if the three-hour bound
is reached, restart proceeds and the existing interruption
and retry accounting applies.
An explicit `forceRestart` request records `bypassHolds: true` on the flag;
the cross-process guard honors that existing operator override. The updater
also sets it when its own four-hour hold ceiling is reached, avoiding an
accidental second three-hour deferral. The verifier still pauses new starts
while that request waits to be consumed.

## Safety and verification

- Unit: active child, completed child, null-PID startup, stale/invalid marker,
  expired request, and unplanned request; supervisor and foreground consumers.
- Integration: an active service writes the marker, a planned request remains
  pending, the service pauses the next verify, then the request is consumed
  after the run ends.
- E2E: production wiring with an isolated server and a real child verifies the
  request is not consumed during the run and is consumed after completion.

No configuration or agent-installed file changes. The deferred-request proof
is a small machine-local sidecar file; its key is replaced by the next deferred
request and an unmatched key has no effect. The behavior reaches existing
agents through the package update. Rollback is a code revert.
