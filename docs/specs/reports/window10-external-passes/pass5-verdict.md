# External review pass 5 — reviewer's verbatim final answer

Written 2026-08-09 after review pass 5 ruled that these judgements existed only as the author's
paraphrase and were therefore not independently auditable. That was correct and it is a real defect
in how this window was run: five external verdicts, all reported to the operator in my own words,
none of them on disk. The exploration logs (up to 2MB each) are NOT kept — only the reviewer's final
answer block, verbatim, so a later reader can grade my summaries against the source.

---

```text
FINDINGS —

1. **major — The fingerprint and deferral baselines are not shrink-only ratchets.** `scripts/lint-enforcement-fingerprint.mjs:160-199` and `scripts/lint-deferral-referent-resolves.mjs:177-198` compare only the current registry to the current baseline. A change can add a fingerprint-less article to both the registry and `grandfathered`, or add an orphan marker to both the corpus and `orphans`, and remain clean. Neither check compares against the accepted Git state. Therefore “may never be added back,” “the debt can only be paid down,” and “a new orphan fails immediately” are manufactured enforcement claims.

2. **major — The enforcement-gap floor does not make gaps undeletable.** `scripts/lint-enforcement-gap-records.mjs:188-205` only cross-checks the two current JSON files. Deleting an ID simultaneously from `docs/enforcement-gaps.json` and `docs/enforcement-gaps-floor.json` passes. Alternatively, adding `{id}` to `retired` passes without the promised reason, date, or evidence. Duplicate gap IDs are also unchecked. The purported external grow-only floor is another editable list, not historical enforcement.

3. **major — The deferral resolver treats ordinary prose as identifiers and manufactures resolution.** `TOKEN_RE` at `scripts/lint-deferral-referent-resolves.mjs:101` accepts every three-character alphanumeric word, and lines 146–155 mark a whole marker resolved when any such word occurs outside `docs/`. A live marker containing only prose—`a future "swap-target output sanity" hardening...`—therefore resolves through common words such as `future`. The 217 objects are marker payloads, not 217 identifiers; I found 25 multi-token marker occurrences and 275 distinct parser “tokens,” many ordinary words. Consequently, the reported 114 resolved markers and the claim that the guard verifies a followable referent are not trustworthy.

4. **major — Pass 4’s manufactured gap record remains manufactured.** `GAP-watched-but-unauditable.shapeDescription` still says “The moment IS covered” and its population “plausibly covers the violation,” while its corrected `evaded.how` says coverage is unknown and the named article had no fingerprint. The lint merely checks that `evaded.standard` is truthy; it never requires it to resolve to a real fingerprint. The live record therefore names `Self-Unblock Before Escalating (which carried NO enforcement fingerprint...)` as the fingerprint evaded, and the registry reports clean. This is both an internal contradiction and failure of the load-bearing three-leg validation.

5. **minor — The Substrate’s enforcement account is stale.** Its introduction says the current density is 16/26 and specifically calls *Deferral = Deletion* genuinely unguarded. `scripts/standards-coverage.mjs --json` derives 17/26, because that article is now classified as enforced through the new lint. The family’s summary contradicts its current member text and repository measurement.

6. **minor — Superseded deferral figures remain asserted as current in the guard source.** `scripts/lint-deferral-referent-resolves.mjs:16-17,57-63` still says 194 markers, 104 orphans, and a baseline of 104. The live check reports 217/103, and the registry explicitly labels 194/104 as superseded. This is the same stale self-description class pass 4 claimed to have corrected.

No critical findings. No nit findings.

MY-ACCOUNT-CHECK — The versioned engineering summaries corroborate pass 1 as 6 major, pass 2 as 7 major plus 2 minor, and pass 3 as 6 major plus 2 minor, all rejects with no criticals. They also corroborate the first two fix grades: 2 HELD/4 PARTIAL and 4 HELD/4 PARTIAL. Pass 4’s record verifies seven numbered findings and a reject, and their nature is consistent with four load-bearing findings plus two lighter defects and one wording nit, but it does not preserve the raw severity labels. I could not find the promised primary pass reports under `docs/specs/reports/`; the repository contains the interested author’s engineering summaries instead. I also could not independently verify the supplied third fix-grade split of 4 HELD/2 PARTIAL/2 wrong-as-stated. Thus I found no affirmative numerical contradiction, but the pass-4 severity split and final grade are not independently auditable as claimed.

MAGNITUDE-METRIC — The critical metric is **load-bearing enforcement-integrity magnitude**: how many defects let machinery certify a state it has not established, weighted by the breadth of the machinery affected. This matters more than total count because a typo affects one reader, while an editable “grow-only” floor or a false resolver invalidates every future decision that relies on it.

TRAJECTORY — Magnitude on that metric is **not genuinely declining across passes 1–5**. Passes 1–3 repeatedly found foundational defects in population selection, reachability, staleness, partitioning, and baseline membership. Pass 4 still had four major/load-bearing defects: invented fingerprint evasion, re-stamping presented as re-reaching, incomplete digest coverage, and duplicate acceptance. Pass 5 again has four major/load-bearing defects: two history-free ratchet/floor mechanisms, a resolver that promotes ordinary prose into evidence, and the still-contradictory gap record. Raw totals appear to move 6 → 9 → 8 → 7 → 6, and major counts roughly 6 → 7 → 6 → 4 → 4, but the decisive series has stalled: pass 5 remains inside the machinery and affects multiple future standards and gaps. The remainder has not shifted to merely descriptive, expiry-dated work.

COHERENCE — No. The philosophical rules are largely reconcilable, but the current enforcement account is not: the text calls baselines irreversible that can be co-edited freely, calls ordinary-word matches followable referents, simultaneously asserts and withdraws coverage for the same enforcement gap, and reports two different current Substrate densities. A reader cannot safely use the registry’s clean machinery result as evidence for the protection it claims.

VERDICT — **reject.** Closing is blocked by four active, load-bearing enforcement defects: the fingerprint/deferral baselines lack historical comparison, the gap floor is removable or reasonlessly retireable, the deferral resolver accepts prose as a referent, and the gap registry still accepts a nonexistent fingerprint as its evaded mechanism. These are not expiry-dated residual work; they are present correctness failures in the mechanism used to establish convergence.
```
