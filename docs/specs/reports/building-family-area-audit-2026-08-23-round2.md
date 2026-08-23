# Building family — area audit, round 2 (2026-08-23)

**Status: CLOSED — ACCEPTED for the coverage claim**, with five findings recorded
as family debt and none contradicting the claim. Round 1's record is
`docs/specs/reports/building-family-area-audit-2026-08-22.md`; this round supersedes
it as the audit backing `docs/standards-registry-area-audits.json` for Building.

## Why this round was triggered

Round 1 certified the Building family at content hash `c7604858900a…`. Two things
have changed that hash since:

1. **`Never Silently Cut the Data a Decision Depends On`** joined the family (the
   article this branch adds), taking it from 40 articles to 41 — the trigger round 1
   already covered.
2. **`An Instar Agent Is Always a Multi-Machine Entity` was amended on canonical
   main** by PR #1960 (the five multi-machine amendments, operator-ratified
   2026-08-23). Round 1 could not have seen this: it ran against a branch cut before
   that merge.

Merging main into this branch therefore produced a family content hash
(`05d92649023c…`) that **neither** prior audit attests. Round 1's record certifies a
tree that no longer exists, and main's record (`standards-area-audit-2026-08-22.json`,
`2dc398241234…`) certifies a tree without the new article. A union of two separately
attested halves is not itself attested — which is precisely the staleness the area
gate exists to catch, and it caught it.

## Method

Identical to round 1, so the two rounds are comparable: an external adversarial pass
through the cross-model reviewer (`codex-cli`, `gpt-5.5`), dispatched with the
author's conclusions withheld — the reviewer received the merged family text and the
standing reviewer prompt, nothing else.

**The full family text reached the reviewer.** The assembled prompt reports
`promptTruncated: false` over all 202,765 bytes of the merged family. This is
recorded rather than assumed because the article under audit in this very branch is
about judgments made on silently-cut input: a truncated review that returned
"looks fine" would be the exact failure the article names, committed by the audit
of the article. It was checked, not hoped for.

Reviewer verdict: **SERIOUS ISSUES**.

## Findings (verbatim from the external reviewer)

**Verdict: SERIOUS ISSUES**

1. **Scope Is Constitutionally Overloaded Across Many "Root" Articles.**
   References: many `Tree placement. ROOT / FOUNDATIONAL` sections.
   The source repeatedly declares articles root/foundational while also saying several
   are children, merged subsections, siblings, or cross-family descendants. This makes
   the architecture hard to reason about: a reader cannot tell whether "root" means
   normative priority, taxonomy placement, or merely "no parent found yet."
   *Resolution:* add a small formal ontology — `root`, `child`, `merged subsection`,
   `cross-family dependency`, `operational specialization` — with precedence rules.

2. **Too Many Rules Depend On Reviewers While Claiming Structural Discipline.**
   References: `Constitutional Traceability`, `Conservative Outbound`, `Iterative Audit
   to Convergence`, `An Instar Agent Is Always a Multi-Machine Entity`.
   The source is admirably honest about "judgment-bound" and "unenforced
   sub-obligations," but the overall pattern still leans heavily on LLM/spec-converge
   reviewers for semantic authority. That creates a meta-risk: the system's safety story
   depends on recurring high-context LLM judgment, while several articles exist because
   blind or truncated judgment failed.
   *Resolution:* distinguish "mechanically enforced," "reviewer-enforced," and
   "aspirational" in article metadata, not prose, and produce a registry-level risk rollup.

3. **The Multi-Machine Survivability Rule Needs a Distributed-Systems Design Alternative.**
   Reference: `An Instar Agent Is Always a Multi-Machine Entity`.
   The source says any single machine must lose resources but never information, and
   rejects memory-bearing `proxied-on-read`. That is a strong outcome, but the spec does
   not compare standard industry patterns: event-sourced append logs, CRDTs, local-first
   sync, SQLite replication, Raft-style authority, or encrypted object replication.
   *Resolution:* require a design note explaining why the chosen state-sync/memory
   mechanism beats local-first/event-log replication, or adopts one.

4. **Lease Language Risks Overselling "Clock-Proof" Correctness.**
   Reference: `Cross-Machine Coherence`.
   The source says only one lease epoch is ever valid via monotonic epoch-CAS, while
   partitions may produce two believers. That is plausible only if the CAS authority
   itself remains linearizable and reachable enough. The dependency is not stated plainly.
   *Resolution:* name the lease store's consistency assumptions and failure behavior when
   the CAS authority is partitioned, unavailable, or split.

5. **Spec Is Too Verbose For Operational Use.**
   Reference: entire document.
   The source contains valuable incident provenance, but many articles embed long
   historical argument inside the normative rule. This weakens clarity and makes
   enforcement obligations hard to extract.
   *Resolution:* split each article into `Rule`, `Required Checks`, `Failure Mode`,
   `Known Gaps`, and move incident narratives to linked provenance.

## Disposition

The question an area audit answers is narrow: **does this family's coverage claim
still hold?** — that the articles and the guards they cite are as the record
describes. It is not "is the constitution well designed." Round 1 recorded that
boundary and this round keeps it, so the two verdicts mean the same thing.

### F1 — "root/foundational is overloaded" — ACCEPTED, tracked, non-blocking. NEW.

Round 1 did not raise this. It is a real ambiguity: `Tree placement.` prose uses
`ROOT` / `FOUNDATIONAL` / `CHILD` / `merged subsection` without a stated precedence,
while the machine-readable relation is only the declared parent/child rendered by
`scripts/generate-standards-hierarchy.mjs`. A reader hitting "ROOT" cannot tell
whether it outranks a sibling or merely has no declared parent.

Two honest notes. The declared tree *is* generated and drift-checked — the vocabulary
gap is in the surrounding prose, not in the data. And the fix is a presentation and
metadata change: it alters no article's requirement, so it cannot invalidate the
coverage claim. Recorded as family debt.

### F2 — "leans on reviewers while claiming structural discipline" — ACCEPTED, restated from round 1 F2/F3.

The reviewer's sharpest recurring point, now aimed one level deeper: not "rules
overstate enforcement" but "the *enforcement class* lives in prose where tooling
cannot consume it."

This is the same discipline the article added in this branch introduces for one
class of judgment, and the same debt round 1 recorded — an independent second
reviewer arriving at it unprompted raises its priority rather than closing it.
Non-blocking for the same reason as round 1: the coverage measurement reports the
real enforced ratio independently of what any article's prose claims.

### F3 — "multi-machine rule needs a distributed-systems alternatives note" — ACCEPTED, tracked, non-blocking. NEW, and about the amended article.

Worth surfacing rather than folding into round 1's F5: this lands on
*An Instar Agent Is Always a Multi-Machine Entity*, the article whose amendment on
main triggered this round. The reviewer is right that the article records the
incidents that produced its mechanism and not the alternatives weighed against it.

Non-blocking: it concerns the justification for a mechanism, not whether the
mechanism is in force. Recorded as family debt, and it is the strongest candidate of
the five to pay down first, because it attaches to freshly-ratified text where the
reasoning is still recoverable.

### F4 — "lease 'clock-proof' language oversells" — ACCEPTED, tracked, non-blocking. NEW, and the most substantive.

The reviewer is correct on the mechanics: monotonic epoch-CAS gives at-most-one
*valid* epoch only while the CAS authority is itself linearizable and reachable.
*Cross-Machine Coherence* states the guarantee without stating that precondition.

Recorded honestly and deliberately not talked down: an unstated precondition on a
safety guarantee is a claim-precision defect, and this family's own articles say so.
It is non-blocking for the coverage claim in the narrow sense that the guard the
article cites exists and does what the record says — but this is the finding most
likely to matter in an incident, and it is named here so a later reader cannot say
the audit passed silently over it.

### F5 — "too verbose for operational use" — ACCEPTED, duplicate of round 1 F1.

The same contract-surface request, unchanged: a generated per-article summary of
rule, checks, failure direction, and known gaps, with incident history secondary.
Already tracked; the repeat is evidence the debt is real, not a new item.

## What this round does NOT claim

Round 1 rebutted its own F4 ("no mechanism proves countdowns are enforced") with
`scripts/lint-documented-only-countdown.mjs`. This round's reviewer did not raise it;
that silence is **not** a re-confirmation, and the rebuttal stands on the earlier
evidence, not on this round's absence of the finding. Recorded so a later reader does
not read one round's silence as two rounds' agreement.

Nothing here rebuts any of the five. Round 1 could prove one finding factually wrong;
this round could not, and says so rather than manufacturing symmetry.

## Verdict

**ACCEPTED for the coverage claim over Building at `05d92649023c…`**, with five
findings recorded as family debt, three of them new.

Stated precisely: this accepts that the family's articles and their cited guards are
as the record describes, over the merged content that neither prior audit covered. It
does **not** claim the family is well structured — the reviewer says it is not, in
five specific ways, and those are written above rather than dissolved into the word
"accepted."
