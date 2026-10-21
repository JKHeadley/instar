# Side-Effects Review — Classify POST /threadline/pairing/enable

## Summary of the change

`tests/unit/write-domain-conformance-ratchet.test.ts` (§3.5) was failing on `main`: `POST
/threadline/pairing/enable` arrived with the enable-without-restart work carrying no write-domain
declaration, and the ratchet's undeclared list may only shrink. One `reg.add` entry classifies it
`cluster-shared`, matching every other route in the pairing family.

## Decision-point inventory

- `buildWriteDomainRegistry()` — **add** — one route entry. Declarative metadata; no runtime branch.

## 1. Over-block

The registry describes where a route's writes live; it adds no refusal of its own. `cluster-shared`
is the stricter of the two candidate classifications, so if anything consults it for admission the
effect is conservative, never permissive.

## 2. Under-block

Could `cluster-shared` under-protect versus `machine-local`? No — it is the stricter claim. The
registry's own comment says `cluster-shared` is "the conservative default, with no machine-local
convergence claim to defend", and all 26 `machine-local` entries carry a `ConvergenceStory` while 0
do not. Claiming machine-local here would assert a convergence story this change neither needs nor
can defend, so the conservative sibling classification is correct.

## 3. Level-of-abstraction fit

The alternatives were annotating the route `@write-domain:none` or adding it to the TODO-classify
baseline. `none` is false — the route writes config flags and a state file. The baseline may only
shrink, so adding to it is forbidden by the ratchet itself. Classifying is the only correct option.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

## 4b. Judgment-point check (Judgment Within Floors standard)

None added. The entry is a literal.

## 5. Interactions

- **Shadowing:** the new `pathPrefix` is `/threadline/pairing/enable`; no sibling pattern matches it
  (`/threadline/pairing/:peerFp/start` requires a `/start` suffix) and it shadows no existing entry.
- **Double-fire / races / feedback loops:** none — the registry is built once and read.

## 6. External surfaces

None. No operator-facing action, no network, no persisted state of its own, no timing dependence.
Nothing requiring a phone-completable surface.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface added or touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

This change is *about* multi-machine posture: it records that the route's writes are shared across
machines rather than local to one. It adds no replication and no lease interaction of its own.

## 8. Rollback cost

Delete the entry. The only consequence is the ratchet going red again.

## Conclusion

Proceed. Declarative, conservative, and it restores a red safety check to green.

## Second-pass review (if required)

Not required — Tier 1 (8 LOC, one file, no decision point; the gate's classifier computed
`suggestedTier=1`, `riskFloor=1`).

## Evidence pointers

- Before: `× RATCHET … expected [ Array(1) ] to deeply equal []` naming
  `"POST /threadline/pairing/enable (routes.ts:19157)"`.
- After: `tests/unit/write-domain-conformance-ratchet.test.ts` 6/6 pass.
- The route region is byte-identical between this branch and `origin/main`, confirming the failure
  originated on main (with PR #2248) and is not a regression from this branch's own work.

## Class-Closure Declaration (display-only mirror)

The class is "mutating routes with no write-domain declaration". The ratchet enumerates that class
exhaustively on every run, and after this change its undeclared list is empty — so the class is
closed by the check itself, not by inspection.
