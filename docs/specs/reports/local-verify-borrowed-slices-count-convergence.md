# Convergence Report — Local Verify: borrowed machines take slices of the slow tests, and their results count after practice

**Spec:** [docs/specs/local-verify-borrowed-slices-count.md](../local-verify-borrowed-slices-count.md)
**Slug:** `local-verify-borrowed-slices-count`
**Converged at:** 2026-11-18 (round cap, Tier 2: 6 rounds)
**Iterations:** 6
**Final-round design findings:** 4, all from the outside-model reviewer. Each was a small rule completion, applied in one edit at the cap and not re-reviewed. None concerns safety, security or data loss for the owner (see Convergence Verdict).

## Cross-model review: codex-cli:gpt-6.2-astra

The GPT-tier pass ran through the codex CLI in all six rounds. Round 1's first attempt failed because the agent home's built copy of the reviewer asked for a retired model (`gpt-5.5`); it was re-run on the round-1 text from a current build and succeeded. The six internal lenses ran as Claude subagents on the authoring session's model, Claude Fable 5.2, in rounds 1 to 4. Rounds 5 and 6 were outside-model rounds only: the reviewable text changed in small ways after the internal reviewers' round-4 verdict of converged, and the Standards-Conformance Gate did not run on those two texts.

---

## ELI10 Overview

Before a change to Instar can be merged, it is tested on two computers we own, the Studio and the M5. Justin asked for his spare machines, his laptop first and an old Windows PC second, to help with that testing while he uses them, and to step back whenever he needs them.

A first design for this was approved on 18 November 2026. Justin read it and said it looked too cautious to deliver any benefit. He was right: a borrowed machine would only have practised, only on the quick tests, only on code already merged. This document amends it. A borrowed machine now runs part of the slow tests inside a sealed Linux box on that machine. At first its answers are only compared with ours. When the comparison has shown that it reports passes and failures the way our own machines do, the session that runs the test line decides whether its passing answers start to be used, so our machine can skip those tests.

Two things protect the owner and cost almost nothing, so they stay: tests run only inside the sealed box, and the box stops the moment the owner needs his machine. Everything else is about not being fooled by a wrong answer: both sides must test exactly the same code, a failure reported by the borrowed machine is never used, a pass is used only when the same tests ran with the same outcomes, some passes are re-run on our machine at random, and one test run in ten is run entirely on our own machine as a comparison.

**The honest size of the benefit.** Worked out from the Studio's own logs, this design by itself is worth about 1.5 more merged changes a day if the laptop helps with the slowest group of tests and is always free, about 3 if it also helps with the second-slowest group, and half of either if the laptop is free half the time. The line merges about 57 a day, so this is small. The design says so plainly. It is built because it is the foundation for the step that pays: a borrowed machine carrying most of a test run, so that our own machine can test a second change at the same time. The author estimates that at 6 to 17 merged changes a day per borrowed machine. That figure rests on one measurement and two guesses, and the design says when it will be checked and who checks it.

## Original vs Converged

- **Both sides now test the same code.**
  - Originally: the borrowed machine tested the change by itself.
  - After review: it tests the change merged with the current shared code, exactly as our machines do, and proves it with a fingerprint of the files. Why: our machines never test a change alone, so the first draft would have counted passes for different code than the verdict was about. Four reviewers found this independently in round 1.
- **A waiting change can never run anything with internet access on the owner's machine.**
  - Originally: packages were installed if the package list matched one seen before.
  - After review: packages are installed only from already-merged code, are locked before any waiting change's files arrive, and a change that alters anything installation uses is not sent to the borrowed machine at all. Why: a change could have altered an install step without altering the package list.
- **Our machine never waits, and the worst case is really bounded.**
  - Originally: one extra process ran whatever the borrowed machine had not finished.
  - After review: each of our machine's own test processes takes back its own portion when it finishes its own files. Why: one process carrying the whole unfinished share could have run past the 45-minute limit.
- **Practice ends on evidence, and always ends in a decision.**
  - Originally: ten practice runs in a row that agreed.
  - After review: every test file compared at least once, comparisons from several runs, and at least five cases where a real test failed on our machine and the borrowed machine reported the same test failing. After seven days a decision is made on whatever was collected. Why: ten runs could have been reached with almost no comparison, and agreeing on passes shows little.
- **A pass means the same tests ran with the same outcomes.**
  - Originally: no failures.
  - After review: a fingerprint of every test's name and outcome must match our own machines' record. Why: a test file can skip its tests on Linux and report no failures.
- **An unreliable test on our side no longer counts against the borrowed machine.**
  - Originally: one disagreement sent it back to practice.
  - After review: a wrong pass is confirmed only when our machine fails the same file twice on the same code; many disagreements at once pause the borrowed machine for a few hours instead of restarting practice.
- **The benefit figure fell from "about 5 a day" to "about 1.5 to 3".**
  - Why: the first figure counted every test run as full length. More than half of the Studio's runs fail and stop early, the safety-net runs get no help, and the design's own checks take about 15% back. The reviewers recomputed the figure from the logs and confirmed the final arithmetic.

## Experience fit

- **The goal, in the owner's words.** Messages 143933, 143942 and 143952 in topic 130715: use spare capacity on machines he connects, even while he uses them, pulling back when his own demand rises. Message 145401 in topic 145097: "it sounds like it might be too restrictive (not sure though). I want to make sure we don't fall into the trap of overengineering or being over-secure to the point where we get no benefit from the plan."
- **The ordinary journey.** One ask per machine, sent by that machine's own agent, in four parts. No second ask before answers are used. A report before counting starts and another after seven days of counting, each asking for his own account of any slowdown. He can pause from his phone.
- **Contrasting cases the review checked.** The laptop's yes does not cover the Windows PC, which gets its own ask naming its weaker wall. The ask states in bold that it goes further than what he was told on 18 November (practice only, merged code only). The owner's yes is consent to the use of his machine; whether a borrowed result may feed the merge decision is the design approval; the decision to start counting is the throughput session's. The three are kept apart in the text.
- **Evidence and its limits.** The laptop's speed on the integration tests is measured (alone, one file at a time, in the sealed box). Its speed on the other two groups, how often it is free, and the owner impact of heavier slices are not measured. The benefit is a projection until the first week of counting, and the text says "projection" where it is one.
- **Findings and disposition.** Round 1: notices would have gone to the owner on first detection (fixed: he hears only when a wrong pass made the shared code fail, or after three fault lapses in seven days). Rounds 1 to 4: the benefit figure overstated (fixed three times, final arithmetic shown line by line). Round 2: the Windows proof would have run a waiting change before that machine's ask (fixed: proofs run after each yes).

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | security, adversarial, integration, scalability, lessons, decision-completeness, codex | 33 | 31 | Whole document rewritten (second draft) |
| 2 | security, adversarial, integration, scalability, lessons, decision-completeness, codex | 20 | 33 | Benefit, C, D, E, F, the ask, maturation, frontloaded decisions |
| 3 | adversarial, lessons, decision-completeness, codex | 7 | 10 | Benefit, C, F, limits |
| 4 | codex (internal: converged, 3 contradictions fixed in passing) | 4 | 5 | Benefit, F |
| 5 | codex | 3 | 2 | D, F, benefit wording |
| 6 | codex | 4 | 1 | C, F, the ask |

Standards-Conformance Gate: ran in rounds 1 to 4 (16, 11, 16 and 14 flags). Not run in rounds 5 and 6: those were outside-model rounds on small edits. Most flags in every round were fixed starting values under Judgment Within Floors; the round-4 reviewer judged the spec's answer adequate (the values guarding irreversible consequences are invariants; the rest are settings behind an off switch, revisited at the practice report and the 7-day review). One flag repeats and is known: the parent article is not on this branch until PR 3473 merges.

Outside-model body hashes are in the review files (`state/scaling/converge-count/r1..r6-codex.json` in the agent home).

## Full Findings Catalog

The full text of every finding is in the agent home under `.instar/state/scaling/converge-count/` (files `r1-*` to `r4-*`, and `r1..r6-codex.json`). The design findings, by round:

**Round 1**
- Helper tested the change alone, not the merge tree (integration, lessons, adversarial, decision). Resolved: request carries `baseSha` and `headSha`; the tree hash must match.
- Install scripts of a waiting change could run with network and alter cached packages (security, lessons, codex, gate). Resolved: installation only in a merged commit's tree; packages root-owned read-only.
- "Pass" undefined for skipped tests (security, integration, codex). Resolved over rounds 1 to 4: digest of test names and outcomes.
- Fallback could exceed the lane's 45-minute limit (adversarial, scalability, codex). Resolved: per-shard take-back.
- Two results for one file with no precedence (adversarial). Resolved: local result wins; late helper answers ignored.
- Ten practice runs reachable with almost no comparison; wrong direction measured (adversarial, lessons, scalability, gate). Resolved: evidence items.
- Flaky tests would demote a helper (adversarial, integration, lessons, security). Resolved: confirmed-wrong-pass rule.
- Benefit overstated (adversarial, lessons, codex). Resolved over four rounds.
- Notice to the owner on first detection (lessons, gate). Resolved.
- Where the exchange runs was unstated; main verifies lost their protection; cross-machine reset impossible (integration). Resolved: lane flow behind a loopback route; first design's detached observer kept for main verifies; all decisions taken on the pairing machine.
- Progress results bypassed the slice-level error check (security, codex). Resolved: provisional until the last signed answer.
- Check slice recognisable; spot re-runs could be starved (security). Resolved: claim reduced; spot re-runs always run.

**Round 2**
- Verify child had no port or credential for the loopback route; no bound on waiting (integration). Resolved: attempt token; 5-second limit.
- Baseline results kept nowhere; the M5 could count nothing (integration, scalability, decision). Resolved: coordinator keeps and sends the baseline.
- Build step could rewrite the package cache (security). Resolved: root-owned read-only through the build.
- Share could fall and never rise (adversarial; repeated in round 3). Resolved in round 3: share follows measured speed and reported free workers.
- One waiting change or a run-machine fault could stall practice (adversarial). Resolved: windows on the check slice history; invalid answers defined; mass disagreement rule.
- Coverage a moving target (adversarial). Resolved: checked once at the decision.
- Practice might never end; Windows proof before its ask; "image changes" undefined (lessons, decision). Resolved.
- Test identities, install inputs, per-lane decision, concurrent slices killed by clean-up, biased measurement (codex). Resolved: digest, install-input list, recorded per-lane decision, one slice at a time, random one-in-ten comparison group.

**Round 3**
- The 6-to-17 estimate carried the case for building with no label, working or owner (lessons). Resolved.
- Skip swapped between tests with equal counts; check slice could arrive after take-back; install inputs unbounded; two admission rules; "detected within hours" overpromised (codex). Resolved.

**Round 4**
- A test added only on macOS through an imported file; the sixth disagreement arriving after a shard finished; failing-direction evidence satisfied by unrelated failures; arithmetic not reproducible (codex). Resolved: same-tree digest comparison with a named residual; final local pass; same failing test required; arithmetic shown.

**Round 5**
- Two rules for a digest difference; nothing scheduled uncovered files; mass disagreement and single-event lapse conflicted (codex). Resolved.

**Round 6 (cap)**
- A failing file held in a silent helper's portion fails later; install inputs compared with any merged commit, not this verify's base; no transition for a partly agreeing follow-up after a suspension and no persisted `suspended` state; the 7-day exception did not require 7 days (codex). All four applied in one edit; not re-reviewed.

## Proportion

Tier 2 amendment of an approved Tier 2 spec; the spec is about 420 lines. Six rounds used of a cap of six. That is the full cap, in line with a change that lets a borrowed machine's result feed the merge decision and runs unmerged code on a personal machine. The first two rounds did the real work (53 of 71 design findings); rounds 4 to 6 were rule completions from one reviewer.

## Left behind

- The spot re-run draw is described at "when a shard finishes its own files"; the builder settles the exact moment relative to the take-back.
- The plain overview simplifies four points (the 500-comparison window, the one-in-ten cost, "cost today: nothing" for packages, the three-lapses notice). The spec is exact.
- The Standards-Conformance Gate's repeated complaints about fixed starting values (share, one in ten, one in twenty, slice budgets, the 2-second status limit, 60-second request expiry inherited from the first design): accepted as starting values behind an off switch, revisited at the practice report and the 7-day review.
- Round-2 gate flag on the learned list's retry timing (two in a row, every 10th verify): the first design's values, kept; cheap to change.
- Accepted residuals, each named in the spec: an install script that reads an unlisted repository file; a test that exists only on macOS and is added through an imported file; green results that used a helper's earlier passes before it was found wrong; a fault that a later merge hides from the main verify; a branch of ours carrying code copied from outside; flaws in the virtual-machine layer and, on Windows, the shared kernel.
- The round-6 edits and the round-5 edits were not seen by the internal reviewers or the gate.
- The parent article is on PR 3473's branch, not on this one, until that PR merges; `depends-on` records it.

## Convergence Verdict

Converged at the round cap (round 6). The internal reviewers found nothing that changes what gets built in round 4. The outside-model reviewer raised four design-class points in the final round; none is about safety, security or data loss for the owner (they concern how long a failing run takes to fail, which changes get help, a missing state name and a missing condition on an exception), and all four are applied in the text. `## Open questions` is empty.

The spec is ready for the Chief of Staff's review. Two things need that approval by name: that a borrowed machine's passing result may feed the merge decision after the stated evidence and a recorded decision, and the reversal of the first design's fold-in "scan as a hard floor" (Frontloaded Decision 10). An approver should also weigh the stated benefit: small alone, and built as the foundation for the larger step.
