# Window 14 — the merge model (ruling 4a, re-ruled 2026-08-13)

**What changed.** Ruling 4a was applied as *archival retirement* and merged. The operator then
re-ruled the retirement model itself: **MERGE, not archive.** This document is the fidelity baseline
for the rework, and it leads with his words because they are the authority.

---

## Justin's words — the reasoning the rework must satisfy

On why retirement was the wrong shape (2026-08-13 16:07Z):

> "My understanding was that a big part of what we're doing here with the overall plan is to make
> sure that every standard or rule has structure in place to enforce it but now it seems like we're
> saying that as soon as that structure is in place the rule is meant to be retired, so I don't quite
> understand the logic behind that"

> "Part of my worry is that if these standards are retired then we will fall into the trap of the
> issues that led to their creation in the first place"

> "during our development process were meant to make sure all future features adhere to our standards
> and rules, and if the lower level standards are retired, the higher level standards may **not have
> the level of specificity needed** for the development process to avoid the pitfalls that the
> retired standards represent"

He also named the mechanism that already exists:

> "the tree structure aspect of the constitution and the standards sort of already supports the
> concept of merging standards since many standards branch off from high-level standards that group
> them together"

On the tree as duplicate-prevention (16:27Z):

> "this is how the constitution was supposed to be structured in the first place and it's also the
> reason we introduced the registry for the constitution such that each standard has to list how it's
> enforced and I believe how it fits in the tree or hierarchy of standards"

> "The tree structure itself should by default remove the possibility of duplicates since any new
> standard introduced has to find a proper place in the tree, whether that's updating a current
> standard becoming a child of a current standard or becoming a new route or foundational standard"

On the new bidirectional rule (16:27Z):

> "all infrastructure should have documentation and or comments is maintained with the code that
> states what standards rule over that part of the infrastructure or which standard apply. That way
> we have references from both ends meaning the registry itself list what parts the code enforce the
> standards and the code references back to which standards they are derived from."

**The bar this sets.** The failure mode he is protecting against is **loss of specificity**, not
untidiness. A merge that summarises 25 rules into their parents would produce exactly the outcome he
describes — a higher-level standard without the specificity the development process needs. So the
governing test for every one of the 25 is: **does every specific tripwire that rule carried still get
encountered by the development process?**

---

## The measurement that shaped the design

Literal physical nesting — moving each of the 25 to sit as a `####` block inside its successor —
was measured before it was chosen or rejected:

**13 of the 25 have a successor in a DIFFERENT family.** *Intelligence Infers, Keywords Only Guard*
(Substrate) → *Signal vs. Authority* (Interaction). *A Refusal Stays a Refusal* (Building) → *Verify
the State, Not Its Symbol* (Substrate). *Token-Audit Completeness* (Shipping) → *Observability*
(Building). And ten more.

Physically relocating those 13 would move articles across family boundaries, changing every area's
denominator, enforcement ratio and committed floor — the coverage machinery's floors may only ratchet
up, so a denominator change is not a cosmetic edit. The operator's ruling says *"the coverage lint
stays"* and *"nothing leaves the live surface."* A rewrite of every area's composition serves neither.

**So the merge is expressed in the registry's own tree convention rather than by physical relocation**
— which is the mechanism Justin himself pointed at. Concretely, for each of the 25:

| what | how |
|---|---|
| the rule stays a live standard | its `###` article, its full text, every tripwire, untouched |
| it becomes a named subsection of its parent | it declares `**Derives from.** *Parent*`; the parent acknowledges it by name |
| the parent gains the specificity | the parent lists each merged subsection **and what specific tripwire it carries**, so a reader of the parent meets the specificity rather than a pointer to it |
| citations resolve to live text | they already do — the article never left |
| retirement is undone | the `**Retired.**` records are removed; these rules are not retired |
| the redirect machinery is removed | superseded per the ruling — a live subsection needs no forwarding marker |
| the guard-protection condition stays | removing an enforcement structure remains a breach |

**The deviation, stated rather than buried:** the ruling says "named subsections". This implements
that as a *declared and bidirectionally-enforced* parent-child relation with the parent naming each
child and its tripwires — not as `####` physical nesting. The reason is the 13 cross-family moves
above. If the intent was literal nesting, that is a larger change that rewrites the area model, and
it should be ruled on with that cost visible rather than discovered during the edit.

---

## The three parts of the rework

### Part 1 — the 25 become live subsections

Per article: remove the `**Retired.**` record, declare the parent, have the parent acknowledge the
child by name with its carried tripwires, and remove the forwarding markers at every citation site.

**Proof required.** The tripwire test is the one that matters and it is not satisfiable by
inspection alone at scale: for each of the 25, the specific conditions it carried must be
enumerated and shown to survive — verbatim in the child, and named at the parent. Reported as
inspection-verified per article, with the mechanical part (every child declared, every parent
acknowledging, bidirectional) enforced by the existing parentage lint.

### Part 2 — tree placement enforced at INSERTION

Justin's structural addition, and his diagnosis of root cause: the 25 duplicates existed because
placement was never structurally enforced. A new standard must declare which of the three placements
it takes — updates an existing standard, becomes a child of one, or becomes a new root/foundational
standard — and that declaration is checked, not assumed.

**Proof required.** A lint that refuses a new article carrying no placement declaration, verified by
reverting the defect: add an article with no placement and watch it fail.

### Part 3 — bidirectional standard-to-code references

The registry already names enforcing code (`**Applied through.**`). The missing half is the return
reference: the code naming which standards govern it.

**Proof required.** A new standard stating the obligation, plus a lint that checks the direction that
can be checked mechanically. Where a reference cannot be verified both ways yet, it is named as an
unenforced sub-obligation with a countdown rather than implied.

---

## What is NOT in scope

Merging the reworked branch. The hold stays until the overseer verifies fidelity and releases it.
