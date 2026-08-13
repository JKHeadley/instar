# Side-effects review — the merge model (ruling 4a re-ruled)

**Change.** The operator re-ruled 4a from *archive* to *MERGE*. The 25 superseded standards stay LIVE
as named subsections of their parents. Source surface: two closed classification lists gain three
fields (`Merged into`, `Merged subsections`, `Tree placement`) and lose two (`Retired`,
`Retirement held`); the redirect lint is deleted as superseded; two new lints are added.

**Tier declared: 1.** Classification-list edits plus two new deterministic artefact lints with fully
specified refusals. No decision logic, no new runtime authority. Authorisation is the operator's
recorded ruling plus Justin's quoted words in the matrix.

## 1. Over-block
The two new lints refuse narrowly: a NEW standard with no declared tree placement, and a
registry-cited enforcement file naming no standard back. Both ship with shrink-only baselines, so no
existing content is refused. The deleted redirect lint removes a refusal rather than adding one.

## 2. Under-block
Three, all named in the registry rather than implied. The placement lint grandfathers 57 of 88
articles. The back-reference lint grandfathers 27 of 50 files and covers only files the registry
already cites — the rule says *all* infrastructure. And it checks that a file names *a* standard, not
the *right* one. An independent fidelity lens rated the second of these the highest remaining risk;
it now carries a dated countdown and owner (`ACT-1768`) rather than a shrink-only ratchet alone.

## 3. Level-of-abstraction fit
The merge is expressed in the registry's own tree convention rather than by physically relocating
articles into `####` blocks. Measured before choosing: **13 of the 25 have a successor in a different
family**, so physical relocation would move articles across family boundaries and rewrite every
area's denominator and committed floor. The ruling says the coverage lint stays and nothing leaves
the live surface; a denominator rewrite serves neither. The deviation is stated in the matrix.

## 4. Signal vs. authority
Compliant. Both lints are deterministic checks over artefacts with enumerated refusals; neither holds
judgment. The three new fields are classified NARRATIVE — a tree position is not evidence a guard
exists.

## 5. Interactions
- The parentage lint stays clean at 88 articles / 13 relations. Coverage moved 0.7356 → 0.7386 purely
  because one article was added with a real enforcement citation; dangling 0, unrecognized 0.
- **Three defects in the new placement lint's diff clause, each caught by a different check.** Its
  parent regex matched the bolded phrase `**named subsection**` instead of the parent name (caught by
  running it). It referenced an undefined `ROOT`, threw, and the catch reported a clean pass it never
  earned (caught by reading why "clean" appeared). Its diff parser looked for `### Title` context
  lines that `-U0` never emits (caught by a positive control). The catch now fails loudly on a
  programming error instead of degrading to inert.

## 6. External surfaces
None. No route, message, config, or runtime behaviour.

## 7. Multi-machine posture
Machine-local BY DESIGN: repository source, replicating by merge and release. No runtime state.

## 8. Rollback cost
Cheap and total. The registry edits are additive fields on existing articles plus one new article;
reverting restores the prior text. The two lints are new files plus one line in `package.json`.

## Conclusion
No blocking issue. Three under-blocks recorded, the sharpest carrying a dated owner. The most useful
output of this review is §5: a lint reported "clean" three times for three different reasons that had
nothing to do with the document, and only a positive control distinguished a real pass from a guard
that never ran.
