# BRIEF 1 — The Substrate: define the "threshold of importance"

**Take-or-decline. Self-contained. Produces a proposal document, never a registry edit.**

## The finding, verbatim

> **GAPS — Yes.** No article defines the "**threshold of importance**" or reconciles the mind's
> asserted "**final authority**" with deterministic, unvetoable floors and hard rejections. The family
> needs one governing rule specifying which decisions structure may make, which only the mind may
> make, and how exceptions are classified and audited.

## What is already done, so you do not redo it

The *reconciliation* half is CLOSED. Operator ruling A (2026-08-07) added
*Structure Decides Alone Only on an Exact Match*: structure may decide alone ONLY on an exact,
whole-message match from a short enumerated list; everything else is the mind's. That article is on
the branch, guarded, and declared a tree node under *The Body and the Mind*.

**What remains is the OTHER half, and it is the harder one.** *The Body and the Mind* says the body
"informs the mind; **past a threshold of importance it must inform the mind's decision, never make
it**." That threshold is never defined. So the article states a boundary and gives no way to locate it.

## The question to answer

**Below the threshold, structure may decide. Above it, structure may only inform. What determines
which side a decision is on?**

Note the shape: ruling A's exact-match carve-out is one narrow, enumerated exception for a SAFETY
FLOOR. It is not the general answer — it says nothing about, say, a classifier picking a routing
tier, a reaper choosing a session to kill, or a gate refusing a commit. Those all sit somewhere on
this axis and the family cannot currently say where.

## Material worth reading before drafting

- *The Body and the Mind* — the threshold sentence, and "**Every decision of consequence** is made by
  the mind, *informed* by the body, and *recorded*".
- *Signal vs. Authority* and its documented exemption class (`docs/signal-vs-authority.md`
  §"When this principle does NOT apply") — enumerable-domain invariants and safety guards on
  irreversible actions. **That exemption list may already be the threshold in embryo.** If so, say so
  — promoting an existing list beats inventing a new axis.
- *Judgment Within Floors* — per-decision-point action-space bounds. Its "floor" vocabulary may be
  the same idea from the other direction.
- The decision-point classification already required of every spec: `invariant` vs
  `judgment-candidate`. **That binary is a live, enforced instance of exactly this distinction** —
  the threshold may already be operationally defined and simply never stated as a rule.

## Deliverable

`docs/proposals/standard-proposal-threshold-of-importance.md` containing: the obligation in one
sentence; whether it is a NEW article or an amendment to *The Body and the Mind* (argue it — an
amendment that sharpens the parent may beat a new node, and the operator's placement rule prefers
that where overlap is tight); what a guard would MEASURE and CERTIFY; one input that passes the guard
while failing the claim; and, if no guard is buildable, an explicit countdown per ruling 4.

**A strong outcome may be "this is an amendment, not a new article."** Do not pad it into a node to
look substantial.
