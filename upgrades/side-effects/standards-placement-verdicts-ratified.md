# Side-Effects Review — five new checks that can refuse a commit

**Version / slug:** `standards-placement-verdicts-ratified`
**Date:** `2026-08-06`
**Author:** `Echo — Pathway (topic 29723), window 8`
**Second-pass reviewer:** `codex (external, dispatched with the answer withheld) reviewed the amended registry family and returned NOT ACCEPTED with 5 findings — transcript at docs/audits/phase-b/substrate-family-review-2026-08-06.txt. One finding concerned this change and is fixed here; four concern pre-existing articles and are open with the operator.`

> **Provenance disclosure, stated because the alternative is a false claim of process.** This artifact
> was authored directly rather than emitted by the `/instar-dev` flow. The change ran the flow's
> substance — external adversarial review, two-sided injection proof per guard, migration parity, a
> release note — but not the skill wrapper. Reduced independence on the *authoring* of this review is
> the honest label; the external reviewer's findings below are genuinely independent of me and one of
> them refuted my work.

## Summary of the change

Four standards joined the registry as tree nodes and one existing standard (*Verify the State, Not Its
Symbol*) was widened by one clause plus a fourth tooth. Each new standard shipped with a deterministic
guard wired into the `lint` chain, because the registry's own admission machinery refuses an unguarded
standard — the per-family ref-resolution floor trips on the FIRST unguarded addition, measured, not
assumed.

Net effect on the constitution's own metrics: 82 → 86 articles, enforced share **0.7195 → 0.7326**
(it went UP), dangling references 0, unclassified sections 0, gaps unchanged at 16.

## Decision-point inventory

| point | classification | note |
|---|---|---|
| `lint-blocking-decisions-declared` | `invariant` | Set membership + integer ceiling + sha256 equality. No judgment; a file is declared or it is not. |
| `lint-no-duplicate-definitions` | `invariant` | String equality on parsed headings/IDs. |
| `lint-dispatch-withholds-answer` | `invariant` | Substring presence of a fixed clause set. Deliberately makes NO semantic judgment — see §5. |
| `lint-recall-surface-names-match-mechanism` | `invariant` | Structural: reads which method a route dispatches to. Classification is by mechanism, never by name. |
| `lint-registry-tree-parentage` | `invariant` | Bidirectional reachability between declared parent and child. Does NOT judge whether the placement is *correct*. |
| `migrateDispatchWithholdsAnswer` | `invariant` | Marker-gated, anchor-matched, idempotent; unknown layout → skip. |
| Capability-index relabel | `n/a — not a decision point` | Documentation truth. No behaviour changes; no endpoint moved or renamed. |

## 1. Over-block

**What legitimate inputs do these checks reject that they shouldn't?**

The real risk, and it is concentrated in one guard. `lint-blocking-decisions-declared` refuses **any**
new `.sh`/`.js`/`.mjs` file under `src/templates/` until it is declared. A contributor adding a
purely-cosmetic helper there is blocked until they classify it. That is intended friction, and it is
cheap to clear (one manifest line), but it IS a real refusal of a legitimate change.

**Measured, not asserted:** seven of the fourteen non-blocking declarations were **auto-seeded** — the
2026-08-05 census listed them in its denominator but never explicitly classified them. They are
labelled `AUTO-SEEDED` in the manifest rather than presented as reviewed. If any of those seven does in
fact make a blocking decision, the ceiling of 12 is wrong and the guard is under-counting. That is
disclosed in the data rather than hidden by it.

`lint-no-duplicate-definitions` was **narrowed twice during construction** specifically to avoid
over-blocking: a first draft policed plan-document node ids and would have fired on correct structure,
because the plan legitimately carries both a summary row and a detail row per node. A rule that must be
suppressed on the artifact it was written for is not a rule; it was removed.

`lint-dispatch-withholds-answer`'s cheaper alternative was **measured and refused for over-blocking**: a
phrase-scan for `expected:` / `should be` returned **100% false positives** on the real population.

## 2. Under-block

**What does each check certify that it does not actually measure?** Each answer is written into the
script itself, per the tooth (D) this change ratifies:

- **Blocking decisions:** a change to a file ALREADY declared blocking leaves the ratchet quiet.
- **Duplicate definitions:** prose restating a count in two paragraphs is invisible — and that is
  precisely the shape that cost five gate rounds. Also invisible: two articles under different titles
  defining one rule (the B5→B6 renumber shape).
- **Dispatch protocol:** an **ad-hoc dispatch typed into a shell heredoc**, which is exactly how the
  crystallizing failure happened. That population has no chokepoint.
- **Recall surfaces:** a recall surface nobody advertises.
- **Tree parentage:** an article that is genuinely a child but declares no parent; and whether a
  declared placement is *correct* at all, which is a judgment, not a lint.

**None of these five gaps was discovered by review. All were found by asking the newly-ratified
question of each guard before shipping it,** which is the only evidence offered that the amendment is
not prose.

## 3. Failure modes

Every guard **fails loud rather than clean** on a missing or empty population — a missing registry, an
absent template directory, a zero-article parse, and a missing `src/templates/` all exit non-zero
instead of reporting success over nothing. That is deliberate: a check reporting clean over a
population it could not read is the exact defect this batch of standards exists to refuse.

The migration fails safe in both directions: a bundled template lacking the complete protocol is
**reported rather than copied** (refusing to ship a marker without its instructions), and an installed
template with an unrecognized layout is left byte-for-byte untouched.

## 4. Blast radius

All five guards are **lint-chain only**. None gates runtime behaviour, none runs in a server process,
none can refuse a user action. The worst failure is a refused commit with a named reason.

The single runtime-visible change is the capability-index relabel: an agent reading its own capability
list now sees the hybrid endpoint recommended and the literal endpoint honestly described. No route
moved, no consumer breaks. **Promoting the meaning-based path to be the plain endpoint's default is a
behavioural change against an unapproved spec and is deliberately NOT done here.**

## 5. Signal vs authority

Every one of these five is deterministic and carries **no LLM judgment**, which is load-bearing rather
than incidental. `lint-dispatch-withholds-answer` in particular was constrained by an existing
ratified standard: deciding whether a prompt supplies an expected answer IS a natural-language meaning
judgment, and *Intelligence Infers, Keywords Only Guard* forbids a regex from making one. So the guard
enforces that the **protocol is present** and leaves detecting contamination to the reviewer the
protocol instructs. **A ratified standard's own proposed guard was forbidden by another ratified
standard** — the placement rule reduced the five, and the enforcement rules reduced them again.

## 6. Verification performed

Each guard was proven **two-sided by injection**: every refusal class deliberately introduced,
confirmed to fire, then the tree restored and re-verified byte-for-byte.

**One proof was wrong and was caught.** The recall-surface guard's first injection run showed all
B-cases exiting non-zero — but for an unrelated route-parsing error, not for the defect. The failures
looked identical to successes. **An exit code alone does not prove a check fired for its own reason.**
Every harness in this change now asserts the REASON, and that is the practice worth carrying forward.

## 7. Known-open, requiring operator ruling

The external family review returned **NOT ACCEPTED**. One finding was about this change (declared
parentage rendering as peer headings) and is fixed by `lint-registry-tree-parentage`. **Four concern
pre-existing articles and are not resolvable inside this change:**

1. A decision-authority conflict between *Intelligence Infers, Keywords Only Guard* and *The Operator
   Channel Is Sacred* over who decides a message-consuming pause.
2. Overlap across *A Wall Is a Hypothesis*, *Never a False Blocker*, and *Self-Unblock Before
   Escalating* with no stated governing boundary.
3. Operational controls (*Bounded Blast Radius*, *Capacity Safety*, *Ownership-Gated Side Effects*,
   *Live-User-Channel Proof Before Done*) sitting in a model-truths family.
4. Enforcement claims in *Session Input Is a Principal* and *Close the Loop* that their own text does
   not substantiate.

**The area-audit record cannot be written while these stand** — its verdict field accepts only
`accepted`, by design. The branch therefore stays red on the standards-coverage check. That is the
constitution refusing to grow while its family has unresolved findings, and it is correct behaviour,
not a defect to route around.
