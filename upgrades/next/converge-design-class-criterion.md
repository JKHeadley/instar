# Upgrade Guide — vNEXT

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

`/spec-converge`'s first convergence criterion terminated on "no MATERIAL new issues", where material
was defined as *any finding that would require a spec change if unaddressed*. A contract-precision or
naming finding DOES require a spec edit, so it counted — and because a spec appends its own review
history each round, its reviewable surface grows every round and a diligent reviewer always finds
precision to add on a larger surface.

The loop was therefore unterminating BY CONSTRUCTION for that document shape, and the 10-round cap
fired for reasons unrelated to design soundness.

The criterion is now "no DESIGN-class findings for TWO consecutive rounds", with an explicit
taxonomy each reviewer DECLARES per finding: design-class changes what would be built or how it
behaves (including a statement that is factually wrong about the system); precision-class improves the
document without changing what would be built. Precision findings are still raised and still
addressed — they do not reset the counter. The comparator consumes the declared class rather than
re-deriving it, and emits per-round design/precision counts; the report template records both.

## Evidence

`standards-registry-ships-with-code` recorded 4–5 findings under a column headed "Material findings"
in every one of its ten rounds, while its own report observed that rounds 5–10 "produced no design
defects at all — they produced contract precision, naming, and scope-bound findings". A second spec on
the same problem hit the cap identically. Under the new rule that spec converges at round 7 on its
merits.

Criterion 2 (zero unresolved `## Open questions`) is untouched and still enforced structurally in
`write-convergence-tag.mjs`, so the structural half of convergence cannot be weakened by this change.

## Known limits

This relocates judgment rather than removing it: a reviewer that misfiles a design defect as precision
can end the loop early. Three bounds — the taxonomy names the factually-wrong case explicitly as
design-class, two consecutive quiet rounds are required rather than one, and the class is declared by
the raising reviewer and recorded per round so a suspiciously quiet round is visible. None of these is
a guarantee, and no code enforces the classification; this is an instruction change and binds only as
well as the reviewers follow it.

## What to Tell Your User

None — internal change (no user-facing surface).

## Summary of New Capabilities

None — internal change (no user-facing surface).
