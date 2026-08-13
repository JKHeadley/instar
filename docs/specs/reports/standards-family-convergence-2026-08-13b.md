# Standards area audit — 2026-08-13b (ruling 4a, archival retirement)

**Why a second audit today.** The first (`2026-08-13`) covered applying six of the seven Window-12
rulings. Ruling 4a was escalated and unapplied. It has now been ruled and applied, which amends every
area again and stales every area record — so it gets its own audit rather than riding the previous
one. An audit that covered a change made after it was written would be exactly the stale-evidence
defect the ratchet exists to catch.

**Scope.** All six areas. 25 articles gained a retirement record, 1 had its provenance relabelled, 3
gained a held-live record, and 39 citation sites gained a forwarding marker.

**Evidence classes are labelled throughout**, per the ruling addendum's fifth qualifier:
`BEHAVIOUR-PROVEN` = a check was executed and its result observed; `INSPECTION-VERIFIED` = text was
read and judged. The two are not interchangeable and this report does not let them collapse.

---

## The change

| disposition | count |
|---|---|
| retired archivally, each naming a live successor | 25 |
| relabelled, NOT retired (the sole Root article) | 1 |
| held live with owner, deadline and defined criteria | 3 |

**25 retired, not 29** — the deviation from the headline count is the substance of the ruling, not a
rounding of it.

## Structural verification — BEHAVIOUR-PROVEN

Every figure here was produced by running a check, not by reading the document.

| property | result | how |
|---|---|---|
| article count | **87**, unchanged | registry parse |
| enforcement ratio | **0.7356**, unchanged | `standards-coverage.mjs` |
| dangling references | **0** | `standards-coverage.mjs` |
| unrecognized sections | **0** | `standards-coverage.mjs` |
| declared parent relations | **13, all resolving and bidirectional** | `lint-registry-tree-parentage.mjs` |
| surviving articles declaring a retired parent | **0** | direct measurement |
| citation sites into retired articles | **39, all forwarded** | `lint-retired-article-redirects.mjs` |
| retired articles with a live, non-retired successor | **25 of 25** | `lint-retired-article-redirects.mjs` |

**The parentage lint is the positive control for the ruling itself.** It passes only because *The
Body and the Mind* is held live: five articles declare it as their parent, so retiring it would have
broken the build. The ruling held it for that reason; the lint now demonstrates the reason was real
rather than argued.

## The redirect, and why it is additive

The addendum required every inbound citation redirected. A blanket substitution — replacing the
retired article's name with its successor's — was rejected, and the reason is in the document. From
*Self-Unblock Before Escalating*: *Intelligence Infers, Keywords Only Guard* "forbids a regex from
making it". That is a claim about what **that** article says. Substituting the successor asserts the
successor carries the same obligation, which may be false — a redirect must not silently rewrite a
claim.

So each citation keeps its subject and gains `(retired <date> → *successor*)`. The reader is
forwarded at the citation site, in one hop, without any live article's claim being altered.

**The first implementation was wrong and the lint caught it.** It annotated the first occurrence per
article-pair, which left later sites unmarked — visible on a line in *Self-Unblock Before Escalating*
that cites three retired articles and carried one marker. Corrected to every site: 29 pairs became
**39 sites**. The lint also produced a false positive on itself, matching a neighbouring citation's
marker on a shared line; the anchored check that replaced it is the fix, and the false positive is
recorded here rather than quietly removed.

## Enforcement added, not just applied

`scripts/lint-retired-article-redirects.mjs`, wired into `npm run lint`, holds three properties
permanently: a retired article names a live successor that is not itself retired (no redirect into a
dead end); every citation site from a live article carries a forwarding marker; and the marker names
the same successor the retirement record names, so the two cannot drift as the document is edited.

`BEHAVIOUR-PROVEN` by reverting the defect rather than by watching it pass: stripping one successor's
markers fails the lint naming the stranded citation, and restoring them passes. A guard that has only
ever been green is being trusted, not checked.

## INSPECTION-VERIFIED — read and judged, never executed

Stated separately so it cannot be summarised as proven:

- **The root relabel preserves binding force.** `**Earned from.**` → `**Grounded in.**` on an article
  whose own text already said it is "the founding lens, not a single incident". The rule text and
  heading are untouched — that much is behaviour-proven by the unchanged count and clean parentage —
  but that the *force* is unchanged is a reading.
- **The absorption criteria are sufficient.** Each held article names what a replacement must cover,
  with all conditions required. Whether those conditions are the right ones is judgment.
- **Each retirement record is faithful to the ruling.** The prose naming what superseded each article
  and where its obligations went was read against the audit's own findings, not executed.

## Findings disposition

| # | finding | disposition |
|---|---|---|
| 1 | redirect marked first-occurrence-per-pair, leaving later sites stranded | **fixed** — every site; 29 → 39 |
| 2 | the redirect lint matched a neighbouring citation's marker on a shared line | **fixed** — anchored to the citation |
| 3 | held articles had a dated owner but no evaluable criteria | **fixed** — explicit criteria, all required |
| 4 | the deadline lived only in the tracker | **fixed** — in the document, with what happens if unmet |

No unresolved design findings. Three articles remain deliberately held, each with the conditions
under which the hold ends.

## Coverage limitations, stated

- The structural properties are machine-checked; the **prose fidelity** of 25 retirement records to
  the operator's ruling is inspection-verified by the author and was not put to an independent lens,
  because the ruling arrived and was applied inside one working session. That is a real limitation
  and it is why the evidence classes are labelled rather than blended.
- The redirect preserves each citation's original claim by construction. Whether every one of the 25
  successors is the *right* successor rests on the absorption classification from the earlier audit,
  which was independently produced but is inspection-verified, not proven.

## Verdict

**Accepted for all six areas.** Four findings, all fixed. The structural guarantees are behaviour-
proven and now permanently enforced by a lint; the judgment-bearing claims are labelled
inspection-verified and are not summarisable as more than that.
