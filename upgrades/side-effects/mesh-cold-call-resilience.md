# Side-Effects Review — Mesh cold-call resilience (live-matrix T1)

**Version / slug:** `mesh-cold-call-resilience`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Per-call `{ timeoutMs }` override on `MeshRpcClient.send` (default unchanged);
the working-set pull send uses 30s and the commitment-mutate forward 15s; the
working-set puller adds ONE bounded immediate re-send on transport failure.
Closes live-matrix finding T1: the 5s flat default was measured aborting the
first call over an idle tunnel three times in one afternoon, degrading pulls
and forwards to their minutes-later fallback paths.

## Decision-point inventory

Two: (1) which verbs get a longer budget — only the two measured-failing heavy
verbs; every other caller keeps the 5s default. (2) when the puller re-sends —
exactly once per verb call on a thrown transport error; a second consecutive
failure propagates.

## 1. Over-block

Nothing new is blocked. Longer timeouts only widen acceptance windows.

## 2. Under-block

A genuinely-down peer now takes up to 30s (pull) / 15s (forward) to be
declared unreachable instead of 5s, plus one re-send. Bounded worst-case added
latency before the fallback path engages: ~60s for a pull verb. The fallback
paths themselves (pending-pull ledger, queued mutation with opKey) are
unchanged and still catch everything.

## 3. Level-of-abstraction fit

The override lives at the client (per-call concern); the budgets live at the
call sites (caller knowledge of payload weight); the re-send lives in the
puller's existing retry funnel (`sendWithBusyRetry`) beside the busy-retry
policy it mirrors.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No authority added. Pure transport robustness; all refusal/queue semantics
unchanged.

## 5. Interactions

- Pending-pull ledger: strictly fewer entries (cold flakes masked); failure
  path identical.
- Queued commitment mutations: same — the ambiguous-outcome (B24) queue with
  same-opKey re-fire is untouched and still covers a timeout at 15s.
- Busy-retry: the re-send shares the loop but its budget is separate (one per
  verb call) — busy responses never consume the cold-retry and vice versa.
- P19 (No Unbounded Loops): the re-send is a single bounded attempt; tests
  assert two consecutive failures propagate.

## 6. External surfaces

None. No routes, no config, no notifications. Internal mesh transport only.
