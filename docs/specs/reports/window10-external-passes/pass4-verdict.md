# External review pass 4 — reviewer's verbatim final answer

Written 2026-08-09 after review pass 5 ruled that these judgements existed only as the author's
paraphrase and were therefore not independently auditable. That was correct and it is a real defect
in how this window was run: five external verdicts, all reported to the operator in my own words,
none of them on disk. The exploration logs (up to 2MB each) are NOT kept — only the reviewer's final
answer block, verbatim, so a later reader can grade my summaries against the source.

---

```text
FINDINGS

1. SEVERITY: major — The digest prevents stale verdicts — PARTIAL. It hashes the whole article and every verdict has `atDigest`, but changing the enforcement-gap shape, sweep method, cited guard implementation, or supporting evidence leaves every verdict valid. A reviewer can also copy the new digest without reconsidering the verdict; the lint cannot prove “re-reached rather than re-stamped.”

2. SEVERITY: major — The corrected 194/104/54% measurement covers all tracking markers — Wrong. The submitted parser accepts only single-token payloads; an independent re-derivation finds 217 distinct marker payloads, 23 more than the claimed population. The live uncommitted widening now reports 217/103 while the family still says 194/104.

3. SEVERITY: major — Unsupported outbound enforcement was withdrawn — PARTIAL. *Self-Unblock* now honestly says the motivating failure passed and its real coverage is absent, but *Verify the State*, the measurement report, and `GAP-watched-but-unauditable` still say the moment “IS covered” by rules that “plausibly cover” it. Worse, the gap claims to have evaded a *Self-Unblock* fingerprint although that article has no enforcement fingerprint. This remains manufactured enforcement. Sovereignty’s withdrawal holds.

4. SEVERITY: major — The account reflects the current fingerprint rollout — Wrong. *Verify the State* says “no standard carries a fingerprint field,” and the measurement report says 86 of 87 lack one; the lint reports 6 fingerprinted and 82 missing among 88 articles.

5. SEVERITY: minor — All future-dated records were corrected — Wrong. `docs/deferral-referent-baseline.json` still records `measuredAt: "2026-08-09"` on 2026-08-08.

6. SEVERITY: minor — Sweep population membership is exact — Overstated. Membership is compared as sets, so duplicate population or verdict entries pass; the check establishes set coverage, not an exact one-record-per-standard population.

7. SEVERITY: nit — The affected-family prose is cleanly synchronized — Wrong. It says “Three teeth” while enumerating A–D after adding tooth E, repeats “the legitimate options are,” and contains the broken splice `CLAUDE. … .md default-route section`.

Critical severity: empty.

FIX-VERIFICATION

1. PARTIAL  
2. HELD  
3. PARTIAL  
4. HELD  
5. PARTIAL  
6. HELD  
7. HELD  
8. HELD

COHERENCE

No. The local Deferral coverage correction is coherent, but the registry simultaneously says fingerprints do and do not exist, reports obsolete population totals, and describes *Self-Unblock* as both demonstrably uncovered and as having a fingerprint that a covered-moment failure evaded.

VERDICT

reject — the fourth pass still contains manufactured enforcement, a materially incomplete staleness mechanism, and multiple current-state claims contradicted by the repository.
```
