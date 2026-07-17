# Side-Effects Review — Cross-machine transfer drain wiring

**Version / slug:** `cross-machine-transfer-drain-wiring`
**Date:** `2026-07-17`
**Author:** `instar-codey`
**Second-pass reviewer:** `independent high-risk review — CONCUR after one required-fix round`

## Summary of the change

Five gaps found in the live single-agent CROSS-MACHINE transfer family are
closed together:

1. The `_sendDrain` transport was constructed but omitted from the production
   `AgentServer` options, leaving `RouteContext.sendDrain` null outside injected
   route tests. Active remote owners therefore were never asked to release and
   claim the target.
2. A successful remote drain could land the target claim before the router's
   local replicated registry caught up. The route then returned
   `seatMoved:false` even though the move had completed. `SessionDrainRunner`
   now reports `claimLanded` from the actual fenced CAS; that proof crosses the
   signed mesh response and is accepted as direct completion evidence.
3. The holder evaluated autonomous-run consent using only its own state
   directory. When the current owner was remote, a no-confirm transfer could
   suspend that owner's live autonomous run. The holder now probes the current
   owner's authenticated run registry before planning and fails closed when it
   cannot verify the owner's state.
4. The remote sender dropped the owner's `autonomousRunSuspended` result, so a
   correctly suspended run was reported as not suspended. The result now
   propagates through the same signed response boundary.
5. A successful explicit transfer did not trigger the destination's working-set
   pull. The source state served correctly when fetched manually, but the
   canonical autonomous state never arrived automatically. A `seatMoved:true`
   transfer now kicks the target with bounded retries through ownership-
   replication lag: through the local coordinator or the remote target's
   authenticated fetch surface.
6. A transfer received by a non-holder returned immediately after proxying the
   holder's successful response. That bypassed the normal post-transfer acquire
   seam on the receiving destination. A holder-authored `seatMoved:true` proxy
   response now also kicks the reported target; the coordinator safely collapses
   redundant holder and destination kicks.

## Decision-point inventory

1. No drain sender or owner lacks WS12 capability: preserve the existing pin
   fallback; never fabricate completion.
2. Drain refuses, times out, loses its claim CAS, or aborts: `claimLanded` is
   absent/false and cannot make `seatMoved` true. Emergency-stop abort remains
   the existing 409/no-pin path.
3. Owner-side fenced target claim lands: the authenticated response carries
   `claimLanded:true`; transport and route boundaries additionally require
   `ok:true` plus `drained`/`drained-interrupted` before the router may report
   `seatMoved:true` ahead of its local echo.
4. Local registry already shows target active: existing completion proof still
   applies independently.
5. Intermediate transfer record arrives before the final claim replica: status
   may briefly show `transferring`, then monotonically converges to the higher
   active epoch; live proof observed that exact sequence.
6. A remote owner reports a live autonomous run: the no-confirm call returns
   409 before any drain; confirmation must echo the returned condition-bound
   challenge. Owner/epoch, target, run identity, or consent-detail drift yields
   a fresh 409 instead of consuming stale consent. If the owner run registry is
   unreachable or the preflight capability is absent, confirmation is required
   rather than silently assuming no run.
7. A completed non-noop move triggers exactly one bounded working-set acquire
   sequence; a failed or merely pinned move does not. Remote retries stop once
   the target schedules the pull or returns a terminal non-ownership reason.
   A pre-convergence `not-owner` result does not consume the reflex rate-limit
   window, so the next bounded attempt can succeed as soon as ownership lands.
8. A proxied move only arms the redundant destination acquire after an HTTP
   success carrying both `seatMoved:true` and a string `targetMachine`. Error,
   confirmation, and merely-pinned responses cannot trigger artifact movement.
9. The acquire retry window spans the observed journal/ownership convergence
   cadence (up to roughly one minute). Each attempt still performs the carrier's
   apply-time owner check; extending the window does not weaken fencing or permit
   bytes to land on a non-owner.

## Over-block / Under-block

Over-block risk is unchanged: capability absence or transport failure degrades
to the existing pending-pin path, and emergency stop vetoes the move. Under-
block risk is constrained by the fenced CAS itself. A generic `drained` status
does not prove movement—only `claimLanded:true` does. The runner deliberately
returns `claimLanded:false` when the claim CAS loses, even if the turn drained.
Inconsistent peer fields are clamped at both the RPC transport and final route
decision, so refused/non-completion responses cannot smuggle claim proof.

Emergency stop is checked throughout the boundary wait and again after the
awaited session termination, immediately before the target claim CAS. A stop
arriving during termination runs the existing fenced abort-transfer path and
cannot land the target claim.

The close of a missing local session can yield `close-skipped:no-local-session`
while still landing the target claim; this is valid for a quiet topic and is
surfaced in the drain reason rather than hidden.

## Level-of-abstraction fit / Signal vs authority

The production fix is at the composition boundary where an already-built
transport must enter `AgentServer`. The completion proof is emitted by
`SessionDrainRunner`, the component that executes the authoritative ownership
CAS. The router does not infer authority from reachability, liveness, or a
generic success status; it accepts only the authenticated owner's fenced-CAS
result.

**Reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

## External surfaces / Rollback

`POST /pool/transfer` may now include `drain.claimLanded`. `seatMoved` becomes
true immediately when the owner directly proves the target claim landed,
instead of waiting for local replication. No config, state schema, migration,
secret, or destructive data operation is introduced. Rollback removes the
composition wire and optional proof field; ownership records remain valid.
The holder also performs one bounded authenticated read of the remote owner's
existing `/autonomous/sessions` surface when ownership is remote.

## Evidence pointers

- `tests/unit/ws12-drain-wiring.test.ts` pins the production constructor wire.
- `tests/unit/SessionDrainRunner.test.ts` pins the successful CAS proof.
- `tests/integration/pool-placement-transfer-routes.test.ts` pins that a remote
  proof makes `seatMoved:true` while the injected router registry remains stale,
  and that a proxied successful response arms the destination carrier.
- 66/66 focused tests passed; `npm run build` and `npm run lint` passed. The added regressions
  cover an inconsistent failed response carrying `claimLanded:true` and an
  emergency stop that arrives during the awaited termination call.
- Live pre-fix: holder Laptop, owner Mini, target Laptop returned
  `seatMoved:false` with no drain. With only the wire, drain succeeded but the
  immediate response remained false during replication lag. Final candidate:
  holder Laptop, owner Laptop, target Mini returned `seatMoved:true`,
  `drain.ok:true`, `claimLanded:true`; both machines converged to Mini active at
  epoch 12.
- Filed live defect: `fb-d353b76b-053`.
- Filed live consent/telemetry defect: `fb-9cf3e4f1-13f`.
- Filed live working-set acquire-trigger defect: `fb-d0418f06-7f0`.
- Filed live proxied-acquire defect: `fb-c7992d34-3b9`.
- Independent review concurred after requiring the double claim-proof clamp and
  the post-termination emergency-stop recheck; no remaining concerns.
