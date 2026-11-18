# Side-Effects Review — Agent-started sessions placed by load (Step 1)

**Version / slug:** `agent-sessions-placed-by-load`
**Date:** `2026-11-17`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent review of the staged code (claude-opus-5-5): CONCUR, no blockers; its two should-fix items (a placement error must never stop a spawn answering; local starts must respect the name lock and the placement record) and two nits (reconciler under the name lock; 24 h hold from not-observed) are fixed in this commit`

## Summary of the change

Spec: `docs/specs/agent-sessions-placed-by-load.md` Step 1. New module `src/core/agentSessionPlacement.ts`: pure decision helpers (`selfLoadState`, `peerRoom`, `decideAgentSessionPlacement`), a durable placement store, and a service (shadow log, per-name lock, live placement, reconciliation on the pool tick). `POST /sessions/spawn` logs a shadow row for every spawn not marked `X-Instar-Placed`, and places opt-in (`placement: "auto"`) topicless requests. `GET /sessions/:name/output` proxies to the placed machine; `DELETE /sessions/:id` answers `409 placed-on-peer`. `/pool/heavy-work/spawn` adds `X-Instar-Placed: 1`. `heavyHeadroom`/`heavyFit` gain an optional `extraLoadPerCore`; `PlacementExecutor` gains an optional `extraLoadPerCore` seam read only by `score()`.

## Decision-point inventory

- `/sessions/spawn` start location for `placement:"auto"` topicless requests — add — arbiter `PlacementExecutor.decide` over pre-filtered peers.
- "This machine is busy" — add — shipped floors: verdict, `memoryPressured`, `HEAVY_WORK_FLOOR.maxLoadPerCore` with `LOAD_REPORT_MAX_AGE_MS`.
- Peer eligibility — add — online, not quota-blocked, not memory-short, headroom by weight.

## Proportion

Tier 2, 17 files (about 1,100 lines with tests); spec 6 review rounds; implementation one second-pass round; 2 commit attempts (first refused for a missing trace).

## 1. Over-block

None for existing callers: without `placement:"auto"` the start location is unchanged. An opt-in name with an unresolved placement is refused to be re-sent (409/202) by design; the caller uses a new name after checking the machine.

## 2. Under-block

Two origins placing the same name in the same seconds are not coordinated globally (accepted residual risk in the spec). A caller that ignores a 202 and re-sends after a short helper finished can run it twice (same as on one machine).

## 3. Level-of-abstraction fit

Decision and state in a core module; the route only wires I/O (peer URL at call time through `poolPeerFetch`, attention through Telegram).

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Numeric floors are the shipped, evidenced ones; the arbiter is the existing placement executor. The shadow log is signal only.

## 4b. Judgment-point check

See the spec's Decision points: each is a judgment-candidate on shipped floors; the shadow log is the re-tuning evidence.

## 4c. Self-action convergence (unbounded-self-action)

Declared `closure: n/a` in the trace. This is request-driven, not a self-triggered loop. Each hand-off is one caller's `POST /sessions/spawn`. It is never retried automatically: an ambiguous one answers 202, and nothing re-sends it. The pool-tick reconciler only reads peer session lists and raises at most one attention item per placement (the `told` flag). It never spawns, restarts, kills or re-sends.

## 5. Interactions

- Admission and session caps on the target still apply (its own `/sessions/spawn`).
- Heavy reservations are shared with the heavy route; the standard/light burst counter feeds only this route.
- Pool tick (`poolBeat`, 30 s) runs the reconciler; a no-op when the feature is off.

## 6. External surfaces

Peer-to-peer only: POST `/sessions/spawn`, GET `/sessions`, GET `/sessions/:name/output` on the operator's own paired machines with this agent's token.

## 6b. Operator-surface quality

One attention item per unconfirmed placement and one for a full placement record; plain words, names the machine and what to check.

## 7. Multi-machine posture

**unified decision** on whichever machine receives the request, from the pool's capacity heartbeats. The audit log and the placement record are per machine by design.
