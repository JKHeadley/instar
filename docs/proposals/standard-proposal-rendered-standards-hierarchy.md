# PROPOSAL — Rendered Constitutional Hierarchy

**Status:** Proposal only. Not ratified and deliberately not written into the standards registry.
**Disposition:** An amendment to the registry's joining/placement instructions and its existing
parentage guard, not a new constitutional article.

## The obligation

Every declared parent-child relation in the standards registry must have one deterministic,
human-readable hierarchy view generated from the declarations, and the build must refuse a stale or
structurally invalid generated view.

The registry's declarations remain the source of truth. The rendered hierarchy is a read surface, not
a second hand-maintained taxonomy.

## Why a peer-shaped child is a structural defect

This is not merely formatting. Heading level and document position are how a reader discovers scope,
inheritance, and ownership. An article that says it is beneath another article while rendering as a
peer makes the reader reconstruct the tree from scattered prose. That creates three concrete harms:

1. A reader can apply a child rule as a peer-level principle and miss the parent constraint that
   qualifies it.
2. A child can appear to own an obligation already owned by its parent, producing duplicate authority
   claims—the exact failure this review cycle just exposed around the emergency-stop floor.
3. A new reader cannot tell whether a relation is complete, one-sided, or merely an author's intention;
   the registry looks coherent while its visual model is absent.

Changing every child to a deeper heading is not the remedy. The registry parser keys on its current
article heading level, and changing that level would silently change article and family accounting.

## Proposed design

### One relation graph, two consumers

Extract the declared relations once from the registry, using the same parent and child declarations
the existing bidirectional lint already validates. The shared result should preserve article order,
parent, children, unresolved claims, and structural diagnostics. The existing lint consumes it to
validate mechanical relations; a renderer consumes it to produce the human view. Two independent
parsers would recreate the drift problem.

The graph consumer must reject, rather than silently render, a relation graph with:

- an unresolved parent;
- more than one parent claim for one article;
- a self-parent or cycle;
- a child acknowledgment that does not resolve to the same article; or
- a relation that leaves the graph without a root because of a cycle.

The current parentage check proves resolution and bidirectionality. The graph contract adds the
minimum tree-shape checks needed for a renderer to honestly call its output a hierarchy.

### Generated read surface

Add one generator-owned block near the registry introduction, outside the article heading level:

`BEGIN GENERATED STANDARDS HIERARCHY`

The block should render family roots and indented declared children in deterministic registry order,
with links to the article headings. It should be visibly labelled **Declared hierarchy — mechanical
relations only; conceptual placement remains review**. A reader can expand or scan it without the
parser counting it as another article. The generator owns everything between the markers; humans edit
the declarations in the articles, never the generated list.

The generator should support a check mode that regenerates the block in memory and compares it byte
for byte with the checked-in block. A stale, hand-edited, or missing block fails the same integrity
surface that already runs the parentage lint. The check must also fail when the graph diagnostics are
non-empty. No heading-level migration and no second hand-maintained registry is required.

## What it measures and what it certifies

**Measured:** every relation declaration found by the shared extractor; parent and child resolution;
back-references; root/cycle/multiple-parent diagnostics; the canonical generated text; and whether the
checked-in generated block exactly matches that text.

**Certified:** only that the declared relations form a mechanically valid, synchronized rendered
graph. It does not certify that an article belongs under its declared parent, that every real
conceptual relationship was declared, or that the parent rule is adequate. Those are placement and
constitutional-review judgments.

## The bad-taxonomy counterexample

An author declares a technically resolvable, bidirectional relation that places a deployment-specific
child beneath a foundational substrate article. The graph is acyclic, the parent acknowledges the
child, and the generated view makes the relation look official. The input passes every mechanical
check while the taxonomy is conceptually wrong.

That failure mode is not an argument against generation. It defines the boundary of the guarantee. The
read surface must say **declared**, never **canonical** or **approved**, and placement review remains
the authority for whether the relation belongs. A generated graph makes a bad declaration more visible,
not more correct; the remedy is to reject the declaration in placement review, not to maintain a second
shadow hierarchy that can disagree with it.

## What happens before the renderer exists

The existing bidirectional parentage lint is real evidence for relation integrity, but no current guard
renders or synchronizes a hierarchy. Until the generator and its check are built, the registry may
truthfully claim only that declared relations resolve and point back—not that a reader can see the
tree. The proposal therefore introduces no new enforced article and does not alter family floors.

The implementation should land as one small registry-integrity surface: shared relation extraction,
graph diagnostics, deterministic rendering, and a stale-output check. Its first negative controls
must include a stale generated block, a cycle, a second parent claim, and a technically valid but
conceptually wrong relation labelled as mechanically passing. That keeps the generated view from
becoming a new symbol that stands in for a stronger claim than it can support.
