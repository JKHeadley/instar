# Side-Effects Review — Pool-stream connector observability + bounded mint

**Version / slug:** `pool-stream-connector-observability`
**Date:** `2026-06-07`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Adds an explicit 10s timeout to the requesting connector's pool-stream-ticket
mint (was unbounded → could hang silently) and per-step logging to both the
connector and the serving mint verb. Diagnostic + robustness for the live
cross-machine streaming path; found by live-verify (no output, no error,
no ticket minted on the peer).

## Decision-point inventory

One: bound the mint with a timeout (10s) so a wedge fails honestly →
peer-stream-lost/unreachable, instead of hanging the stream forever silently.

## 1. Over-block

A genuinely-slow mint (>10s) now fails where it might previously have eventually
succeeded — acceptable: 10s is far beyond a healthy mesh round-trip, and an
honest failure the user can retry beats an indefinite silent hang.

## 2. Under-block

Logging only observes; the timeout only bounds. No new gating.

## 3. Level-of-abstraction fit

The timeout uses the existing MeshRpcClient per-call `{ timeoutMs }` (the T1
mechanism). Logging matches the `[subsystem]` dim-log idiom used across the
mesh wiring.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

This REMOVES a silent-swallow (the connector previously hid every failure) —
moving toward the no-silent-fallbacks standard, not away.

## 5. Interactions

- PeerStreamProxy: a bounded mint failure now reliably reaches onClose →
  peer-stream-lost → bounded reconnect → machine-unreachable (the designed
  path, previously unreachable when the mint hung).
- No change to the serving endpoint, ticket store, or WSManager routing.

## 6. External surfaces

Log lines only. No route/config/notification change.
