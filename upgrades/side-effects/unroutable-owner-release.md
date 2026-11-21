# Side-Effects Review — Unroutable-owner release

**Version / slug:** `unroutable-owner-release`
**Date:** `2026-11-20`
**Author:** `echo`
**Second-pass reviewer:** `independent internal reviewer subagent (spec-converge rounds) + codex-cli cross-model`

## Summary of the change

Tier 2 (ownership takeover authority). ~9 source/test files, ~700 LOC including tests. A topic whose recorded owner is revoked, or unregistered on a sane registry with a journal silent ≥ 6 h and 9 min of continuously observed absence, is now taken over by the lease holder: by the stale-owner engine (proactive; revoked owners even in dryRun), by the session router on inbound / drain retry / failed forward (reactive, every agent, one eligibility rule, refusal keeps custody), and by `POST /pool/transfer` (operator move; run-state confirmation kept). Spec converged in 6 rounds (Tier-2 cap) with two accepted risks recorded in the convergence report. Also fixes the U4.2 evidence-5 mirror lookup (`streams[machineId]` → `streams['<id>.<kind>']`). Spec: `docs/specs/unroutable-owner-release.md`. Incident: fb-b3d47791-3fb (2026-11-20 Studio rebuild; 47 Studio topics + ~200 on peers stranded).

## Decision-point inventory

- `assessOwnerRoutability` — new deterministic classification (revoked / unregistered-silent / routable); gates only recovery actions.
- Engine: unroutable → `expired`; only REVOKED-owner claims bypass dryRun (opt-out `unroutableOwnerLive`).
- Router: unroutable owner (lease holder + quorum for unregistered) → version-conditioned force-claim after `localPlacementAllowed`.
- Transfer: unroutable owner → force-claim to target (run-state confirmation unchanged).

## 1. Over-block

None added: the change only removes stuck states. Every fault reads as routable (today's path).

## 2. Under-block

- Revocation is not propagated between registries; a holder whose registry never knew the dead id needs the 6 h silence. During those 6 h the topic stays stuck as today (operator can still use /pool/transfer once the 6 h pass, or a peer whose registry marks it revoked takes over if it holds the lease).
- An unregistered id with NO journal evidence on the holder is never auto-claimed (by design — no positive evidence).

## 3. Level-of-abstraction fit

The shared predicate lives in one pure module consumed by the three existing actors (engine, router, transfer route) through their existing CAS funnels; no new actor or authority path is added.

## 4. Signal vs authority compliance

The predicate is a deterministic structural fact (registry standing, timestamps), not a content heuristic, and it only unlocks recovery through the existing ownership-epoch CAS. It fails toward the existing behaviour. Compliant with docs/signal-vs-authority.md.

## 4b. Judgment-point check

Not a competing-signals point: revocation is categorical; the unregistered rule's inputs form a closed set with a conservative default (spec Decision points table).

## 5. Interactions

- Engine: runs before the §2.2 bar; per-tick cap, per-topic replicated budget/backoff, declined-demote, fresh re-read unchanged.
- Router: shares `localPlacementAllowed` with the non-receiver takeover; existing `takeOverFromPeer`/routingOnly path untouched; inbound queue drains on the ownership transition (emitPlacement trigger).
- Transfer: the drain leg is skipped naturally (owner offline); pins set as before; the operator still answers the run-state confirmation.
- No session is started by an ownership move alone (engine claim path has no spawn seam; router acts only per real message) — tested.
- Mirror fix makes U4.2 evidence 5 stricter (refuses claims on owners still emitting) — fewer claims, never more. Earlier dry-run soak evidence never exercised evidence 5; noted in the spec.

## 6. External surfaces

Operator-visible: messages in such topics get answered; `/pool/transfer` returns `seatMoved:true` for them; `logs/stale-owner-release.jsonl` claim lines carry `unroutable-owner:<reason>`; server log line on router takeover. New config knob `staleOwnerRelease.unroutableOwnerLive` (default true). Awareness entry added.

## 6b. Operator-surface quality

No dashboard / approval surface touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

Unified/replicated: every takeover is an ownership CAS + coherence-journal placement entry, replicated to peers and adopted by their OwnershipAppliers (highest epoch). Only the lease holder claims. **Status surfaces:** `/pool/stale-owner-release` evidenceClasses gain `unroutable-revoked` / `unroutable-unregistered-silent`; `/pool/placement` reflects the moved owner.

## 8. Rollback cost

Revert the PR (no migration, no persisted format change). `unroutableOwnerLive: false` returns the engine to dryRun-only for these owners. Ownership records moved by a takeover stay moved (they point at a live machine; moving back to a dead id would be pointless).

## Conclusion

Ship. Closes three permanent dead ends found in the 2026-11-20 incident and one latent evidence bug, with every new path gated to the lease holder and failing toward today's behaviour.
