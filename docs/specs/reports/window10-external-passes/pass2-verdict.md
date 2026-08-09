# External review pass 2 — reviewer's verbatim final answer

Written 2026-08-09 after review pass 5 ruled that these judgements existed only as the author's
paraphrase and were therefore not independently auditable. That was correct and it is a real defect
in how this window was run: five external verdicts, all reported to the operator in my own words,
none of them on disk. The exploration logs (up to 2MB each) are NOT kept — only the reviewer's final
answer block, verbatim, so a later reader can grade my summaries against the source.

---

```text
FINDINGS —

1. SEVERITY: major. Claim: sweeps remain fresh against every enforcement fingerprint. What is wrong: `fingerprintPopulation` stores only article names, not fingerprint content or hashes. Changing a fingerprint’s moments or surfaces does not stale any sweep. The submitted data proves the defect: *Deferral = Deletion* now declares only `ci-time`, while `GAP-no-moment-declared` still says it declares commit-time and CI, and `GAP-alive-but-inert` remains matched because of the withdrawn commit-time arm. The lint nevertheless reports clean.

2. SEVERITY: major. Claim: *Deferral = Deletion* left the shrink-only fingerprint baseline. What is wrong: `docs/enforcement-fingerprint-baseline.json` still contains it—87 entries although only 86 articles lack fingerprints. The lint compares counts using `missing.length > grandfathered.size` instead of requiring exact membership, so this violation passes. The registry’s “first article to leave” statement and the gap record’s outside-population count of 86 are therefore false.

3. SEVERITY: major. Claim: the deferral population and measurement were corrected consistently. What is wrong: the executable count is correctly 194 markers, 92 numeric CMT/ACT markers, 102 other markers, and 104 unresolved—54% rounded—and the 81→104 re-baseline reason is recorded. But tooth (E), `GAP-alive-but-inert`, and the deferral lint’s own header still state the discredited 62%/178/110 measurement as though it described tracked markers. The functional widening holds; the constitutional record does not.

4. SEVERITY: major. Claim: the four-part non-certification clause was added to both the script and registry. What is wrong: the script lists four limitations, but the Building article lists only three; it omits that a dated unswept gap is not guaranteed to be swept. This asserted second-pass fix was only half made.

5. SEVERITY: major. Claim: malformed and reasonless verdicts fail. What is wrong: overlap and bare-name verdicts are now rejected, but `why` is checked only for truthiness. Values such as `why: true`, `why: []`, or `why: {}` pass as “reasons”; shape descriptions and dates are similarly not type-validated. The article’s broad “malformed gap” and “must give a reason” fingerprint exceeds the condition implemented.

6. SEVERITY: major. Claim: the colliding terms were namespaced as ENFORCEMENT GAP and ENFORCEMENT FINGERPRINT. What is wrong: the family text uses those names, but both lint scripts and `docs/enforcement-gaps.json` still declare the fixed canonical vocabulary as bare GAP and FINGERPRINT. Two competing vocabularies remain in authoritative artifacts.

7. SEVERITY: major. Claim: there is no manufactured enforcement in the delta. What is wrong: *Self-Unblock Before Escalating* says the outbound gate “already hard-blocks” the relevant failure modes even though the cited incident passed and no verdict record can show what happened; the underlying B16/B17 rules explicitly favor false negatives and exempt genuine runtime blockers. *Sovereignty* similarly says the gate covers its main observable failure without evidence that the gate can establish ownership. Declining an `Applied through` citation does not make those coverage assertions true.

8. SEVERITY: minor. Claim: the moved article has a coherent parent/cross-reference shape. What is wrong: placement in Building and tooth (E)’s one-way cross-reference are correct, but the article adds `Parent: Verify the State, Not Its Symbol`, which is neither the registry’s recognized structural syntax (`a tree node under`) nor its lineage syntax (`Parent principle →`). Consequently the generated hierarchy records no such relationship.

9. SEVERITY: minor. Claim: a marker resolves through something the repository can show a reader. What is wrong: the lint excludes every file under `docs/` from resolution while its diagnostic recommends pointing at “a spec section.” A documentation referent therefore cannot satisfy the implementation despite being advertised as valid.

No critical or nit findings.

FIX-VERIFICATION —

2. PARTIAL — the fingerprint field dropped commit-time, but the coverage argument and sweep records still claim it is covered.

3. PARTIAL — the guard population and headline arithmetic are corrected, but the old invalid measurement remains asserted elsewhere.

4. PARTIAL — all four limitations appear in the script, only three in the registry.

5. HELD — matched/unmatched overlap and bare-name verdicts are rejected; finding 5 above is a new type-validation defect.

6. HELD — the obligation moved to Building and tooth (E) retains only a cross-reference, with one governing owner.

7. PARTIAL — the family article is namespaced, but its implementation and data registry still canonize the bare terms.

COHERENCE — No. The move to Building is substantively right and the 194/104 measurement is reproducible, but the submitted state contains mutually incompatible accounts of the commit-time surface, population measurement, baseline membership, and canonical vocabulary. Most importantly, the new propagation mechanism reports clean while its stored verdicts describe an obsolete fingerprint, so its own enforcement fingerprint overstates what freshness it maintains.

VERDICT — reject, because the central sweep-freshness guarantee is content-blind and multiple claimed second-pass corrections remain incomplete or contradicted by the submitted repository state.
```
