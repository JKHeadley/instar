# Per-feature plan template (one section per legacy tab)

## <Feature name> (legacy tab id: `<id>`)

**Who comes here, and the one question on arrival.** One sentence each. The question the screen answers before any tap.

**What it does today (inventory).** Every view, control and write action in the legacy tab, with the route behind it and whether it is PIN-gated. Nothing may be lost; if something is deliberately dropped, say so and why.

**What is wrong with it today.** Concrete: confusing labels, raw internals shown as primary content, buried actions, too much on screen, missing honesty states, phone problems. Cite the code (file:line) where useful.

**The new design.**
- *Arrival (glance):* the headline sentence + at most 4 tiles/facts. Plain language.
- *Layout:* phone (390 px) first, then desktop. Describe the structure: sections, lists, detail views, what is collapsed.
- *Primary action(s):* what the operator most often does here, and how it takes one tap.
- *Secondary / destructive actions:* where they live, how they are de-emphasized, confirmation and PIN rules (no PIN over what the bearer token already allows, except where the server requires operator proof).
- *Honest states:* loading, empty, can't tell (source failed), partial (some machines), stale (old data), and any feature-specific failure state.
- *Multi-machine:* what the pool view shows and how an unreachable machine appears.
- *Rough sketch:* a small ASCII wireframe of the phone layout.

**Merge / split / cut.** Should this be combined with another feature, split, moved, or retired? Why.

**Data.** Routes used (existing). Any new route or field genuinely needed, with the smallest form. Prefer none.

**Effort and order.** S / M / L, and dependencies.

**Open questions for the operator.** Only real taste or policy decisions the code and standards cannot answer. Prefer none.
