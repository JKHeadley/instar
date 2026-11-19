# Interaction family review — adding "Security Fixes Keep the Experience Whole"

**Date:** 2026-11-15. **Reviewers:** echo:claude-code; independent-verifier:claude-code-opus (fresh read).

## What changed in the family
One article is added to the Interaction family: *Security Fixes Keep the Experience Whole*, a child of *The User Experience Is the Product*. Operator-approved text (telegram 141385, 2026-11-15 13:42 PST, "approve", replying to the ask that linked the exact text). The family goes from 16 to 17 articles; the Interaction total in the coverage census goes 13 to 14 for the counted population and the registry total 98 to 99.

## Review
- **Placement.** The article sits directly after its stated parent and declares the parent in prose ("A child of *The User Experience Is the Product*"). It is not a structural `tree node under` relation, so the generated hierarchy lists it among articles with no structural parent — consistent with the registry's other prose-parented children. All registry lints pass (insertion placement, tree parentage, single governing obligation, code back-reference, bounded judgment input, documented-only countdown, hierarchy --check).
- **Content.** It states a rule (a security fix may not degrade UX unless that is the only way to close a critical vulnerability; every security change states its user-visible effect), its in-practice guidance, the earned-from source with the operator quote, its derivation, its trace to the founding goal, and how it is applied (the side-effects review's user-visible-effect line; nothing auto-blocks yet, stated plainly).
- **No conflict.** It narrows nothing and removes nothing; it applies the parent's "no silent degradation of the user's channel" to security fixes. No other article contradicts it.
- **Enforcement honesty.** "Applied through" says no gate blocks on it yet, which matches reality.

## Disposition
No unresolved design findings. The article is accepted into the Interaction family. This review records the family audit refresh required because adding an article changes the family's content hash.
