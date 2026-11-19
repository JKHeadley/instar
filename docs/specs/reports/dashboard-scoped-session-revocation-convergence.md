# Convergence Report — Dashboard scoped-session revocation completeness (SEC-044 + SEC-045)

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass (codex `gpt-6-astra`) ran in rounds 4, 5 and 6 and materially shaped the design — it found the HIGH chain-shadowing hole in the idempotency window (round 3→4), the consumed-token endpoint-wiring gap, the stream-pruning-only-on-issue gap, and the anchor-loss-on-eviction gap. Internal Claude reviewers + the live Standards-Conformance Gate (constitution, 98 standards) ran every round.

## ELI10 Overview

The dashboard scoped-session feature (shipped dark in #3214) replaced the dashboard's permanent master key with short-lived, revocable passes grouped into a "family" per unlock. Two bugs made the *revocation* side hollow: rotating your PIN didn't end active passes, and once a thief refreshed a stolen pass your own logout silently did nothing. This change makes revocation actually work — before the feature is ever turned on.

What it took seven rounds to get right was the *reuse-detection* logic. The naive "remember the spent pass and hand its replacement back on a retry" idea (round 1–3) turned out to be a security hole, not a kindness: it would hand the live pass to whoever re-presents the old one, letting a thief ride your rotation chain forever undetected. So the design switched to the strict, industry-standard model (the same "refresh-token rotation" banks and identity providers use): *any* reuse of a spent pass ends the whole family and asks for a fresh PIN. The cost is a rare re-PIN if your own browser's refresh reply gets lost on the network — cheap, versus leaving a stolen session alive.

The rest of the rounds hardened the plumbing: a consumed pass has to reach the logout logic instead of being rejected as "not logged in" first; every way a pass leaves the store (spent, expired, evicted) has to leave a tombstone so logout still works; the number of families and their tombstones is bounded so memory can't blow up; and a family's streams close at its deadline on a timer *and* on the stream's next message, not only when someone next unlocks.

## Original vs Converged

- **Originally** the fix added an "idempotency window": remember the successor a refresh minted, and if the old pass is presented again while that successor is still live, hand the successor back (to spare a lost-network retry). **After review** that was removed entirely — it was a chain-shadowing hole. The converged design is strict: any reuse of a consumed pass ends the family (standard refresh-token rotation), and the rare lost-ACK retry is accepted as one re-PIN, declared explicitly under Verify-the-State.
- **Originally** tombstones were bounded by an oldest-first count eviction. **After review** that was shown to evict exactly the owner's revocation anchor (the oldest entry) — recreating the very bug being fixed. The converged design prunes by family deadline, tombstones on *every* removal while a family lives, bounds the family count, and uses a per-family cap that contains the offending family (never a global "heaviest" that could evict an innocent).
- **Originally** PIN-rotation-revokes-all + the revoke-all endpoint were the whole story. **After review** the converged design names the endpoint wiring (a consumed pass must bypass the live-only auth check to reach the logout logic), scopes the control to "this agent" (not a fleet-wide "everywhere" it can't deliver), and enforces deadlines on a timer plus per-delivery.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | constitution-gate, internal (6 lenses) | 2 (tombstone cap flaw; multi-machine overpromise) | — | tombstone reframed; control scoped |
| 2 | gate, internal-F1..F6 | 4 (lost-ACK false positive; time-bound retention; rate-limit; +5th case) | F5,F6 | idempotent-retry window; 5-way refresh; mint rate-limit |
| 3 | gate, codex | 1 gate (floor basis) | — | count-cap replaces rate-limit |
| 4 | gate, codex | 4 (HIGH chain-shadow; HIGH prune; 2 MED) | — | STRICT reuse (window removed); wiring; prune-closes-streams |
| 5 | gate, codex | 3 (HIGH prune-timer; 2 MED anchor-loss/aggregate) | — | store-lifecycle invariants (tombstone-on-every-removal; family-count bound; scheduled prune) |
| 6 | gate, codex | 1 MED (prune-tick timing) | — | per-delivery liveness check + wording |
| 7 | gate | 0 design (1 persistent judgment re-contest) | cap-derivation; multi-machine | converged |

## Proportion

⚠ 7 rounds on what began as a Tier-1 change. Justified: the change is auth/session-revocation with subtle reuse-detection + stream-lifecycle semantics — genuinely Tier-2 depth (re-tiered mid-review). Every round through 6 found a REAL build-changing finding (two HIGH security holes among them), so no round was polish; the review stopped the moment findings stopped changing the build. ~70 spec lines, the fix touches ~2 files + tests.

## Left behind

- **Tombstone/family cap derivation (gate, Judgment Within Floors, every round).** The `8 × maxTokens` per-family cap and `maxTokens` family-count ceiling are flat, config-tunable memory backstops, not values derived from a measured resource budget. Accepted: they are NOT security-load-bearing (strict reuse-detection already stops attacker accumulation; the caps only bound a pathologically-reconnecting *legitimate* client), the sole cost on breach is one re-PIN, and for a dark feature a generous flat ceiling that contains the offending family is the proportionate engineering choice. A measured-budget derivation is a possible later tuning, not a build blocker.
- **Fleet-wide revoke (gate, Multi-Machine, rounds 4–6).** The explicit revoke-all control is machine-scoped. Accepted: the fleet-wide eviction path already exists (PIN rotation fans out via PIN replication; each machine's `syncDashboardPinVersion` fires its own `revokeAll()`), and the live session tokens genuinely cannot replicate across machines. A dedicated cross-machine revoke RPC is deliberately out of scope for a dark completeness fix.

## Full Findings Catalog

- **R1 gate — Judgment/tombstone-cap (DESIGN):** oldest-first eviction evicts the owner's anchor → reframed to reuse-detection + time-bound retention.
- **R1 gate — Multi-Machine (DESIGN):** "sign out everywhere" overpromises → relabeled "this agent"; PIN rotation named as the fleet-wide path.
- **R1 internal F1 (DESIGN, med):** lost-ACK retry would be punished → (initially) idempotency window; (later) removed, declared as accepted re-PIN.
- **R1 internal F2/F3 (DESIGN, med):** oldest-first eviction + no rate-limit → time-bound retention; (later) per-family cap + family-count bound.
- **R1 internal F4 (DESIGN, med):** control overpromise → scoped + named.
- **R1 internal F5/F6 (PRECISION):** dead `consumedAtMs`; unnamed wiring → both resolved in the converged store-lifecycle + wiring sections.
- **R2 codex (MED):** 5th refresh case (successor expired/evicted) → explicit handling; later subsumed by strict model.
- **R4 codex (HIGH):** idempotency window lets a thief shadow the rotation chain → window REMOVED; strict reuse detection.
- **R4 codex (HIGH):** consumed token fails live-only `verify()` → endpoint wiring named (refresh/logout bypass the live-token check).
- **R4 codex (MED):** global evict-heaviest punishes innocents → per-family cap contains the offender.
- **R4 codex (MED):** mint-then-budget-check returns a revoked token → check before mint.
- **R5 codex (HIGH):** prune only on `issue()` → scheduled periodic prune.
- **R5 codex (MED):** per-family cap doesn't bound aggregate → family-count bound.
- **R5 codex (MED):** unconsumed expired/evicted token loses anchor → tombstone on EVERY live-map removal while the family lives.
- **R6 codex + gate (MED):** 60s prune tick doesn't meet "no later than deadline" → per-delivery liveness check + wording.

## Convergence verdict

Converged at round 7. The final round's only finding is a persistent judgment re-contest of a justified, non-security-load-bearing memory backstop (Left behind); no finding changes what gets built, and `## Open questions` is empty. The two HIGH security holes found mid-review (chain-shadowing; prune-on-issue) are both closed. Spec is ready for review and approval.
