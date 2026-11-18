# Convergence Report — Conversation graph: remember each stored row's verification verdict

## Cross-model review: codex-cli:gpt-6-astra

A GPT-family external pass (codex CLI, gpt-6-astra) ran in all five rounds. Round 1: SERIOUS ISSUES (2 design). Rounds 2-5: MINOR ISSUES (precision only). Gemini was not signed in on this machine; the Claude clean-door reader was available but not used (it is not a cross-model opinion).

## ELI10 Overview

The agent keeps a signed record of every conversation, project and change, shared between the owner's machines. Before it trusts a record it checks the record's signatures and proofs, which takes a few milliseconds per record. With about 550 records, checking all of them takes 1 to 3 seconds on a busy machine, and the agent did that after every single save during Accept all. While it checks, the server answers nothing else, which is part of why Telegram replies were held and pages froze on 2026-11-17 and 18.

This change makes the agent remember each record's check result and reuse it as long as nothing the check depends on has changed: the record itself, which machine it came from, what the agent knows about deleted content, the witness keys and the current membership. Records whose check depends on the clock, on files, or on removed-machine history are always checked fresh.

The trade-off is a new thing that could go wrong: remembering "valid" for a record that should now be refused. The review spent most of its five rounds on exactly that, and the result has three guards: an exact list of everything the check reads (enforced by a test that walks the code), a test mode that re-checks every remembered answer and freezes stored records so hidden edits fail, and an off switch.

## Original vs Converged

- **Fence (local deletion list).** Originally a counter on one fence object. Reviewers found that every fence for the same folder shares one state, so other objects' changes would be missed, and that the folder's validity was not tracked at all. Converged: a per-pass signature of the shared state (folder check, corrupt flag, number of denials), which is complete because that state only grows.
- **Erasure records.** Originally covered. Reviewers found their check reads witness keys and custody history on disk. Converged: always checked fresh.
- **Witness keys and membership.** Originally assumed constant. Reviewers found the runtime changes the witness key map later and that membership is a shared object. Converged: both signed every pass.
- **"The list of inputs is complete."** Originally a claim. Converged: a test that walks every helper the check calls and fails on any unclassified read, plus a test-mode recheck of every reuse whose failures are counted and asserted after every test (because many callers swallow errors), plus a test-mode freeze so nested edits fail, plus a counted failure when a frozen value reaches the one mutator that deletes silently.
- **Performance.** Originally only the signature check was remembered. Converged: the check, the "fully persisted" check and the descriptor hash, including clones in the final loop. Round 4 caught that one bump ran on every save and would have wiped the memory each time; removed.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security+adversarial, scalability+integration, decisions+lessons, codex, conformance gate | 9 (deduplicated: fence shared state, root validity, erasure-row lineage, witness keys, membership, localErasure type, enumeration unproven, memo only halves cost) | 9 | major rewrite |
| 2 | decisions+lessons, scalability+integration, conformance gate | 2 (no guard for nested edits; divergence swallowed by callers) | 11 | freeze + counted divergence; fence answer signature |
| 3 | scale/integration+decisions/lessons | 1 (Reflect-based mutator silent on frozen values) | 9 | frozen-value WeakSet counted |
| 4 | security/adversarial/scale | 1 (controlTargets bump on every write emptied the memo) | 7 | bump removed; per-pass fingerprint; clone-keyed reuse |
| 5 | (converged) | 0 | 6 | test list scoped to what exists |

Standards-Conformance Gate: ran every round (round 1: 1 flag, root validity; round 2: 1 flag, field-read test claim; round 3: 1 flag, mid-pass root timing; rounds 4-5: folded into the same items). Internal reviewers ran as three combined subagents (two lenses each) in rounds 1-2 and two in rounds 3-4, one covering all six in round 5, to keep load down on a machine at load 30-50; every lens was covered every round.

## Proportion

Tier 2, security-sensitive. Spec ~110 lines; code ~110 lines across 2 source files + test setup + 1 new test file (12 tests). 5 rounds of 6 allowed. Proportionate to the risk (a wrong reuse admits a refused record).

## Left behind

- `readAll` (~21% of a pass) and accept-loop clone cost remain per pass; they are inside the same autonomous run's completion condition and are measured by the rig proof.
- Reachability test covers plain certified rows; adopted/cancelled/delivery-receipt variants are covered only by the divergence guard in existing suites.
- `readerHash` keeps verifying directly (rare member-loss path).
- Field-read test flags (does not follow) aliases and computed access.
- Precision wording items from codex rounds 2-5 were applied.

## Full Findings Catalog

Recorded in the session transcript of topic 144559 (2026-11-18 02:12-02:53Z); every design finding above was resolved as described in "Original vs Converged".

## Convergence verdict

Converged at round 5. The final round found nothing that changes what gets built; six items left behind. Ready for approval.
