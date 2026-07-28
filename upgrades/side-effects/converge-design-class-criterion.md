# Side-effects review — spec-converge terminates on design-class findings

**Change:** `/spec-converge`'s first convergence criterion changes from "no MATERIAL new issues"
(material = anything requiring a spec change) to "no DESIGN-class findings for TWO consecutive
rounds", with an explicit design/precision taxonomy that reviewers DECLARE per finding. The report
template records both counts per round.

**Decision point touched?** Yes, and it is the whole review: this is the stop criterion of the gate
that decides whether a spec may claim convergence — the tag `/instar-dev` requires before touching
instar source.

---

## 1. Over-block

Reduced, deliberately, and that is the point. The prior criterion over-blocked absolutely: on a spec
that appends its own review history the surface grows each round, a reviewer always finds precision
to add, and every such finding counted as material — so the loop could not terminate BY CONSTRUCTION.
Two specs hit the 10-round cap for reasons unrelated to design soundness.

## 2. Under-block

The real risk, stated plainly: **loosening what counts as terminating could let a spec converge with
an unaddressed design defect misfiled as precision.**

Three things bound it, none of which is "the reviewer will be careful":
- The taxonomy names the dangerous case EXPLICITLY — a statement that is factually WRONG about the
  system is design-class, never precision. That case is not hypothetical: round 10 of
  `standards-registry-ships-with-code` caught a false rollback claim, and under a careless taxonomy
  that would have been filed as wording.
- TWO consecutive quiet rounds, not one. A single quiet round is weak evidence on a growing surface.
- The class is DECLARED by the reviewer that raised the finding and the comparator consumes the
  declaration rather than re-deriving it from wording — so a misclassification is an explicit act
  recorded in the report, not an inference nobody can see.

Residual and unfixed: a reviewer that systematically under-classifies still ends the loop early. This
trades one judgment for a better-specified one; it does not eliminate judgment. Per-round counts in
the report are the detection surface, not a guarantee.

## 3. Level-of-abstraction fit

Correct. The defect is in the stop criterion's DEFINITION, which lives in the skill's prose and is
applied by the comparator, so the fix belongs in the prose plus the report template that makes it
auditable. No code enforces the classification today and none is added — an important honesty: this
is an instruction change, so it binds only as well as the reviewers follow it.

## 4. Signal vs authority compliance

The comparator retains exactly the authority it had (emit `converged: true|false`). What changes is
the definition it applies and the requirement that it consume a DECLARED class rather than infer one
— moving a judgment from implicit to explicit. No new blocking power anywhere.

## 5. Interactions

`write-convergence-tag.mjs` is untouched: criterion 2 (zero unresolved `## Open questions`) is still
enforced structurally there, so the STRUCTURAL half of convergence is unchanged and this change
cannot weaken it. The report template's Iteration Summary gains a column (design/precision split);
existing reports remain readable, and future ones carry the counts the new criterion depends on.

## 6. External surfaces

None. `/spec-converge` is an instar-development skill, not user-facing, not an endpoint, no config
key. The observable effect is that specs which would previously have hit the cap can now converge on
their merits — and that convergence reports show two counts where they showed one.

## 7. Multi-machine posture

Not applicable. This is repo-level skill prose plus a report template, identical on every checkout,
with no runtime state, no persistence, and nothing to replicate, proxy, or reconcile.

## 8. Rollback cost

Trivial: restore the previous criterion paragraph and the template's original column. No state, no
migration, no code. A rollback re-creates the unterminating loop, so it should carry a reason.
