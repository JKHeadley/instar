# Standards area audit — 2026-08-22 (ratifying the five multi-machine amendments)

**Why this audit exists.** The operator approved five amendments to *An Instar Agent Is Always a
Multi-Machine Entity* on 2026-08-22 (topic 52222). Four amend that article (family **Building**);
the fifth became a new article, *Archiving May Never Mean Deleting*, filed as a tree node under
*Deferral = Deletion* (family **The Substrate**). Amending a family invalidates its audit, so both
families are re-audited here. **Interaction, Shipping, The Fractal and The Root are untouched and
are NOT re-attested** — their 2026-08-13c records stand.

**Evidence classes are labelled throughout.** `BEHAVIOUR-PROVEN` = a check was executed and its
result observed. `INSPECTION-VERIFIED` = text was read and judged. They are not interchangeable.

**Scope, stated plainly rather than implied.** This is a DELTA audit. The two families' content is
unchanged apart from the amendments themselves, and the 2026-08-13c review accepted the remainder.
What is newly reviewed here is (a) every clause the amendments add, and (b) the cross-article
question a new article forces — does it contradict anything already in either family? The
inherited acceptance for unchanged articles is stated as the basis, not concealed inside a verdict.

---

## Reviewers and the convergence criterion

| lens | who | rounds |
|---|---|---|
| authoring + placement | echo (claude-opus-5) | 1 |
| external adversarial (contradiction / over-claim / loophole / subject-drift) | `codex-cli` | 4 |
| convergence criterion | a full re-review returning **NO NEW FINDINGS** | met at round 4 |

The external lens was instructed to REFUTE, not to approve, and was told explicitly in the final
round not to invent a finding to appear rigorous. Findings per round: **9 → 4 → 2 → 0.**

## What the external lens caught, and why each mattered

Nine findings across three rounds. Six changed the constitutional text materially; they are listed
because a review whose findings are invisible in the artifact is indistinguishable from no review.

1. **`proxied-on-read` contradicted the new survivability clause.** `INSPECTION-VERIFIED`. The
   article enumerated a posture — a named remote read — that its own new Rule forbids. Both were
   citable against the other. **Acted on:** the enumeration now annotates it operational-only and
   invalid for memory-bearing state, and the Rule says so directly.
2. **The new key was RENEWABLE, not self-terminating.** `BEHAVIOUR-PROVEN` — the first draft's own
   "good" fixture used `expires=2099-01-01` and PASSED. An expiry with no ceiling buys unbounded
   time. **Acted on in two steps, because the first was insufficient:** a 180-day maximum horizon
   (round 3), then `since=` plus a 360-day TOTAL-LIFETIME cap (round 3) after the lens observed
   that a per-declaration horizon is renewable and that assigning the residue to semantic review
   does not close it. A rewritten `since` is recorded as falsification, not as a closed hole.
3. **The same loophole, re-created one key over.** `INSPECTION-VERIFIED`. Round 3 gave the TEMPORARY
   `physical-credential-locality` barrier a deadline but no lifetime cap — reintroducing, on the
   older key, exactly what had just been closed on the newer one. **Acted on:** the TEMPORARY
   barrier now carries the identical `since=` + 360-day cap. Worth recording as its own finding:
   a fix patterned on another fix inherited the defect the pattern had already been corrected for.
4. **Erasure authority is not only the operator.** `INSPECTION-VERIFIED`. The carve-out recognised
   only an operator request, while an erasure obligation can originate with a data subject or the
   law — forcing a choice between the constitution and compliance. **Acted on:** the carve-out
   covers a lawful erasure obligation, the **Fails.** line was corrected where it had quietly
   re-narrowed the carve-out the Rule had just widened, and a PROPAGATION condition was added —
   a permitted deletion must reach every duplicate, derived summary and index. That condition is
   what makes the article's own duplication rule safe rather than a preservation loophole.
5. **Over-claims.** `INSPECTION-VERIFIED`. Two: "Amendments 3 and 5 are ENFORCED" read as covering
   the semantic claims the parser cannot verify; and three days of compressed message text was
   extrapolated to "affordable on any hardware." **Acted on:** the first is now "deterministically
   CHECKABLE marker contracts", with shape-versus-semantics spelled out in the same sentence; the
   second is scoped to its sample, with the obligation explicitly not resting on the measurement.
6. **The continuity test begged the question for dual-purpose records.** `INSPECTION-VERIFIED`. A
   judgment rationale is simultaneously provenance and something a successor needs, and two
   reviewers could classify it oppositely while both citing the text correctly. **Acted on:** a
   precedence rule — a bounded operational store may hold and age its COPY, but may never be the
   ONLY copy of memory-bearing content. Disagreement resolves by duplication, not adjudication.
   A late round-4 finding then required the replacing summary to OMIT erased material, closing the
   path by which "replace the source with a summary" could preserve exactly what had to go.

## Structural verification — BEHAVIOUR-PROVEN

| property | result |
|---|---|
| articles | **89** (88 + *Archiving May Never Mean Deleting*) |
| registry canary — unrecognized article sections | **0** |
| dangling refs / false claims | **0 / 0** |
| parentage relations | **40, all resolving and bidirectional** |
| placement declarations | **78 of 89** (11 grandfathered, shrink-only) |
| hierarchy block | current (`--check` clean) |
| marker-lint self-tests | **21 passing**, both directions per new contract |
| marker-lint sweep over `docs/specs/**` | **94 → 135 findings** (report-only) |

## The sweep number, read honestly

The narrowing moves the corpus report from 94 findings to 135: **16** `physical-credential-locality`
markers that never named who forbids the move, and **9** postures thereby left undefended. That
rise is the amendment working — it is the population the operator predicted when he said he did not
accept that a login must live on one machine. **It is not fixed here.** Repairing those 16 is
separate work, and folding it into the ratification would have made the ratification unreviewable.

## Enforcement honesty — the asymmetry, restated because it is the thing most likely to rot

Amendments 3 and 5 are checkable and checked. Amendments 1, 2 and 4 are NOT, carry no guard, and say
so in the registry with dated countdowns (`STD-SUBCOUNTDOWN-multi-machine-survivability`,
`STD-COUNTDOWN-archiving-never-deletes`, both `2026-09-22`). No guard was cited for them.
*Cross-Store Coherence* records that naming a guard in prose made an article classify as ENFORCED by
a guard measuring something else, and that the enforcement ratio rising on an edit that built
nothing was the tell. Reproducing that inside the article being amended for honesty was the specific
outcome this audit was watching for.

## What this audit does NOT establish

- It does not establish that the enforced ratio is unchanged: this checkout could not obtain a
  trustworthy protected-base measurement until `refs/remotes/upstream/main` was fetched, and the
  per-area ratios still read 0 from the legacy ref-resolution path. The authoritative before/after
  is CI's, on a tree where the reference resolves.
- It does not review the 61 articles in these two families that the amendments did not touch. Their
  acceptance is inherited from 2026-08-13c and is stated as inherited.
- It does not, and cannot, verify the semantic truth of any marker the new contracts will accept.

## Verdict

**Building — ACCEPTED.** `areaSha256` `2dc3982412341ab62ba2789b1ba3ae9a96430c110e1659e7faab72e968aced72`.
**The Substrate — ACCEPTED.** `areaSha256` `83b311b42cfca904f3bf75c23a8b5990c13729cc2926b92c2b4f2d51929c0fe1`.

Accepted for CONTENT. Neither verdict speaks to the standards direction guard, which independently
requires an operator-signed ratification per changed article and whose approver key is an empty
placeholder in protected main. That gate is unresolved, is named in the pull request, and is not
something this audit can or should clear.
