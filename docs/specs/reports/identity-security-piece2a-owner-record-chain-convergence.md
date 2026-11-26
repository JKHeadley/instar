# Convergence Report — The owner record: a signed chain every machine computes the same way

**Spec:** [docs/specs/identity-security-piece2a-owner-record-chain.md](../identity-security-piece2a-owner-record-chain.md)
**Slug:** `identity-security-piece2a-owner-record-chain`
**Iterations:** 8: round 1, then seven delta checks, each probing the real code with the reviewer's attack scripts.

---

## ELI10 Overview

The owner record is a list of signed lines, saying which keys speak for the owner and the agent's settings. Every computer checks the signatures itself and works out the same answer, whatever order the lines arrived in. When lines conflict, the rules are cautious:
- taking a key away always counts;
- adding one waits until someone allowed settles the conflict;
- a stolen key can at worst cause a stand-off that the owner resolves with a reset, never a takeover.

## Original vs Converged

- **The first design** let machine keys do too much and checked authority only in each line's own past. A machine could go back to before the owner existed, and a stolen key could fork the record or take it over.
- **The reviews then tightened it step by step:**
  - machine powers cut to what the parent designs allow;
  - a pinned starting point;
  - a separation between the shape of the record and what each line achieves, so that undoing one line can't cut away everything built on it;
  - revocations and TLS keys that can never fork the record;
  - keys tracked per instance, so a re-added machine works.
- **A settled rule for revocations:** no evaluator can tell a thief's revocation from an honest one in general, so the record never guesses. A revoked key's entries count only before every revocation of it, and any exclusion resting only on revoked keys revoking each other is reported as `contested`, for the owner's reset.
- **Every attack the reviewer found** became a regression test.

## Iteration Summary

| Iteration | Design findings | Applied |
| --- | --- | --- |
| 1 | 7 (internal) + 8 (Astra, mostly other pieces) + 1 constitution flag | all in-scope findings |
| 2 | 5 (second pass reached past the chain) | structure versus effect |
| 3 | 2 (revocation forks; bound exhaustion) | side-entry revocations; 2b storage rule |
| 4 | 2 (backdating via self-supplied revocation; re-revocation spam) | every-revocation rule; already-revoked is soft |
| 5 | 1 (silent erasure via self-revocation) | own-line exclusion (later replaced) |
| 6 | 1 (own-line exclusion dropped honest revocations: takeover) | strict rule plus `contested` |
| 7 | 1 (silent downgrade by a revoked key outside the line) | settled-exclusion rule |
| 8 | 0 | converged |

## Full Findings Catalog

The answers are in the build state folder under `reviews/p2a-r1`. The reviewer's probe scripts are in the session scratchpad.

## Left behind

- Storage, bootstrap, mesh adoption, the storage rule and the minimum-build fence (2b).
- Device keys (piece 3).
- The owner's reset.
- Compaction of superseded TLS rotations.

## Convergence Verdict

Converged at iteration 8, against the threat model of owner-authentication §6: a takeover fails, a silent downgrade fails, and a visible forced reset is acceptable. Every probe (A to J) is a regression test. The spec carries `approved: true` under the approved umbrella. No constitution text changes.
