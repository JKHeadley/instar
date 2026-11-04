# Convergence report: session-pool-rebalancing-finish

**How it ended.** Stopped after 3 rounds under the operator's rule for this run: cut to the smallest
version that works after about 3 rounds that keep finding design problems. This is not a clean
zero-findings convergence. The two outside reviewers still rated round 3 "serious issues"; the final
code-grounded reviewer found one real hole (seeding the first hop) and said to build once it and three
wording fixes were in. All of those are in the spec. Reviewer verdicts were not re-run on the final text.

## Iteration summary

| Round | Standards-Conformance Gate | External | Internal | Result |
|---|---|---|---|---|
| 1 | ran (2 flags) | codex-cli gpt-6-astra, claude-code | 3 reviewers covering the six lenses in pairs | rewrite |
| 2 | ran (1 flag) | codex-cli, claude-code | 1 code-grounded reviewer | rewrite |
| 3 | ran (2 flags) | codex-cli, claude-code | 1 code-grounded reviewer | final edit, cut rule applied |

Gemini was not signed in and Grok is not enabled. The six internal lenses ran as three reviewers in round
1 and one in rounds 2 and 3, fewer than the skill's six, to keep cost in line with the change.

## What the reviews changed

- The proof was rebuilt: it now runs the real planner → reconciler → drain path with named exemptions.
- Proof rows moved to their own store; a later red beats any green; a failover green erases nothing.
- Only quiet sessions move, so the drain has no wait loop and the timing race with the claim is gone.
- The source decision gained a session-ratio floor; the cooldown now follows the topic across machines.
- Each machine proves itself, then the ceiling rises on all together, so no proof replication is needed.
- Measures were rewritten around sources that exist.
- The Live-User-Channel flag added a real Telegram check before the feature counts as done.

## Left behind (known limits, accepted)

- While admission is unenforced, new work can still land on a closed source. The 2-an-hour breaker caps
  moves; the conformance gate flagged that this bounds frequency without proving convergence. The session
  ratio stops shedding once slots free up, and the practice rung watches it.
- Moving ahead of admission enforcement departs from the trustworthy-load plan's order. Recorded in change 4.
- Proofs last 30 days and are not tied to a build.
- A restart inside a drain can leave a duplicate until `DuplicateSessionReconciler` clears it; it counts as a duplicate.
- A failure on the target records red against the source.
