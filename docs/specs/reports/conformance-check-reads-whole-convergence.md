# Convergence Report — The constitution check reads a spec whole, or says it did not check

**Spec:** [docs/specs/conformance-check-reads-whole.md](docs/specs/conformance-check-reads-whole.md)
**Slug:** `conformance-check-reads-whole`
**Converged at:** 2026-11-27, at the Tier 1 round cap (3 of 3)
**Iterations:** 3
**Final-round design findings:** 5 from the cross-model pass, each corrected in the text after the round and not re-reviewed (see Left behind); 0 from the six internal lenses.

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier pass ran through the agent's Codex CLI in all three rounds, and each returned a result (round 1 first failed to start because the framework was named `codex` instead of `codex-cli`; it was rerun at once). Gemini is not installed on the M5 Pro, where the pass ran (it is on the Studio). The Claude reviewer framework was available but, being the same family as the internal lenses, was not used as a cross-model pass.

## ELI10 Overview

Every design for Instar is checked against Instar's rule book by a built-in checker before anyone approves it. On 27 November two faults came to light. The checker read only the first 24,000 characters of a longer design and judged the cut text as if it were the whole, so long designs were flagged for problems their later pages had solved. And when the checker could not run at all, it handed back an empty list, which looked exactly like "no problems found"; a failed check was reported upward as a clean pass.

This change makes the checker send the whole design every time, and say plainly "not checked, and why" whenever it could not judge, on every surface that uses it: the reply, the record approvals are checked against, the command-line tool, the review instructions and the note agents read before asking for an approval. Because the checker varies between runs, the record now counts every run of the exact same text on every machine, so an approval request cannot quote only the cleanest run. Nothing here blocks work: the checker still only advises.

The trade-off: a design too long for the model is refused as not checked, rather than judged in parts, because a part cannot see the section that answers its concern.

## Original vs Converged

- **Time.** Originally the review and the fit judgment each had 150 seconds inside a 180-second request, and the command-line tool gave up at 60 seconds and blamed the server, so a long design came back as a timeout instead of "not checked". After review, both calls share what is left of the 180 seconds, the tool waits 200 and reports a timeout as NOT CHECKED, and the skill waits at least 200.
- **The record approvals are checked against.** Originally it kept one machine's runs, could be seeded from old runs that had judged a cut design, lost a text's runs on a revert, cut its own lines at 2,600 characters, and silently capped the standards list. After review, only whole-text runs count, every machine's runs of the same text are added together (including texts a machine has moved past), old-reviewer records are marked `legacy`, a revert resumes its text's count, nothing is cut mid-line, and anything left out is counted and said.
- **The fit judgment.** Originally its failure was invisible to the approval reviewer, and it was skipped after a too-long review. After review, its outcome is recorded and an approval that claims "fits its principle" from an unrun fit is held; it still runs after a too-long review because its prompt is much smaller.
- **Labelling "too long".** Originally a timeout on a design that merely mentions "context window" was labelled too long, because the provider's error can contain the whole prompt. After review, the label is read with the prompt removed, and the argument-length error counts as too long.
- **Peer text.** Originally a peer machine's free-text reason rode into the reviewer's prompt. After review, only a closed code is accepted and the text is rebuilt locally.

## Experience fit

- **Source:** the Chief of Staff, 2026-11-27 (message ecfdbfb4): "(a) … never silently judge the first 24,000; (b) a degraded run must be loud … every caller … treats degraded as 'not checked', never as zero findings; add tests on both sides."
- **Ordinary journey:** an agent checks a design. Either the whole text is judged, or the reply carries `checked: false` with a plain reason, and the CLI, skill, awareness note and approval reviewer all treat it as not checked. The operator is asked for nothing new; a clean result they are shown now means the whole design was sent and judged.
- **Contrasting cases:** a model error with an empty list (held if reported as "0 flags"); review fine but fit not run (CLI NOT CHECKED (fit), exit 2; fit claim held); a clean run picked from a spread across machines (held); an honest "could not run" (passes, if flagged completed runs are also reported).
- **Evidence limits:** the approval reviewer is an LLM judge with an under-fire bias; whether it catches these cases is measured at graduation (2026-12-12) with a second, independent read by the Chief of Staff's reviewer. How many long designs finish inside the budget is measured on the test agent.
- **Disposition:** meets (a) by refusal rather than overlapping parts, which the request allowed; the "N of M characters read" wording is replaced by the design's length, because N would always be 0 (stated in the spec). Meets (b), with tests on both sides.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Spec changes |
|---|---|---|---|
| 1 | decision-completeness, adversarial, scalability, integration, lessons-aware, codex; security precision only | 12 groups | time budget, CLI and skill waits, ledger rework, fit decision, decision rows, labelling, peer text |
| 2 | all six lenses and codex | 9 groups | merge across machines and earlier texts, legacy marking, section budget, fit outcome recorded, second run as judgment, derivations stated |
| 3 | codex only; all six internal lenses converge | 5 (codex) | review timeout capped by budget, tally shown when it says more, wording on omitted counts, whole-input claim, graduation evidence limit |

Standards-Conformance Gate, every round, on the Studio (the M5 Pro's model connection failed, so its runs were degraded and are not counted):
- Round 1 (entry text): ran (5, 5 and 4 flags), fit, not degraded. A first M5 attempt was unavailable: degraded, error (three runs).
- Round 2 (entry text): ran (11, 12 and 12 flags), fit, not degraded.
- Round 3 (final text, 23,653 characters, read whole): ran (8, 11 and 8 flags), fit, not degraded.

Internal reviewers ran on claude-opus-5-5, grouped two or three lenses to an agent in rounds 2 and 3.

## Proportion

Tier 1: a bug fix to an existing advisory route, its record, its CLI and its skill text; no new feature flag, reversible by revert. Three rounds were used, against a cap of three. ⚠ The cap was reached; the cross-model pass still raised design-class points in round 3, all narrower than round 2's and none safety, security or data-loss.

## Left behind

Corrected after round 3, not re-reviewed (cross-model): the review timeout capped by the remaining budget; the tally shown whenever it says more than the record's own list; `standardsOmitted` documented as a lower bound; the whole-input test claim reworded to what it proves; the graduation read's limit stated.

Repeated by the constitution check on the final text and recorded rather than iterated (the long tail):
- Exact time constants (150 / 10 / 20 / 200 s) are not derived beyond the 180-second budget; they are constants, cheap to change after, and CMT-061 owns a size-aware timeout.
- The 12 MB file ceiling rests on an average bytes-to-tokens estimate.
- The 24-standard, 3-earlier-text, 500-slug and 24,000-character section limits are prompt-cost bounds, each disclosed when it binds, not derived from evidence relevance.
- When a line is left out of the section, the existing "not shown" note says its absence is not a ground to fire, so a claim can still pass on missing evidence.
- Which run flagged which standard is not kept in the ledger; the agent reports it from each run's response.
- A peer that does not answer is left out, as the section already says.
- Slug, not content hash, links approvals and R32 evidence to a check: CMT-060.
- Gemini's adapter still passes the prompt as a command-line argument. Gemini is installed and enabled on the Studio but not on this check's route today; an oversized prompt there fails loudly. Recorded for that adapter's owner.
- Disputed: two checks finishing together losing a run. The record step is synchronous inside one process (confirmed by the scalability lens).

## After the cap: the Chief of Staff's reviewer

The Chief of Staff's reviewer dissented on one point (record `.instar/state/handoffs/reviews/conformance-check-reads-whole-review.md`): the model calls still passed the whole spec as a command-line argument on Claude. Fixed after the round cap, at the reviewer's request: both calls now use the locked-down reviewer path, so the prompt goes over standard input with no tools offered and the same model pin; a payload test drives the real Claude provider against a stand-in binary and proves the spec arrives whole on standard input and none of it in the arguments. Kept, with reasons: the "too long" label still reads the provider's refusal (there is no per-model context table to measure against; both labels mean not checked); the tag writer gets no gate-line check here (it would change the fixtures of five tag-writer test files and an integration test, which is not cheap on the M5; recorded for CMT-060).

## Full Findings Catalog

Round dispositions are in the working notes kept with this report (`r1-findings.md`, `r2-findings.md`), and every reviewer's full text is in the convergence session transcript. Highlights by perspective:
- **Security:** labelling read from errors that embed the prompt; peer prose in prompts (round 1). Converges in round 3.
- **Scalability:** argument-limit ceiling; render size and section total (rounds 1, 2). Converges in round 3.
- **Adversarial:** cross-machine cherry-pick; lone legacy record as clean (rounds 1, 2). Converges in round 3.
- **Integration:** client timeouts; per-machine tallies; earlier-text merge (rounds 1, 2). Converges in round 3.
- **Decision-completeness:** silent standards cap, fit decision, missing rows (round 1); stale lines (round 2). Converges in round 3 (13 rows: 10 invariant, 3 judgment-candidate).
- **Lessons-aware:** route budget, CLI timeout, render cut, awareness note (round 1); stale lines (round 2). Converges in round 3.

## Convergence verdict

Converged at the round cap (3 of 3). The six internal lenses converge with no design finding; the cross-model pass's round-3 points were corrected in the text after the round and are listed above. No safety, security or data-loss finding remains. The check ran, whole and not degraded, every round. The spec is the agent's to approve: it changes neither the constitution nor a protected path.
