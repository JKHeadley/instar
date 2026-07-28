# Side-Effects Review — Mesh Endpoint HTTP Propagation

**Slug:** `mesh-endpoint-http-propagation`
**Spec:** `docs/specs/mesh-endpoint-http-propagation.md` (converged 3 rounds, approved)
**Author:** Echo (autonomous 24h mesh-robustness mission, topic 27515)
**Branch:** `echo/mesh-endpoint-propagation`
**Risk class:** safety-adjacent (touches lease reachability) — change is PURELY ADDITIVE.

## What changed (in-scope files)

- `src/core/MeshEndpointValidator.ts` (NEW) — shared per-kind ingest validation for an advertised peer endpoint set, using the SAME pure host helpers exported from `PeerEndpointResolver` so ingest (first line, no poisoning) and resolve (final line, no bypass) can never diverge. Integrity gate, NOT trust authority.
- `src/core/PeerEndpointRecorder.ts` (NEW) — single chokepoint that records a peer's advertised endpoints into THIS machine's registry: meshTransport-gated, absence-is-a-no-op (never a wipe), synchronous validation before storage, idempotent (skips unchanged writes), advisory-only (writes the peer's entry, never self).
- `src/core/HttpLeaseTransport.ts` (+37) — carries this machine's advertised endpoints in the signed lease RPC body (acquire/pull) and records the responder's endpoints out of a pull RESPONSE, bound to the cryptographically-verified responder identity.
- `src/server/machineRoutes.ts` (+34) — `/api/lease` and `/api/lease/pull` record the authenticated sender's/puller's endpoints via the recorder, after sender auth.
- `src/server/AgentServer.ts` (+13), `src/commands/server.ts` (+23) — wiring of the recorder + validator into the server/transport construction.

Propagation rides the **already-signed lease RPC body**, not the heartbeat (a spec-converge refinement): bidirectional and cryptographically signed for free, no new unauthenticated surface.

## Review

1. **Over-block** — None. The recorder never rejects a *machine*; it validates an *endpoint set* and on malformed/absent input keeps the peer's prior ropes (fail-closed to today's behavior). It cannot cause a peer to be treated as unreachable — worst case the peer's rope set stays {cloudflare}, exactly as today.

2. **Under-block** — A peer that never upgrades, or whose advertised set is fully invalid, still propagates nothing → the lease stays cloudflare-only for that peer (the pre-fix status quo). This is the intended degrade, not a regression. The fix cannot help a mesh where neither machine runs the new code; both sides must be ≥ this version for fast ropes to cross. Recorded as expected, not a gap.

3. **Level-of-abstraction fit** — Correct layer. Peer reachability is registry data; the recorder writes the registry, the resolver (existing authority) reads it at dial time. The fix sits exactly parallel to how `lastKnownUrl` already crosses at pairing — it does NOT invent a new reachability authority, it feeds the existing one. Validation reuses `PeerEndpointResolver`'s own host predicates so there is one source of truth for "what host shape is legal per kind."

4. **Signal vs authority compliance** — COMPLIANT. The validator is explicitly an integrity gate (no garbage stored), NOT a trust/blocking authority. `PeerEndpointResolver` remains the dial-time authority and re-validates the same rules + owns the health map that decides reachability. No brittle check was given blocking authority over any agent behavior. (Ref: `docs/signal-vs-authority.md`.)

5. **Interactions** — Idempotency guard prevents ~720 no-op registry rewrites/day on a stable 2-machine setup (would otherwise churn `lastSeen` + registry-dirty marks). It does NOT shadow the pairing-time `updateMachineUrl` path (that writes `lastKnownUrl`; this writes `endpoints` — disjoint fields). It cannot race split-brain logic: it only ENRICHES a peer's rope set, making the anti-split-brain self-fence MORE accurate (fewer false "no medium" trips), never weakening it. No double-fire (single chokepoint shared by both receiver routes and the puller).

6. **External surfaces** — No new route, no new unauthenticated input. Endpoints ride an existing authenticated+signed RPC body. The `/health` KINDS surface is unchanged (Decision 15 keeps raw IPs off `/health`; they were already in the registry model). Nothing new is visible to other users/agents. No new timing/conversation-state dependency.

7. **Multi-machine posture (Cross-Machine Coherence)** — This feature IS the multi-machine path. Posture: **replicated** — each machine's advertised endpoints replicate to the peer over the signed lease RPC channel (the named replication path). Machine-local registries converge via the recorder. No URL/notice surface touched (no one-voice or transfer-strand concern). This is the fix for the exact silent-single-machine-assumption class this question exists to catch: multi-transport-mesh-comms was inert on a git-less setup because endpoint replication silently assumed a git medium.

8. **Rollback cost** — Cheap. Purely additive + meshTransport-gated. Back-out = revert the PR (no data migration: the only persisted change is enriched `endpoints` fields in the registry, which the resolver already tolerates being empty). If a malformed-but-authenticated advertisement ever caused trouble, disabling `multiMachine.meshTransport` makes the recorder a no-op immediately (no restart-coupled migration).

## No-deferrals

No deferred work. The fix is complete: validator + recorder + both receiver routes + puller-response recording + wiring + all three test tiers (unit clamp/idempotency, integration `/api/lease` recording, e2e wiring that the resolver receives propagated endpoints) + the git-less-no-propagation regression. No orphan deferral language.

## Phase 5 — Second-pass review (independent reviewer)

**Concur with the review.** Independent reviewer audited the artifact against the actual code (lease-touching change) and verified all five risk questions with file:line evidence:

- Q1 Registry poisoning by an authenticated peer — SAFE. `MeshEndpointValidator` imports the SAME pure predicates the dial-time resolver uses (`hostOf`, `isForbiddenHost`, `isTailscaleCgnat`, `isRfc1918`, `isPublicHttps`); forbidden hosts (localhost/::1/0.0.0.0, 127/8, 169.254/16 incl. metadata 169.254.169.254, 0/8) rejected at ingest. Ingest = first line, resolve = final line, same functions — cannot diverge.
- Q2 Absence/empty/malformed = no-op, never a wipe — SAFE. `PeerEndpointRecorder.record` returns before `updateMachineEndpoints` on null/undefined/empty/fully-invalid; `[]` is not a clear-all signal.
- Q3 Cannot weaken anti-split-brain / fabricate a false "holds lease" — SAFE. The self-fence clears only on a CONFIRMED renewal (`tunnel.broadcast()` success / cryptographic `idOk` ack). A stale enriched rope can only produce a FAILED dial, never a forged ack — enrichment strictly improves confirming a real rope.
- Q4 Idempotent — SAFE. `meshEndpointsEqual` compares order-independently with URL normalization; skips the write + `lastSeen` bump + registry-dirty mark on unchanged sets.
- Q5 Gated on `multiMachine.meshTransport` — SAFE. First line of `record` is the gate; both receiver routes and the pull-response path funnel through the one gated chokepoint, bound to the authenticated/verified peer identity (never a self-asserted body field).

Non-blocking note (already disclosed in the spec as a tracked follow-up, not a defect): a genuine "I lost all ropes" clear cannot be signaled; stale ropes self-correct via resolver health demotion + the next non-empty advert.
