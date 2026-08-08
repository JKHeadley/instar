# PROPOSED STANDARD — not yet ratified

**Status:** PROPOSAL. Agent proposes; operator ratifies. This document deliberately does **not**
modify `docs/STANDARDS-REGISTRY.md`.
**Proposed by:** Codey — in response to the Building review gap on undefined scope terms.
**Proposed placement:** amendment spanning the existing owners (*Testing Integrity*, *LLM-Supervised
Execution*, and *Live-User-Channel Proof*), not a fourth standard.
**Written:** 2026-08-08.

---

## The proposal: one profile, three decisions

The words **significant**, **critical**, and **user-visible** currently act as untyped gates. They are
not three synonyms, but neither should each standard invent its own classifier. Adopt one small,
machine-readable **obligation profile** for every behavior-changing feature or pipeline, with three
independent fields:

1. **Change scope (significance):** what behavior, execution path, or testable contract changed. This
   selects test breadth. It is a testing census, not a claim about human importance.
2. **Consequence (criticality):** what happens when the path is wrong — for example identity or
   ownership, data/money/quota, irreversible external side effects, lifecycle control, security or
   information flow, or a policy decision. This selects the existing risk floor and supervision tier;
   it must not create a parallel meaning for the existing `criticality`/risk fields.
3. **Reach (user visibility):** whether the path can reach a registered user-facing surface or entry
   point. This selects live-channel/canary proof.

The profile is one representation with separate answers and separate evidence. A private migration
can be critical without being user-visible. A cosmetic dashboard change can be user-visible without
being critical. A small internal change can be significant because it changes a shared execution path.
Collapsing these into one `important` bit would either over-test harmless UI work or under-protect an
internal safety pipeline.

## What decides it

This is **not** a keyword classifier. The rule forbidding “intelligence inferred from keywords only”
applies directly: phrases in a description cannot establish membership in any population.

The deciding mechanism is structural and evidence-bearing:

- The author records the changed entry points, contracts, effects, and reachable surfaces in the
  profile.
- Deterministic discovery (changed-file/entry-point census, dependency and route registration, job
  definitions, and the existing user-surface inventory) computes what it can and reports unresolved
  boundaries.
- A review authority resolves only the remaining judgment candidates, with a reason and evidence.
  The author's declaration is an input to review, never the authority by itself.
- Each owning standard consumes only its field: Testing Integrity consumes change scope, LLM
  Supervision consumes consequence, and Live-User-Channel Proof consumes reach.

This makes the profile a **certificate of obligations**, not a permission slip. A field may be
`resolved`, `unresolved`, or `not-applicable` only when structural evidence proves the latter. An
unresolved field cannot silently become “out of scope.”

## The default and its cost

When no profile exists, or when discovery cannot resolve a field, use the strict reading: apply the
strongest applicable obligation. For behavior-changing code this means all three testing tiers; for an
unresolved consequence, the existing minimum supervisory/risk floor; for an unresolved reachable
boundary, live-channel/canary proof. The burden is to demonstrate a bounded, non-user-facing,
non-consequential exclusion with evidence, not merely to label it so.

This will produce false positives: an internal helper may temporarily receive full tests, a supervisor,
or a canary. That is an intentional throughput tax for an unmeasured boundary. It is cheaper than a
false negative that ships with no test, supervisor, or live proof, and it is bounded by making the
profile cheap to generate and by allowing a reviewer to resolve an evidence-backed `not-applicable`
field. The default must not be “nothing classified means nothing applies”; that is exactly the escape
the gap exposes.

## Inventory: necessary, not sufficient

A closed inventory is the right shape for **user-facing reach**, and the recently integrated surface
inventory amendment is the correct precedent. But an inventory alone merely moves the escape to
“nobody added it.” It therefore cannot be the authority. The profile must be checked at the boundary:
new routes, commands, jobs, plugins, event handlers, and other registration points feed the census;
unregistered or dynamically discovered boundaries remain unresolved and fail closed. The inventory
certifies known coverage; the unknown state protects against an incomplete inventory. A future dynamic
surface can still evade a purely static census, so the proposal makes that limitation explicit rather
than claiming completeness it cannot prove.

## Enforcement shape

This proposal is an amendment to existing standards, not a new constitutional article and not a new
parallel “importance” taxonomy. The implementation should add one schema and one extraction path,
then have the three existing gates consume it. The first useful ratchets are:

- fail the review/build when a behavior-changing or registered boundary has no profile;
- fail when a profile claims `not-applicable` without the required evidence;
- fail when a profile says `resolved` but the corresponding test, supervisor, or canary artifact is
  absent; and
- emit an explicit unresolved population so the next review can measure it rather than infer success
  from a count.

Until those ratchets exist, this remains a proposal and the three standards' current scope clauses are
still unenforced sub-obligations. No article countdown or registry edit is claimed here.

## Passing inputs that must fail the claim

These are deliberately plausible author declarations that the mechanism must reject or escalate:

- “Internal refactor” changes a shared dispatch path but omits a change-scope profile: strict testing
  applies.
- A new route is absent from the user-surface inventory: reach is unresolved, so canary proof applies.
- A scheduled cleanup job is labelled Tier 0 while it mutates ownership or quota: consequence evidence
  overrides the label and requires the existing critical-pipeline supervision floor.
- A feature is present in the inventory but its declaration says “not user-facing” with no route,
  command, or runtime-reach evidence: the field remains unresolved.

## What this does not claim

- It does not claim a closed inventory can discover every dynamic surface; unknowns must remain visible.
- It does not replace human judgment with a magic classifier; it narrows judgment to explicit residual
  cases and records who resolved them.
- It does not make all three obligations identical. It makes their scope inputs composable while
  preserving their different failure modes and existing owners.

**Earned from:** the Building review finding that the three duties have no definitions, inventory, or
authority, and the adjacent finding that undeclared user-facing surfaces escape for the same structural
reason. The proposal is intentionally registry-free pending operator review.
