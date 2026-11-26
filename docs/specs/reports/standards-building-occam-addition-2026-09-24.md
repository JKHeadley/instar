# Standards family delta review — Building gains *Occam's Razor — Simplest Robust Route*

## Scope and operator authority

This review covers one change to `docs/STANDARDS-REGISTRY.md`: a new article, *Occam's Razor — Simplest Robust Route*, appended at the end of the **Building** family, directly after *References Run From Both Ends* and before `## Shipping — truthfulness and completeness`, with no separator line (matching the base layout, so the preceding article stays byte-identical), plus the regenerated standards-hierarchy block.

The authority is twofold and both parts are recorded. The operator approved the standard's wording as Instar 2.0 Rule 116 (instar-2 PR 116, "approved" in topic 52075 at 15:58Z 2026-09-24). That approval line covered mirroring the supplied standard into Instar 1.x through its existing process. The operator then gave an approving GitHub review on this PR (JKHeadley/instar #2065, 17:59:52Z 2026-09-24), which `scripts/standards-direction-guard.mjs` requires for an ADDITION. CI reported `direction-guard=passed`.

## The delta, measured rather than described

- The registry gains exactly one `###` article in Building. Building's article count moves from 41 to 42; no other family's population changes.
- The article's Rule paragraph is the companion paragraph from `astra-occam-standard-ruling.md`, verbatim. Its Fails and In practice fields adapt it honestly to 1.x (below).
- The hierarchy block's only change is its trailing count sentence: "The other 50 articles declare no parent" becomes "51". The count of declared relations (41) and parents (25) is unchanged, because the article declares itself ROOT / FOUNDATIONAL with no parent.
- No existing article text, tracker id, enforcement claim, reference or family membership changed.

## Enforcement classification

The article is **Judgment-bound**: it carries a Judgment-bound field like *Deferral = Deletion* and *Self-Hosting*, though it states its judgment obligation as the independent reviewer's answer plus retrospectives rather than their fuller context-sufficiency and rating obligations. It names no guard file, so it adds no dangling reference. The Rule paragraph, carried verbatim from Instar 2.0, calls `simplestRobustRoute` a required field of the existing review. **That field exists in Instar 2.0 but not in Instar 1.x.** The article therefore says so in its In practice field: in 1.x the existing review is the side-effects review and the spec convergence review, neither template yet carries the field, and until one does this article is what requires the answer, stated in the review's prose. Its Fails field refers to the review stating a simplest robust route rather than to a field. It asserts no running machinery that does not exist. By its own terms it must not be given a classifier, checker, gate or sentinel. Building's enforced-article count is therefore unchanged. The family's recorded floor (34 enforced of 40) was set against the previous population and is not lowered by this record.

## Checks run on the candidate

`generate-standards-hierarchy.mjs --check`, `lint-registry-insertion-placement.mjs`, `lint-registry-tree-parentage.mjs` and `lint-no-direct-standards-registry-path.mjs` are clean. On the first candidate, CI's Standards Enforcement Coverage refused on the stale Building area audit, which this review resolves by attesting the current Building digest. The direction guard now classifies the change as a single ADDITION and nothing else.

## Areas attested

| Family | areaSha256 | Verdict |
|---|---|---|
| Building | `3031d13ba311e50e26889bfd59512bd05c3cb45710220ade2ce6f1b428b41409` | accepted |

## Independent acceptance

An independent verifier re-derived the claims from the repository rather than from this report. It concurred on ten items: one new article in Building before Shipping; Building 41 to 42 with no other family changed; the hierarchy block's only change being the 50-to-51 count; no dangling reference; Judgment-bound with ROOT / FOUNDATIONAL placement; the Building digest being the only area-audit error; the recorded floor (34 of 40) being kept by `recordAreaAudit`, which never lowers a floor without `--rebaseline-floor`; the Rule paragraph matching the companion byte for byte; and the four registry lints being clean. It could not reproduce CI's enforced counts locally, because the protected measurement base is unavailable outside CI.

It raised two findings, both resolved above before acceptance:

1. **The insertion edited its neighbour.** The first candidate added a `---` separator after *References Run From Both Ends*, which the direction guard classified as an EDIT to that article. The entry is now inserted with no separator, and the guard reports a single ADDITION.
2. **The Rule named a field 1.x does not have.** The verbatim 2.0 wording calls `simplestRobustRoute` a required field of an existing review. No 1.x review template carries it. The article now says so, and its Fails field no longer depends on the field.

It also noted that the comparison to *Deferral = Deletion* and *Self-Hosting* was loose; the wording now says how this article's judgment obligation differs.

Reviewers: `echo:claude-code`, `independent-verifier:claude-code`.
