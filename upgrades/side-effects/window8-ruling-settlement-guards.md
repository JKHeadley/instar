# Side-Effects Review — the guards shipped with the window-8 ruling settlement

**Version / slug:** `window8-ruling-settlement-guards`
**Date:** `2026-08-07`
**Author:** `Echo — Pathway (topic 29723), window 8`
**Scope:** the deterministic guards added while executing Justin's five rulings of 2026-08-07 on the
Substrate family's external review.

> **Provenance disclosure, stated because the alternative is a false claim of process.** This artifact
> was authored directly rather than emitted by the `/instar-dev` skill flow, and its trace is written
> by hand and labelled as such. The change runs the flow's SUBSTANCE — a declared decision-point
> inventory, two-sided injection proof per guard, over/under-block analysis, rollback cost — but not
> the skill wrapper. **The commit gates in this worktree are inert** (window-8 trap 1: `.husky/_` is
> generated and untracked, `git hook run pre-commit` reports no such hook), so every gate here was run
> BY HAND and this artifact exists because the discipline requires it, not because a hook demanded it.
> Reduced independence on the *authoring* of this review is the honest label. The independent
> adversarial input on this batch is the external family review that produced the findings in the
> first place — it returned NOT ACCEPTED and one of its findings refuted my own prior work.

## Summary of the change

Two deterministic guards, added alongside registry amendments that settle four decision-authority /
redundancy / placement / honesty findings raised by an external reviewer and ruled on by the operator.

| guard | what it pins |
|---|---|
| `tests/unit/emergency-stop-floor-intelligence-split.test.ts` | the emergency-stop floor is un-vetoable AND the model may add stops — union, not intersection |
| `scripts/lint-single-governing-obligation.mjs` | the exhaust-before-escalating obligation has exactly ONE declared owner, and the ladder is stated exactly once |

Neither guard changes runtime behaviour. Both are CI/dev-chokepoint checks over source and over the
registry document. No product code path is modified by either.

## Decision-point inventory

| point | classification | note |
|---|---|---|
| `emergency-stop-floor-intelligence-split` | `invariant` | Asserts disposition + method + call-count on a mocked provider. No judgment; a call either happened or did not. |
| `lint-single-governing-obligation` | `invariant` | Literal declaration presence + an exact-string occurrence count over registry articles. Closed-world format invariant at a dev-process chokepoint. |

Neither point makes an open-domain semantic judgment, which is the boundary that matters here — see §4.

## 1. Over-block

**`lint-single-governing-obligation`** is the one with real over-block surface: it can refuse a commit
because an author reworded a declaration string. That is deliberate and bounded — the strings are
declared as named constants at the top of the script, each failure message NAMES the exact string it
wanted and tells the author to update the constant in the same change, and the population
(`DETECTION_SURFACES`) is declared rather than discovered so a rename fails LOUDLY instead of silently
shrinking the check to nothing. An author who genuinely intends to reword pays one edit in the lint,
which is the correct price for a claim the registry makes about itself.

**The emergency-stop ratchet** can over-block only if the sentinel's disposition contract legitimately
changes. That is exactly when a human should be looking, so the block is the feature.

## 2. Under-block

Named honestly, because both guards have a real blind spot and neither is advertised past it:

- The lint **cannot see a paraphrase**. An author who restates the obligation in different words in a
  sibling article passes cleanly. This is not a tuning gap that could be closed by a better regex — it
  is a deliberate refusal: deciding whether new prose MEANS the same obligation is an open-domain
  semantic judgment, and *Intelligence Infers, Keywords Only Guard* forbids a regex from making it
  (window-8 trap 4 — a proposed guard can be forbidden by another ratified standard). The residual
  belongs to family review, which is where this finding came from.
- The lint's population is **declared, not discovered**: a NEW article inventing a fourth surrender
  surface and stating the obligation for it is invisible until someone adds it to the constant.
- The ratchet pins the **disposition contract, not the contents of the literal stop set**. A stop
  phrasing that neither the floor matches nor the model infers is still missed.

All three are written into the registry article text itself, not just here — so the next reader who
relies on these guards is told what they do not cover at the point of reliance.

## 3. Level-of-abstraction fit

Both sit at the level of the claim they protect. The obligation-ownership claim is a claim ABOUT THE
REGISTRY DOCUMENT, so its guard reads the registry document. The disposition claim is a claim about a
class's contract, so its guard drives that class. Neither reaches down into a layer it does not own,
and neither is a runtime gate — a registry-shape defect must not be able to refuse an operator message.

## 4. Signal vs authority compliance

The lint has **blocking authority** at a dev-process chokepoint. That is permitted under the documented
Signal-vs-Authority exemption class (Judgment Within Floors §3.6 / FD12) for a **closed-world format
invariant** — the same basis on which `lint-registry-tree-parentage` and the audit-convergence commit
gate already block. The test is a plain CI ratchet with no authority over anything at runtime.

Critically: **neither guard makes a decision about what a human meant.** The lint counts occurrences of
a declared literal and checks for declared markers; it never classifies prose intent. This distinction
is the one window-8 trap 4 exists to enforce, and it was checked against the registry BEFORE the guard
was built rather than after.

## 4b. Judgment-point check (Judgment Within Floors)

No judgment point is introduced. Both guards are deterministic and their inputs are the repository's
own committed text. Where a judgment WOULD be required (does this paraphrase restate the obligation?),
the guard deliberately declines and routes to human family review rather than approximating it — which
is the standard's requirement, not an evasion of it.

## 5. Interactions

- **Standards coverage** (`scripts/standards-coverage.mjs --check`): measured before and after. Registry
  86 articles, enforced ratio **0.7326 unchanged**, ratchets 23 → 24, dangling 0, unclassified sections 0,
  false claims 1 (pre-existing, `Cross-Store Coherence`). Deleting the DUPLICATION rather than the
  ARTICLES is why enforcement did not drop.
- **Feedback loop check** (the question the §5 template asks and the Capacity-Safety case study says
  nobody was forced to answer): does this change feed a system that feeds back into it? **No.** Neither
  guard emits, notifies, spawns, retries, or writes state. They read files and exit. There is no
  self-triggered action and therefore no convergence obligation.
- **B16/B17 tone-gate rules**: untouched. The fold deliberately preserved the two article NAMES because
  those rules, their specs, and four test files reference them by name — see §8.
- **`lint-registry-tree-parentage`**: unaffected; the fold adds no parentage claims.

## 6. External surfaces

None. No route, no config key, no CLI flag, no message. Nothing reaches a user or a peer agent.

## 6b. Operator-surface quality

No operator surface is added. The only human-facing output is a lint failure message, and each one is
written to be actionable without reading the script: it names the article, the line, the exact missing
or duplicated string, and the remedy ("delete the copy, do not reconcile it"). A failure that only said
"violation found" would have failed this section.

## 7. Multi-machine posture

Not applicable in the runtime sense — these are CI/dev checks that run in a checkout, not on a machine
in the pool. There is no per-machine state, no lease interaction, and no replication surface.

## 8. Rollback cost

**Low and independent per guard.** The test is deletable with no dependents. The lint is removable by
deleting the script and its one entry in the `lint` chain in `package.json`. Neither guard is cited as
enforcement by any article other than the one it was built for, so removing either would drop that
article's classification toward `documented-only` — which the standards-coverage floor would surface
LOUDLY rather than let pass silently. That is the correct rollback signal.

**The registry amendments** are ordinary document reverts. The one with a genuine ripple is the fold:
it was deliberately executed as duplication-deletion rather than article-deletion precisely to keep
rollback cheap and to avoid stranding ~20 references across specs and tests.

## Conclusion

Ship. Both guards are two-sided, both blind spots are declared at the point of reliance, and neither
introduces a runtime decision, a self-triggered action, or an external surface.

## Evidence pointers

- Settlement + case studies: `docs/audits/phase-b/window8-review-settlement.md`
- External review transcript: `docs/audits/phase-b/substrate-family-review-2026-08-06.txt`
- Injection proofs: tabled in the settlement doc, §1 and §2, each injection recorded with the specific
  failure REASON it produced and which sibling arms still passed. **One injection attempt in §1 failed
  to compile and was caught only because the reason was checked rather than the exit code.**
