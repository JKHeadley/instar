## What Changed

**A tracking number that points at nothing is not tracking. Now the build says so.**

Our rule that a deferral without follow-through is a deletion has been enforced by a check that a spec containing deferral language carries a tracking marker. That check works and is unchanged.

But a marker is only worth what it refers to. The ids point into per-machine commitment and evolution-action registries — runtime state that lives on each agent's disk, not in the repository — so **no build has ever been able to resolve one**. It could only see that a number was present.

**Measured before designing anything: of 217 distinct tracked deferral ids across `docs/specs/`, 201 resolve to nothing anywhere in the repository.**

*(This paragraph published a superseded, smaller id population as a percentage until 2026-08-10, and the numerals are not restated here. That figure was superseded three times over — it measured a narrower id population through a character class a space terminates — and the guard's own header says of it, in as many words, "Do not quote either." This release note went on quoting it as its headline while the correction was recorded as complete, and **no review pass had ever examined `upgrades/next/`** — the one surface here that actually ships to a reader. Found by review pass 18. The percentage is not restated: the raw counts are the published form, for reasons given in the standard.)* For those, "tracked" was an unfalsifiable claim: precisely the deletion the rule forbids, wearing a badge that says otherwise.

A new lint now asks the different question — does this marker refer to something a reader can follow? A new unresolvable marker fails the build. The pre-existing population is recorded as a **shrink-only baseline**, because the change that discovers a debt cannot also pay it down.

**What it deliberately does not claim.** It cannot tell you the deferral was *kept*. An id mentioned in a test resolves here whether the work shipped, stalled, or was quietly dropped. Answering that needs the registries, which are outside the repository, and is not checkable by any build-time guard today. That gap is written into the standard with an expiry date rather than implied away by the new check's existence.

## What to Tell Your User

Nothing to do. If you write a deferral into a spec, the tracking id you attach now has to point at something in the repository — a spec section, a test, the code stub — rather than at a number only your machine can resolve.

## Summary of New Capabilities

None for the agent surface. This is a build-time guard on the repository's own specs.

## Evidence

- The measurement is reproducible by RUNNING THE GUARD — `node scripts/lint-deferral-referent-resolves.mjs`
  prints the population, the resolving count and the orphan count on every run. It is deliberately not
  restated here as a recipe: the previous wording described the RETIRED prose-id population that paragraph
  eleven of this same file disowns, and executing it returned 188/105/83 against the 217/16/201 published
  four lines above. A measurement whose reproduction instructions disagree with it is worse than one with
  none, and the guard cannot disagree with itself.
- Negative controls run before trusting it: a new orphan marker fails and names the id; the same marker with a referent in a **tracked** file passes; a deleted baseline refuses to report clean rather than passing vacuously.
- The resolving corpus is `git ls-files`, so an untracked file cannot resolve a marker — correct, since an uncommitted file is not something a reviewer can follow. Documented in the script after an injection test of mine failed for exactly this reason.
- Registry enforcement rose because this rule gained a real guard (the exact ratio is deliberately not
  quoted: `node scripts/standards-coverage.mjs` prints it, and the figure written here was from the
  87-article era while the registry is now 88); verified that the rise corresponds to something built rather than to a citation added.
