# PROPOSED AMENDMENT — Threshold of Importance

**Status:** Proposal only. Not ratified and deliberately not written into the standards registry.
**Proposed family:** The Substrate.
**Proposed disposition:** Amend *The Body and the Mind* rather than add a sibling article.

## The obligation

Every decision point must declare, before implementation, whether it validates a closed-domain
invariant or judges meaning, intent, consequence, or tradeoff; structure may decide the former and
may only inform the mind on the latter, except for a separately enumerated safety floor.

## Why this is an amendment

The missing threshold is not a second principle. It is the operational definition of the sentence
already in *The Body and the Mind*. The project already asks every decision point to distinguish an
`invariant` from a `judgment-candidate`, and *Judgment Within Floors* bounds the action space around
that decision. Promoting that existing binary into the parent article is narrower and more honest than
inventing an importance score or a new taxonomy.

The threshold is about the kind of authority a decision requires, not its line count, cost, or
apparent simplicity:

- A closed enum, type, schema, idempotency fact, or other enumerable invariant is below the judgment
  threshold. Structural validation may refuse malformed input.
- A decision about what a person meant, which resource or owner to affect, whether an action is safe,
  whether a change is ready to ship, or whether an irreversible side effect should occur is above the
  threshold. Structure supplies signals and bounded floors; the mind or a deliberately constrained
  authority decides and records the reason.
- The exact-match emergency-stop floor is not the general answer. It is the explicit, separately
  enumerated exception already defined by *Structure Decides Alone Only on an Exact Match*.

## What a guard would measure and certify

**Measure:** for each declared decision point, the spec and implementation expose its class
(`invariant` or `judgment-candidate`), action space, reversibility/side-effect surface, authority,
and provenance record. A structural check can also verify that an invariant uses a closed enum or
schema and that a judgment candidate routes through its named authority.

**Certify:** only that the declaration exists, the named authority is wired at the inspected seam,
and the declared action space is bounded as stated. It cannot certify that an author classified a
semantic decision correctly, that the invariant list is complete, or that a model's reasoning is
good. Those remain review claims and must not be smuggled into a green structural check.

## A passing input that fails the claim

A feature spec labels a route decision `invariant` because the route name is an enum. The route then
chooses a machine, owner, or user-visible behavior from request context. The declaration lint passes,
and the route is syntactically bounded, but the decision is semantic and consequential: the input
passes the guard while the claim that structure is allowed to decide it is false.

This is why the proposed guard must certify declaration and wiring, not the truth of the declaration.
The counterexample is a required human review question, not evidence that a keyword classifier should
be added.

## Enforcement honesty and countdown

The existing decision-point metadata and floor vocabulary make a future guard plausible, but no
current check proves that every consequential decision is classified correctly or that every declared
authority actually holds the decision. This proposal is therefore **documented-only until
2026-09-07**, tracked as `STD-COUNTDOWN-threshold-of-importance`, if it is accepted before that guard
exists. Because *The Substrate* is at its enforcement floor, accepting this text without the guard or
an explicit countdown would fail the project's own admission rule.

The countdown remedy is a guard over the decision-point population: every blocking or side-effecting
site must have one declaration, and a thin structural seam must not make a judgment-candidate's
decision. Until that population is enumerable, the article must not claim enforcement.
