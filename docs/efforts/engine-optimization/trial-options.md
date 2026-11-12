# Pilot round 2: the tripwire fired, so the spec stops here (no round 3)

**Health line.**
- Distinct DESIGN findings: round 1 had 9; round 2 has 7. Astra raised 6 (statistics ×2, denominator, missingness, lease, token settlement). Fable raised 4 (margin, clustering, gate-skip location, lease), with most overlapping Astra's.
- Not halved, so the step-2 tripwire fires.
- New mechanisms added in round 2: none. But the findings now require cluster-aware inference, multiplicity control, simulation-validated operating characteristics, lease-epoch binding and ingestion-completeness proofs.

**Judgment.** This is the accretion pattern again. Round 1 showed the rigorous quality claim is out of reach at this volume. Round 2 shows that even an honest three-way verdict needs statistics-grade machinery: 7 day-clusters per arm, permutation tests, a pre-registered margin, and multiplicity. Under the post-step-2 rule, an author may not override the tripwire alone. So there is no round 3, and the decision goes to Justin.

**Options for Justin:**
- **A.** Keep the rigorous experiment. This needs several more rounds and statistics-grade machinery, and it is the most expensive option.
- **B. Descriptive trial (recommended).** Same overlay and arms, but no automated verdict. The report shows per-day tables of cost and failures, plus the hard mechanical checks (the flag was applied; there were no flag-caused spawn errors). The maturation review and Justin judge from those tables. This is much smaller, and claims nothing statistical.
- **C. No trial.** Set `thinkingMode: low` by judgment on a few clearly routine jobs, after the mechanism lands. Watch the per-run records and the existing failure-callout and anomaly monitors, and revert on breakage. This is the cheapest option and fully reversible.

**Valid findings to carry into whichever option is chosen:**
- assignments are recorded at `triggerJob` (pre-gate), with a `runId` link;
- the per-run token query, with a real ingestion-completeness check;
- missing-day detection against the cron-expected count;
- the dark-gate exclusion entry;
- the record size budget.
