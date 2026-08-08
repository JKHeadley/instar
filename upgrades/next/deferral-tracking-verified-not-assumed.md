## What Changed

**A tracking number that points at nothing is not tracking. Now the build says so.**

Our rule that a deferral without follow-through is a deletion has been enforced by a check that a spec containing deferral language carries a tracking marker. That check works and is unchanged.

But a marker is only worth what it refers to. The ids point into per-machine commitment and evolution-action registries — runtime state that lives on each agent's disk, not in the repository — so **no build has ever been able to resolve one**. It could only see that a number was present.

**Measured before designing anything: of 178 distinct tracked deferral ids across `docs/specs/`, 110 — 62% — resolve to nothing anywhere in the repository.** For those, "tracked" was an unfalsifiable claim: precisely the deletion the rule forbids, wearing a badge that says otherwise.

A new lint now asks the different question — does this marker refer to something a reader can follow? A new unresolvable marker fails the build. The pre-existing population is recorded as a **shrink-only baseline**, because the change that discovers a debt cannot also pay it down.

**What it deliberately does not claim.** It cannot tell you the deferral was *kept*. An id mentioned in a test resolves here whether the work shipped, stalled, or was quietly dropped. Answering that needs the registries, which are outside the repository, and is not checkable by any build-time guard today. That gap is written into the standard with an expiry date rather than implied away by the new check's existence.

## What to Tell Your User

Nothing to do. If you write a deferral into a spec, the tracking id you attach now has to point at something in the repository — a spec section, a test, the code stub — rather than at a number only your machine can resolve.

## Summary of New Capabilities

None for the agent surface. This is a build-time guard on the repository's own specs.

## Evidence

- The measurement is reproducible from the tree: distinct `CMT-`/`ACT-` ids in `docs/specs/` versus ids appearing anywhere outside `docs/` in tracked files.
- Negative controls run before trusting it: a new orphan marker fails and names the id; the same marker with a referent in a **tracked** file passes; a deleted baseline refuses to report clean rather than passing vacuously.
- The resolving corpus is `git ls-files`, so an untracked file cannot resolve a marker — correct, since an uncommitted file is not something a reviewer can follow. Documented in the script after an injection test of mine failed for exactly this reason.
- Registry enforcement moved 0.7356 → 0.7471 because this rule gained a real guard; verified that the rise corresponds to something built rather than to a citation added.
