---
audit: "standards-area-model-adequacy"
target-pattern: "Whether the current Standards Registry family set remains an adequate decomposition of the rule-bearing corpus, with an explicit keep / add / split / merge / retire disposition for every review."
search-surface: "All six family sections and all 82 rule-bearing articles; family cohesion, boundary overlap, scale, orphan clusters, and plausible add / split / merge / retire alternatives."
standing-guard: "tests/unit/standards-coverage-ratchet.test.ts"
blind-spot-class: "list-integrity-without-adequacy-review"
standard-response-kind: "no-change"
standard-response-ref: "docs/STANDARDS-REGISTRY.md"
standard-response-article-id: "iterative-audit-to-convergence"
standard-response-article: "Iterative Audit to Convergence"
standard-response-rationale: "The constitution already requires iterative convergence; the escaped blind spot was that family-byte integrity never required a fresh adequacy judgment about the family model itself."
converged: "2026-08-02T02:17:22.219Z"
rounds: "2"
standard-response-digest: "5505039f748ca3861ec2d399966503a57b5080138e073a3d87b7f31683b37c47"
meta-artifact-at: "2026-08-02T02:17:22.219Z"
meta-artifact-digest: "c26b03969d973b4f92eb71b030685e45ae9ed755a37d8bbc304383e6e6ea7cad"
---

# Standards area-model adequacy audit

This audit reviews the family list as a model, not merely the bytes inside each
family. It asks whether every current family should be kept, split, merged, or
retired and whether any missing family should be added. The deterministic guard
validates the evidence shape and binds it to this converged report; it does not
make these semantic choices.

## Meta-insight

How it arose: The first area ratchet made every known family exact and reviewable, but a list can remain byte-perfect while its decomposition grows obsolete. Treating the list as fixed would reproduce the stored-and-never-revisited failure at one level higher.
Why prior controls missed it: They proved that known family names and contents had not changed without evidence. They did not require a reviewer to reconsider the names, boundaries, omissions, or continued usefulness of the family set itself.

## Round 1

Search angles: Read all 82 rule-bearing articles under the six parsed H2 family sections; compared each article's subject with its containing family; checked each family for internal cohesion, repeated boundary confusion, disproportionate scale, and orphan articles; then forced a keep / add / split / merge / retire decision rather than accepting the inherited list by default.
Surface delta: Initial full-corpus sweep. The review surface expanded from six content hashes to the six family identities, all cross-family boundaries, and the possibility of an absent seventh family.

| location | behavior | bucket | disposition |
|----------|----------|--------|-------------|
| docs/STANDARDS-REGISTRY.md:47 | The Root contains one generative principle from which the remaining standards derive. Its singleton size is intentional; merging it would erase the distinction between constitutional source and implementing framework. | keep | accepted:keep The Root as the distinct generative source; split, merge, and retire would all reduce explanatory precision |
| docs/STANDARDS-REGISTRY.md:58 | The Fractal defines the self-hosting framework identity and recursive development stance. It is related to Building but answers what the framework is, not how an implementation is engineered. | keep | accepted:keep The Fractal because its identity-level boundary remains distinct from implementation discipline |
| docs/STANDARDS-REGISTRY.md:78 | The Substrate groups model-level truths such as context, attention, memory, authority, uncertainty, and emergence. Its breadth is high, but these are mutually entangled constraints below feature construction rather than stable standalone domains. | keep | accepted:keep The Substrate; candidate splits would create ambiguous homes for cross-cutting model truths |
| docs/STANDARDS-REGISTRY.md:287 | Building groups engineering mechanics, verification, observability, failure handling, and maintainability. The articles share the question of how a capability is made dependable before release. | keep | accepted:keep Building; splitting quality, operations, and implementation would fragment standards that deliberately span those mechanics |
| docs/STANDARDS-REGISTRY.md:581 | Shipping covers the evidence-to-rollout lifecycle, live completeness, and truthful delivery. It remains separable from Building because a well-built capability can still be incompletely or dishonestly shipped. | keep | accepted:keep Shipping as the delivery boundary; merging it into Building would hide the implementation-to-live transition |
| docs/STANDARDS-REGISTRY.md:631 | Interaction covers the agent's external surface: user communication, consent, delegation, publishing, and relationships. It is coherent around effects that cross the system boundary. | keep | accepted:keep Interaction; its outward authority and communication concerns remain distinct from internal mechanics |
| docs/STANDARDS-REGISTRY.md:47 | Every rule-bearing article maps meaningfully to one of the six families. Candidate additions for security, governance, memory, or operations recur as cross-cutting concerns inside existing families rather than as orphan clusters with a cleaner independent boundary. | add | accepted:add no new family; the full-corpus sweep found no recurrent orphan cluster that would improve the decomposition |

New findings this round: 7

## Round 2

Search angles: Re-read the corpus from boundary inversions rather than inherited headings: attempted Root+Fractal and Building+Shipping merges; attempted Substrate, Building, and Interaction splits; tested retirement of each singleton or narrow family; and tried adding security, governance, memory, operations, and agent-identity families. For every candidate, sampled articles on both sides of the proposed boundary and asked whether the move reduced ambiguous classification.
Surface delta: The second sweep introduced no new family or boundary defect. Each plausible alternative mapped back to a Round-1 decision: merges erased a useful level or lifecycle boundary, splits increased cross-cutting ambiguity, retirements lost a distinct concept, and additions duplicated concerns already distributed by level and effect.

New findings this round: 0

## Convergence status (honest)

CONVERGED after 2 rounds. Round 1 made seven explicit model dispositions: keep all six current families and add no new family. Round 2 attacked those decisions through the strongest split, merge, retire, and add alternatives and found no new defect or unresolved design question. The present outcome is therefore keep: The Root, The Fractal, The Substrate, Building, Shipping, and Interaction; add: none; split: none; merge: none; retire: none. This is a current semantic judgment, not an eternal taxonomy. The standing guard requires a fresh, convergence-stamped adequacy record and invalidates it when the parsed family set changes, while elapsed age remains a review signal so the judgment can be revisited without letting deterministic code choose the answer.
