# Side-Effects Review — WS1.1 dispatch-to-owner (the remaining pieces)

**Spec:** docs/specs/MULTI-MACHINE-SEAMLESSNESS-SPEC.md §WS1.1 (converged + approved, on main)
**Ground truth discovered during build:** the durable-queue merge (#1079) ALREADY
shipped WS1.1's receiver half — `createDeliverMessageHandler` (epoch fencing, durable
remote receipts via the queue store + message ledger, sender re-validation, the
owner-side accept bridge with working-set + topic-profile pulls) — and the router's
forward/queue verdicts. This change ships ONLY what was genuinely missing:

1. **Drain spawn-boundary ownership re-check** (`_ownershipReadForDrain`): route()'s
   verdict and the spawn are not atomic — ownership moving in that window produced
   the F20 double-spawn. A non-owner spawn now bounces to `un-routable
   ('ownership-moved-before-spawn')`; the entry re-queues and the next drain pass
   re-routes against fresh ownership. Direct-inject into an EXISTING live local
   session is deliberately not gated (a live local session is the strongest
   local-serving signal; its lifecycle belongs to the reconciler/closeout).
2. **`MachineCapacity.seamlessnessFlags` advertisement** (invariant 5): a bounded
   fixed-size summary (`ws11DeliverReceive`) self-reported each heartbeat from the
   LIVE queue handle; registry passthrough is live-observation-only (a peer going
   dark withdraws the capability — the safe direction). Absent = pre-spec peer or
   dark feature = non-participant.
3. **Sender-side skew gate** (`SessionRouter.ownerSupportsForward`): a LIVE owner
   that does not advertise durable receive is never forwarded to — the forward would
   501 → retry → failover-STEAL from a live machine (the worst skew outcome). The
   message waits in OUR durable queue (`'owner-lacks-ws11-receive'`), bounded by the
   queue's own shelf life and self-healing on the owner's next heartbeat after
   upgrade. Unknown (null) and absent-dep both preserve today's exact behavior.

## 1. Over-block
The skew gate can hold messages for a live-but-unflagged owner. Bounds: the queue's
existing shelf-life/loss-reporting (never silent), the flags flipping true on the
owner's next heartbeat after its queue enables, and ownership genuinely moving. The
alternative (forward → 501 → failover steal) takes a conversation from a healthy
machine — strictly worse. Unknown-capability peers are NOT held (null → forward),
so the gate cannot over-trigger from a missing signal.

## 2. Under-block
The drain re-check is a point-read — ownership can still move between the re-check
and the spawn completing (a narrower TOCTOU). The receipt + ledger dedup bound the
damage to one extra session at worst, which the post-transfer closeout reaps; full
elimination belongs to WS1.2's drain barrier. Named honestly, not silently claimed.

## 3. Level-of-abstraction fit
Each piece sits at its owning layer: the re-check at the spawn boundary (the only
place the race exists), the flags on the existing heartbeat carrier (no new channel),
the gate in the router's dispatch decision (beside isMachineAlive, the analogous
check). No parallel mechanisms.

## 4. Signal vs authority compliance
The skew gate holds narrow custody authority (queue vs forward) over a deterministic
signal (the peer's own self-advertisement on an authenticated heartbeat) and fails
open to today's behavior on unknown. The drain re-check removes a wrong action
(non-owner spawn) rather than adding authority. No message content, no user actions.

## 5. Interactions
- Composes with the queue's hold-for-stability: a gated message is an ordinary queued
  entry (same caps, same loss reporting, same drain re-routing).
- The existing receiver handler is untouched; the gate only prevents doomed sends.
- The reconciler (WS1.3, in CI) shortens how long ownership stays pointed at a
  machine that can't serve — the two compose toward faster convergence.
- OwnerSuspectBreaker semantics preserved: the gate fires BEFORE forwarding, so a
  flag-gated owner is never marked suspect for a 501 it never got to return.

## 6. External surfaces
A new optional heartbeat field (additive; older peers ignore it — the established
quotaState/guardPosture precedent). No new mesh verbs, no new routes.

## 7. Multi-machine posture (Cross-Machine Coherence)
This IS the multi-machine correctness core. Flags: replicated via the authenticated
heartbeat (named path), live-only by design. Gate + re-check: per-machine local
reads only on hot paths (spec rule). Phase C: the advertisement is fixed-size
regardless of pool size (never an inventory); the gate's per-owner read is O(1)
against the local registry; nothing assumes 2 machines or a LAN; headless VMs
advertise identically (no interactive step).

## 8. Rollback cost
All three pieces are inert without the pool/queue layer (which ships dark).
Flag-flip rollback: disabling the queue withdraws the self-advertisement on the next
heartbeat AND nulls `_inboundQueue` (the gate's information source degrades to
null → today's behavior). The heartbeat field is additive data — no migration, no
cleanup. Revert-and-release covers the code.

## Second-pass review
REQUIRED (inbound dispatch + ownership surface). Independent reviewer response
appended below.

<!-- second-pass reviewer response appended below by the independent reviewer -->

### Independent second-pass review (2026-06-12)

**Concur with the review.**

1. **Skew gate never marks a flag-gated owner suspect — verified.** In `SessionRouter.dispatchOne` (SessionRouter.ts:241-245) the `supports === false` branch returns a `queued` outcome and early-exits BEFORE `forwardToOwner`. `markOwnerSuspect` is only reachable inside `forwardToOwner` (line 306) and the owner-dead branch (249); the queue path touches neither. `tests/unit/SessionRouter.test.ts:276` asserts both `deliver` and `cas` are NOT called on the false case, structurally proving the gate fires first and no steal/suspect occurs. The artifact's §5 claim is true.

2. **Gate + queue cannot lose a message — verified safe.** When the gate fires and `queueMessage` returns `'refused'` (queue dark / storage fail), the router returns `acked: false`. At the ingress gate (server.ts:1970-1983) `isRemotelyHandled` is false and the custody short-circuit at 1978 requires `outcome.acked` true, so an un-acked `queued` falls through to local dispatch (line 2000+) — delivery, not a drop. This is exactly the spec's layered rule (invariant 5 line 96-97 "durable queue where available, else today's exact behavior"): the §3 queue path covers queue-available, the refused fall-through covers no-queue. The implementation satisfies BOTH the invariant-5 conservative-side clause and the §WS1.1 line-137 "local inject, never a drop" clause — no contradiction.

3. **Drain re-check placement is correct — verified.** server.ts:2200-2205 runs AFTER `route()` (2142) and AFTER the direct-inject path (which returns at 2184/2186), only on the spawn path, guarded by `_ownershipReadForDrain && _meshSelfId` (null on a dark/single-machine agent → skipped, invariant 6). It cannot block direct-inject (that path already returned) and runs strictly after route()'s now-stale-able ownership consult — the only place the TOCTOU exists. `tests/unit/ws11-dispatch-to-owner-wiring.test.ts:60-66` pins this ordering via source indices.

4. **`'un-routable'` re-queues, never drops — verified.** The new `ownership-moved-before-spawn` → `un-routable` disposition is handled in QueueDrainLoop.ts:731-736 via `releaseWithBackoff(row, attempts+1, …)` — release back to `queued` + backoff + attempts++, re-drained against fresh ownership next pass. The existing attempts-exhaustion path (648/661-663) reports loss loudly (`reportLoss`, terminal `attempts-exhausted`) rather than silently dropping — the bound is honest.

5. **Live-only flags passthrough genuinely clears — verified at the registry.** `recordHeartbeat` REPLACES the whole `obs` (MachinePoolRegistry.ts:205), and `assemble` reads `seamlessnessFlags: live?.obs.seamlessnessFlags` (273) with NO `postureStore`-style durable fallback (unlike `guardPosture`, which deliberately carries forward at 200/277-285). A flags-less heartbeat therefore nulls the field — confirmed by the real-registry test at ws11-dispatch-to-owner-wiring.test.ts:40-45. Self-advertisement is `!!_inboundQueue` (server.ts:12656), so a dark queue withdraws the capability next beat — the safe direction.

6. **"Receiver half already shipped" claim is true.** `createDeliverMessageHandler` (DeliverMessageHandler.ts:44-66) implements epoch fencing (50-53 → `stale-ownership`), sender re-validation BEFORE receipt (54-60 → `sender-rejected`), and idempotent durable receipt/dedupe (61-62 → `duplicate`). Wired at server.ts:12820-12844 with `ownerEpochOf`, `recordReceipt` (queue receipt + message ledger), and `validateSender` against THIS machine's UserManager. §2's residual-TOCTOU honesty holds — the point-read re-check narrows but does not eliminate the window; the receipt+ledger dedup bounds the damage to one extra session reaped by closeout, and full elimination is correctly deferred to WS1.2's drain barrier (not silently claimed as done).

Both relevant unit files run green locally (33 tests passed). No claim in the artifact was found untrue in code.
