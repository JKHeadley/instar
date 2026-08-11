# Finding for ratification — the registry's precedence gap, stated at its surviving width

**Status: FINDING ONLY. Not a proposal to adopt, and nothing in the registry has been changed.**
Framing is mine; ratification is the operator's.

---

## What this is NOT

An earlier reviewer concluded that the registry **has no precedence mechanism** and proposed a
registry-level clause declaring unnamed collisions `UNRESOLVED`. Both halves were then **refuted** by a
verification lens whose only instruction was to kill the claim.

That refutation is the reason this document exists in its current form, and it is recorded first so the
headline version cannot be quoted from here:

- **The registry DOES carry precedence.** Ratification status applies to every family — a pending article
  is *"advisory, not binding"* and *"may not be cited as the reason another article's obligation is
  discharged."* There is also a stated cross-family tradeoff: the user's ability to reach a live agent
  *"outranks internal caution when the two conflict."*
- **All four alleged cross-family collisions are locally resolvable** by existing scope predicates,
  named exceptions, and governing declarations.
- **The proposed interim was unsafe.** Declaring every non-reciprocally-named collision `UNRESOLVED`
  would discard working scope and composition clauses. The concrete freeze: during an outbound tone-gate
  provider outage, a clean ordinary reply that the registry currently permits would instead require
  operator ratification before *either* sending or holding — blocking the live user channel during
  exactly the outage the "user wins" rule was written to handle.

## The claim that survived

> The registry lacks a uniform fallback for a genuinely **novel** collision between two binding articles,
> where **all** of the following hold: both scope predicates apply; neither article is pending; neither
> names the other; no governing-article, exception, composition, or tradeoff clause settles the case; and
> the two obligations cannot be jointly satisfied.

That is narrow. It is not "the constitution cannot resolve conflicts." It is the residual case after every
existing mechanism has been tried and none applies.

## Why it is still worth ratifying something

The registry's own reasoning argues against leaving the residual unnamed:

> *"an absolute that a sibling article openly violates is worse than a stated carve-out, because a reader
> can cite the registry for both."*

Today, an agent meeting the residual case picks the article that feels narrower and proceeds. That choice
is currently a **guess wearing the appearance of a rule** — and an agent that guesses can cite the
registry for whichever answer it took.

## What a rule would have to decide, with the case each dimension alone cannot settle

| dimension | what it must define | a case it does NOT resolve alone |
|---|---|---|
| Specificity | how narrower scope is established, and what happens when scopes overlap without nesting | *Runtime End-to-End Proof* vs *Self-Heal Before Notify* — one is specific about canary misses, the other about notification order; neither scope contains the other |
| Safety direction | the protected interest and failure direction for the **actual surface**, not "fail safe" generally | *No Silent Degradation* vs *The User Experience Is the Product* — fail-closed protects outbound content, fail-toward-delivery protects reachability; both are safety claims with opposite dispositions |
| Family seniority | whether families rank, and whether a narrower article may defeat a senior family | — |
| Explicit override | the marker that makes an override checkable rather than inferred | — |

## The honest interim, corrected for the refutation

The reviewer's own interim was rejected above. What survives of it is the part that does **not** discard
working mechanisms:

1. State that precedence is **not inferred** from family, document order, date, parentage, safety
   language, or apparent specificity.
2. Preserve, explicitly, every mechanism that already decides: ratification status, governing-article
   declarations, scope predicates, named exceptions, composition clauses, and the stated tradeoff.
3. Escalate to operator ratification **only** after those genuinely fail to decide — the residual case
   above, not every unnamed pair.

Point 3 is the whole correction: the original said escalate by default, which is what would have frozen
the live channel.

## Provenance

- Raised by a whole-registry cross-family reviewer after two family reviewers, each confined to one
  family, independently alleged conflicts they could not verify.
- **Refuted, then narrowed** by a verification lens instructed to default to "the claim is wrong."
- Both reviews archived verbatim under `docs/specs/reports/window12-laptop/`.

The standing rule that produced this shape — *a cross-family or high-confidence finding gets a
cross-cutting verification lens BEFORE it is reported up* — was set by the operator after an earlier
overstatement of mine reached him. It has now caught two, including this one.
