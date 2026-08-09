# External review pass 1 — reviewer's verbatim final answer

Written 2026-08-09 after review pass 5 ruled that these judgements existed only as the author's
paraphrase and were therefore not independently auditable. That was correct and it is a real defect
in how this window was run: five external verdicts, all reported to the operator in my own words,
none of them on disk. The exploration logs (up to 2MB each) are NOT kept — only the reviewer's final
answer block, verbatim, so a later reader can grade my summaries against the source.

---

```text
FINDINGS —

1. SEVERITY: critical. No critical findings.

2. SEVERITY: major. Claim: the orphan-deferral precommit step covers commit-time and “refuses a commit whose spec defers without a tracking marker.” Specifically wrong: `instar-dev-precommit.js` exits before that step for docs-only and Tier-1 commits; therefore writing a deferral into a spec is not commit-time covered. The fingerprint manufactures an enforcement moment.

3. SEVERITY: major. Claim: `lint-deferral-referent-resolves.mjs` fails when “a marker refers to nothing” and all new orphans fail. Specifically wrong: the precommit marker accepts arbitrary issue, topic, and slug identifiers, while the lint recognizes only numeric `CMT-\d+` and `ACT-\d+` occurrences—and does not require those occurrences to be tracking markers. An unresolved `<!-- tracked: topic-new-work -->` can pass both named mechanisms. The stated residual omits this central population gap.

4. SEVERITY: major. Claim: the gap-propagation machinery records failures and “one failure upgrades every standard sharing the hole-shape.” Specifically wrong: the lint only validates voluntarily created JSON records; it cannot require a real failure to become a GAP, permits temporarily unswept gaps, and requires no remediation or closure for a matched fingerprint. Its honest certification is freshness bookkeeping, not failure capture or upgrades. The non-certification clause mentions sweep quality but omits these consequential residuals.

5. SEVERITY: major. Claim: every sweep partitions the fingerprint population and puts the question to each standard “in writing.” Specifically wrong: `matched` and `unmatched` may overlap, and `unmatched` entries may be bare strings or objects with no reason. The script therefore accepts contradictory verdicts and unsupported classifications, so even its narrower claimed guarantee is overstated.

6. SEVERITY: major. Claim: tooth (E) of *Verify the State, Not Its Symbol* is the proper owner of the gap-propagation loop. Specifically wrong: the loop is repository-governance machinery derivable entirely from code and registry structure, not a model/training property invisible from outside. It fails The Substrate’s own admission tests and belongs in Building or the registry’s joining/enforcement rules, with a cross-reference from tooth (E).

7. SEVERITY: minor. Claim: the five-term vocabulary is fixed without damaging existing terminology. Specifically wrong: the family paragraph does not define `STANDARD`, while `GAP` conflicts with the founding *Architectural Agency in the Gap* and several existing “judgment” or “enforcement” gaps; `FINGERPRINT` already denotes a different authorization-related concept. Namespacing these as `ENFORCEMENT GAP` and `ENFORCEMENT FINGERPRINT` would avoid dual meanings.

8. SEVERITY: nit. No nit findings.

COHERENCE — No. The delta introduces useful concepts, but its first fingerprint asserts a commit-time surface that is unreachable for substantial commit classes and overstates the CI population, while the propagation loop guarantees only freshness of voluntarily authored bookkeeping. Its placement also violates the family’s explicit admission rule. These are material enforcement and ownership defects, not merely editorial shortcomings.

VERDICT — reject, because the delta claims enforcement and propagation that the cited mechanisms demonstrably do not provide.
```
