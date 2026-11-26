# Side-effects review — pool dials report rope health (arm (b))

**Change:** `src/server/poolPeerFetch.ts` becomes the one place a pool-scope read dials a
peer, reporting each outcome into the existing `PeerEndpointResolver`. 15 fan-out sites in
`routes.ts` converted off bare `fetch`; `recordRopeResult` wired `server.ts` →
`AgentServer` → `RouteContext` from the SAME `meshResolver` the lease transport feeds.

**Spec:** `docs/specs/peer-credential-guard-tailscale-coherence.md` §3.4(b) + its 2026-10-22
addendum. Arm (a) shipped in #2286; this is the half that spec claimed in the present tense
and did not contain.

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

**Nothing is rejected.** The helper makes no admission decision: the caller still runs
`isPeerUrlAllowedForCredentials` before dialling, unchanged and in the same place. The helper
cannot refuse a dial, cannot admit a host the guard rejected, and has no verdict to return.

The nearest thing to an over-block risk is *over-demotion* — recording a failure that is not
the rope's fault, pushing a healthy rope down the order. Two deliberate choices bound it:

- **Any `Response` records success, 500 included.** The rope carried the traffic; the
  application disagreed. Had I recorded HTTP status as rope health, every peer that 503s a
  dark feature (most of them, most of the time) would have demoted its own healthy rope.
- **A `last-known-url` records nothing.** It carries no rope identity, so an outcome on it
  cannot be attributed to a transport without guessing. Not recording is the honest option.

Residual: a per-request `AbortSignal.timeout` that is too tight for a slow-but-working rope
records a failure. That was already true of the lease transport, which feeds the same map, so
this adds volume to an existing behaviour rather than a new failure mode. The demotion is also
not permanent (see §8).

## 2. Under-block — what failure modes does this still miss?

- **A rope that is dead for only *this* caller.** Health is keyed per (peer, kind, url) and is
  machine-local, so one machine's view of a rope does not inform another's. Correct — a LAN
  rope dead from one subnet may be fine from another — but it means each machine pays its own
  first failure to learn.
- **The dial at `routes.ts:9939`** resolves a bare URL with `kind: 'last-known-url'` and is
  deliberately left as a plain `fetch`. Nothing is learned there. Attributing its outcome to a
  rope would be invention.
- **A peer that answers wrongly rather than not at all** (returns 200 with garbage) counts as a
  rope success. Correct for rope health; detecting bad *content* is not this layer's job.
- **First-dial cost is not removed.** Selection still picks the highest-priority admissible
  rope before any evidence exists, so the first read after a rope dies still fails. This makes
  the system converge; it does not make it clairvoyant.

## 3. Level-of-abstraction fit

Right layer, and specifically *not* a new one. The alternative was a second health store owned
by the pool path — two sources of truth that could disagree about the same rope, with no rule
for which wins. Instead this feeds the ONE authority (`PeerEndpointResolver`) that the lease
transport (`HttpLeaseTransport.hedge`) and the recovery prober (`RopeRecoveryProber`) already
write to, so pool traffic, lease traffic and probe traffic all improve the same map.

A smarter gate already exists and this feeds it rather than running parallel to it.

## 4. Signal vs authority compliance (`docs/signal-vs-authority.md`)

**Compliant — this is a signal producer with no blocking authority.** It observes an outcome
and reports it. The resolver remains the authority over ordering; the credential guard remains
the authority over admission. The helper cannot block, delay, rewrite or veto anything, and
its recording is best-effort (`record?.(...)`) — an absent recorder degrades to today's
behaviour exactly, which is why `?? undefined` is threaded rather than asserted.

The logic is also deliberately *not* brittle-with-authority: the one judgement it makes
(Response ⇒ ok, throw ⇒ fail) is a transport-level fact, not a heuristic about meaning.

## 5. Interactions

- **Lease transport:** writes the same map for the same peers. Additive — more evidence about
  the same ropes. No key collision: the same (peer, kind, url) triple is intended to be shared.
- **Recovery prober (U4.3):** its job is to re-probe ropes this change may demote. They
  compose: pool traffic demotes, the prober restores. Without feedback the prober had little to
  recover *from* on the pool path.
- **Subnet gate:** removes a peer LAN address on an unshared subnet before selection, so on a
  different-subnet reader there is no LAN rope to demote. That is why this change is an
  improvement rather than the fix for the reported symptom (addendum records the measurement).
- **No double-fire:** one dial, one record, in a `try`/`catch` that cannot do both.
- **No race with cleanup:** `evictStale` drops health for endpoints no longer advertised; a
  record written for a still-advertised endpoint is unaffected.

## 6. External surfaces

No route, response shape, config key or user-visible string changes. No new egress: the same
hosts are dialled with the same credentials by the same code path. The only observable
difference is *which* already-admissible rope gets chosen after a failure, and a changed
`ropeHealth` block in authenticated `GET /health`.

Timing dependence: yes, inherently — convergence needs the resolver's failure threshold
(`unhealthyAfterFailures: 3`) and probe backoff to elapse. That is the existing contract this
rides, not a new one.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** Rope health answers "can *I* reach that rope from here," which is
a property of the reader's network position, not a fact about the peer. Replicating it would be
actively wrong: the Mac Studio's LAN rope is healthy from the Mac Mini on the same subnet and
dead from the WSL box, and a replicated record would teach each machine the other's falsehood.
This matches the existing posture of the resolver's health map and candidate ordering, which
`peer-credential-guard-tailscale-coherence.md` already records as machine-local by design with
the same key.

No user-facing notice (nothing to one-voice gate). No durable state to strand on topic
transfer — the map is in-memory and rebuilt from traffic. No generated URLs.

Single-machine agents are a strict no-op: `_recordRopeResult` is assigned only inside the mesh
block, so it stays null and every dial behaves byte-for-byte as before.

## 8. Rollback cost

**Low, and no state to repair.** Three options in increasing size:

1. Pass `recordRopeResult: undefined` at the AgentServer construction — every dial reverts to
   today's behaviour while keeping the helper's URL composition. One line.
2. Revert the commit. The helper is additive and the 15 call-site conversions are mechanical
   (`poolPeerFetch(ctx.recordRopeResult ?? undefined, p, path, init)` ⇄ `fetch(url, init)`).
3. No migration, no data repair, no agent-state surgery: the health map is in-memory and
   regenerated from traffic, so a rollback is forgotten within one poll cycle.

The demotion is also self-limiting without any rollback — `recordResult(ok: true)` restores a
rope, and the recovery prober already does that unprompted.

## Second pass

**Not required by the Phase 5 list.** This change makes no block/allow decision on inbound or
outbound messaging or dispatch, touches no session lifecycle path (spawn/restart/kill/recovery),
no compaction or context-exhaustion path, and no coherence gate, idempotency check or trust
level. It is a signal producer feeding an existing authority, which is the shape Phase 5 exists
to protect rather than the shape it polices.

Recorded as `--second-pass not-required` rather than silently omitted.
