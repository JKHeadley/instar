# Side-Effects Review — Standard: Security Fixes Keep the Experience Whole

## Summary of the change
Adds one operator-approved article, "Security Fixes Keep the Experience Whole", to `docs/STANDARDS-REGISTRY.md` in the Interaction section, directly after *The User Experience Is the Product* (its declared parent in prose). The text is byte-identical to the draft the operator approved: telegram 141385, 2026-11-15 13:42 PST, "approve", replying to the Chief of Staff's 13:39 ask that linked the exact text. The generated hierarchy block's article count was regenerated (`generate-standards-hierarchy.mjs`). Tier 1, docs only: 1 file, +9/-1. One commit attempt, no review rounds (approved wording).

## Decision-point inventory
None at runtime. The article creates a review obligation (a "User-visible effect" line on security PRs), which is held by reviewers, not code.

## 1. Over-block
No runtime surface. The text itself names its boundary: degradation is allowed for a critical vulnerability, judged by the independent review.

## 2. Under-block
Nothing enforces it yet; the article says so ("Nothing blocks a merge on it automatically yet").

## 3. Level-of-abstraction fit
A child of *The User Experience Is the Product*, which already holds that guards must not silently degrade the user's channel. This applies it to security fixes. The parent relation is declared in prose ("A child of"), not as a structural `tree node under` relation, because the structural form would require changing the approved wording and editing the parent article; the hierarchy generator therefore lists it among articles with no structural parent. All registry lints pass.

## 4. Signal vs authority compliance
No new authority. Reviewer-held judgment.

## 4b. Judgment-point check
Not applicable (no runtime decision point).

## 5. Interactions
The standards-conformance gate reads the registry and will now evaluate specs against this article as well. The registry asset in `src/data` is regenerated from the registry at build time.

## 6. External surfaces
The public constitution gains one article. No user-visible runtime change.

## 6b. Operator-surface quality
Not applicable.

## 7. Multi-machine posture
Not applicable: a document in the source repository, the same on every install.

## 8. Rollback cost
Revert the commit.

## Conclusion
Documentation of an approved standard; no runtime effect.

## Evidence pointers
- Approved text: `.instar/state/security/ux-standard-draft.md` (agent home), diffed byte-identical against the inserted article before commit.
- Lints: registry insertion placement, code back-reference, tree parentage, single governing obligation, documented-only countdown, bounded judgment input, hierarchy `--check` all clean.

## Second-pass review (independent)

**Reviewer:** independent second-pass subagent (Explore, fresh context), 2026-11-15, given only the two-commit diff (`git diff 17b43300a..HEAD`), not the author's conclusion. Audited: the new standard's text and placement in docs/STANDARDS-REGISTRY.md; the ratchet count bump (98→99); the Interaction family-audit JSON canonical form + hash reconciliation (auditSha256/areaSha256/convergenceSha256); the constitution-alignment-map row uniqueness (1.x article #99); the eli16 + upgrades/next fragments; whole-change integrity.

Findings: all checks pass — the standard makes a clear, enforceable claim correctly placed under *The User Experience Is the Product*; 98→99 is exact (99 `**Rule.**` lines and 99 `### ` headings), not off-by-one; both JSON files are canonical and every hash reconciles; the alignment-map row is unique (the other `| 99 |` is in the separate 2.0 numbering space); the operator approval (telegram 141385/143443, 2026-11-15) is cited consistently. **Verdict: Concur with the review.**
