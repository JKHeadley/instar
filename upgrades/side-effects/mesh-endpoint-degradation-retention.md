# Side-effects review — mesh endpoint degradation retention (invariant 2b)

**Change:** `PeerEndpointRecorder.record()` no longer lets a non-empty but DEGRADED peer
advertisement discard a rope this machine's own health record currently shows alive.
Wired in `server.ts` from `meshResolver.snapshot()`.

**Origin (live incident, 2026-08-29, topic 62395):** a peer whose agent runs inside WSL
can only see an unreachable virtual NIC (`eth0 172.22.96.135`); Tailscale lives on the
Windows host, outside that VM. It advertised `[lan]` alone; the recorder replaced
`[tailscale, lan]`, and the mesh lost its only working route to that machine — while the
tailscale rope was verifiably carrying traffic at that moment (peer answered
`/health` 200 and a signed mesh probe returned the typed `not-router` refusal).

## 1. Over-block — what legitimate input does this now reject?

None: the change never rejects an advertisement. Every advertised kind is still recorded
verbatim and still wins for its own kind (covered by the "re-advertising a kind with a new
url still wins" and "advertised kind actually changed" tests). The only behavioural delta
is ADDITIVE retention of an omitted kind.

The nearest thing to an over-block is over-RETENTION: keeping a rope the peer meant to
retire. Bounded three ways — retention requires a positive `alive === true`; `false` and
`undefined` (never dialled) both drop; and the resolver remains the dial-time authority,
so a retained rope that stops working is marked dead and then dropped on the next
degraded advertisement.

## 2. Under-block — what does this still miss?

It does NOT help when the proven rope is ALSO not currently alive in the health record at
the moment the degraded advertisement lands (a machine that reboots into WSL-only
visibility while its tailscale rope happens to be marked dead). That case needs the
peer to be able to advertise an address it cannot locally see, which is the separate
NAT'd-machine work — tracked, not deferred silently:
<!-- tracked: CMT-211 -->

It also does not fix the root cause for that machine: a WSL-hosted agent still cannot
discover its own reachable address. This change stops the DATA LOSS, not the blindness.

## 3. Level-of-abstraction fit

Correct layer. `PeerEndpointRecorder` is the documented single chokepoint for "I just
learned a peer's ropes" and already owns invariants 1–5, including the sibling
absence-is-never-a-wipe rule. Invariant 2b is the same class of protection (an
advertisement must not destroy knowledge) and belongs beside it, not in the two
callsites. Nothing lower (the validator) knows current state; nothing higher (the routes)
should own merge policy.

## 4. Signal vs authority compliance

Compliant. The recorder produces/persists a SIGNAL (the known endpoint set); it holds no
blocking authority. `PeerEndpointResolver` remains the dial-time authority and already
deprioritises-but-probes dead ropes, so a retained-but-stale endpoint cannot block or
misroute anything — it can only be tried last. The new dep is a read-only evidence
source; an exception from it is caught and degrades to the previous behaviour.

## 5. Interactions

- **Invariant 4 (idempotency):** preserved and explicitly tested — when the merged set
  equals what is stored (the common steady-state case), the write is still skipped, so
  this does not reintroduce the ~720 no-op rewrites/day the idempotency guard removed.
- **Invariant 2 (absence):** untouched; the empty/invalid path returns before the merge.
- **Invariant 5 (advisory):** untouched; only the peer's own entry is written.
- **`MeshEndpointValidator` cap:** the merge appends retained entries AFTER validation of
  the advertised set. A peer at the kind cap cannot exceed it, because retention only
  adds kinds the advertisement did NOT name and there are three kinds total.
- **No double-fire / no race added:** the merge is pure and synchronous inside the
  existing single write path.

## 6. External surfaces

No route, config key, schema, or user-visible surface changes. `GET /health →
multiMachine.syncStatus` and `GET /pool` may now show a peer retaining a rope kind they
would previously have lost — which is the intended correction. Timing dependence is
limited to reading a live snapshot, and the failure mode of that read is explicitly
"no evidence ⇒ previous behaviour".

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** The retention decision is made from the RECEIVING machine's
own rope-health record and written only into its own registry copy. This is deliberate
and load-bearing: rope health is inherently per-observer (machine A's tailscale rope to C
can be alive while B's is dead), so replicating the decision would let one machine's view
overwrite another's ground truth. Each machine independently reaches the correct answer
from its own evidence. No replication path is added and none is wanted. A single-machine
agent has no peers and is a strict no-op.

## 8. Rollback cost

Trivial and total. Remove the `isEndpointAlive` dep from the `server.ts` construction and
the recorder falls back — by an explicitly-tested path ("with NO health dep wired,
behaviour is byte-identical to plain replace") — to the exact pre-change semantics. No
data migration: the registry format is unchanged, and a retained endpoint is an ordinary
entry the next advertisement can overwrite. No agent state repair.

## Tests

- Unit (`tests/unit/PeerEndpointRecorder.test.ts`, +8): retain-on-alive, drop-on-dead,
  drop-on-no-evidence, drop-on-throw, advertised-kind-upgrade-wins, idempotent-merge,
  no-dep-is-identical. Verified RED against pre-2b behaviour (3 failures for the right
  reason: the retention cases) and GREEN after.
- Integration (`tests/integration/mesh-endpoint-propagation.test.ts`, +2): the real
  `/api/lease` route with a real registry — a degraded advertisement keeps a live rope,
  and still drops a dead one.
- E2E: not applicable — no new API route or feature-liveness surface; the change is a
  merge rule inside an existing chokepoint already covered end-to-end by the integration
  route test.
