# Building family review — bounded-input derivation countdown recorded as met (2026-11-18)

## What changed in the Building family

One article, one line: *Never Silently Cut the Data a Decision Depends On*, its `**Enforcement state**` paragraph.

- The proposal-day count ("five sites are converted and 45 remain baselined, so what is enforced today is no new instances") moves to past tense, as the state at proposal.
- The sentence naming the unenforced sub-obligation and its countdown `STD-SUBCOUNTDOWN-bounded-input-derivation-review` (`2026-11-22`: drive the baseline to zero, classifying each entry as converted or exempt-with-a-written-reason) is replaced by a record that the duty is met on 2026-11-18. The record cites the evidence: `docs/bounded-judgment-input-baseline.json` at zero (`grandfatheredBareTruncation: []`, `ceiling: 0`), the four batch PRs #3424, #3427, #3429 and #3435, the per-site readings in `docs/audits/bounded-input-review/batch-1.md` to `batch-4.md`, and the two entries that left earlier with their features (#2363) with no reading recorded.
- The limits the old sentence stated stay, verbatim, under "Stated limits that remain", and one is added: the scanned population is only what the detector's shapes reach, and batch 4 found a prompt cut it cannot see (`fb-5f1a0347-64b`).

No article is added, removed, renamed or re-parented. The `PARTIAL` heading stays (the operator's 2026-08-22 ruling). No other family's text changes.

## Why

The countdown's duty was met at 21:08Z on 2026-11-18 when #3435 merged. The date would still have expired: from 2026-11-23 00:00 UTC `scripts/lint-documented-only-countdown.mjs` fails on any tree whose registry still names the sub-obligation, which fails `dev:preflight` and every Local Verify run.

## Review

Round 1, author (echo:claude-code): edited the one line; ran `lint-documented-only-countdown` with the clock faked to 2026-11-24 (clean on this branch; on `main` it fails with the `STD-SUBCOUNTDOWN-bounded-input-derivation-review` expiry), and five registry unit files.

Round 2, independent verifier (a separate read-only reviewer session given the diff, not the author's conclusion): confirmed the baseline is empty with ceiling 0, the four PRs are merged, the four batch files hold 10 + 11 + 10 + 12 = 43 readings matching the 43 entries the batches started from, every row carries an outcome and a reason, and the old limits survive verbatim. Verdict accept-with-findings.

### Findings and disposition

1. **"Every baselined site was read" overclaimed**: the batches started from 43, not 45; #2363 removed two entries by retiring their features, with no reading. Resolved: the line says 43 were read and names #2363.
2. **Some rows are "refuses", which is neither converted nor exempt.** Resolved: the line says converted (disclosing, or refusing where the input is load-bearing) or exempt.
3. **A known detector blind spot went unnamed** (batch 4, `MentorStageBForensics`, `fb-5f1a0347-64b`). Resolved: named as the first stated limit.
4. **The Building area audit was stale** after the edit (`tests/unit/standards-coverage-ratchet.test.ts`). Resolved: this report, `docs/audits/bounded-input-countdown-met-building-family-2026-11-18.json`, and the ledger bound to the new area hash; floor unchanged.

Noted outside this change (the brief limited it to the registry line): stale counts in `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` (about line 1019), `docs/audits/truncated-judgment-input.md` (about lines 95 and 126), and the `_honestScope` cause in `docs/bounded-judgment-input-baseline.json`.

No unresolved design question. One decision is the operator's and is made by his review: whether the named detector blind spot should carry its own dated countdown rather than a stated limit with a feedback item.

## What this review does not establish

That each per-site reading in the batch files is right; those were reviewed in their own PRs. That the detector finds every bounded judgment input; it does not, as the line now says.

## Verdict

Building: accepted.
