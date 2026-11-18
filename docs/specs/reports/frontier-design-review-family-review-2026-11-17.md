# Building and The Root families: review of *Frontier Models Design and Review; Efficient Models Build* (2026-11-17)

This change adds the article *Frontier Models Design and Review; Efficient Models Build* to the Building family, right after *Keep the Doorway/Model Map Current*, as a tree node under *Structure beats Willpower* in The Root, which gains one sentence naming it back. The article text is the "Constitution wording" section of `docs/specs/frontier-design-review-standard.md`, which the operator approved: "approved" [source: telegram 144319/144458 2026-11-17T23:32:37Z], answering 144319/144392; the spec's decision 7 makes that approval cover the article. It is the 1.x counterpart of 2.0 Rule 124 (instar-2 branch echo/constitution-frontier-design-review). This review checks its place in the two families, not its merits.

**Placement.** The article first went into The Root, directly after its parent. The standards ratchet test holds The Root as a single article (the founding lens), and a cross-family parent already has precedent (*A Decision That Can Block Must Live Where the Checks Can See It*, in Building, under *Observation Needs Structure*, in The Substrate). So the article sits in Building beside the model-map article it builds on, and The Root changes only by its back-reference.

**Independent reads** (codex-cli on gpt-6.2-sol, read-only):
- A first read of The Root with the article placed there found no contradiction and both articles intact, and flagged the generated hierarchy block as absent because it was given only the family; a narrow recheck with the block confirmed the relation. That placement was then moved as above.
- A read of the whole Building family and The Root after the move, with the exact diff:
  1. **Contradiction or duplicated obligation: none.** *Keep the Doorway/Model Map Current* keeps the registry true; the new article uses it to route design, review and build work. *Iterative Audit to Convergence* still governs audit sweeps; *Judgment Within Floors* and *No Silent Degradation to Brittle Fallback* keep their scope; *Framework-Agnostic* and *No Feature May Require a Purchased Service* stay compatible, since a second provider is used only when already reachable.
  2. **Change of meaning elsewhere: none.** The root's added sentence says the root still governs every standard.
  3. **Articles intact: yes**, one bold-labelled line per field; the regenerated hierarchy lists the relation.

Verdict: accepted, for both families.

**Gap noted, not a blocker:** the article's Applied-through line names `src/core/designLane.ts` and `B26_DESIGN_APPROVAL_UNREVIEWED`, which are built by the stages of the same spec and are not on main yet, so the coverage script counts them as dangling until that code merges. The wording is the operator's approved text and is not changed here.
