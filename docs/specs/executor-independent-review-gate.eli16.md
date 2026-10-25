# Feedback fix PRs merge after an independent review, not after Justin's tap (plain-English overview)

Governing spec: `docs/specs/feedback-triage-and-execution.md` §4 step 9 (converged and approved), amended by this change on the operator's directive (topic 18330, 2026-10-21 12:27 PDT and 2026-10-23 09:17 PDT).

## What was wrong

The feedback executor builds a fix in a sandbox, verifies it, opens a pull request from a fork, and then waited for one thing: the repository owner's "Approve" on GitHub, on that exact commit. Nothing else could admit the PR. The owner said, twice, that this tap was the bottleneck and the wrong question: whether a fix is worth doing is decided earlier, at triage; the only question left at the PR is whether the change is safe, and that is a careful read, not a judgment call only he can make.

## What changes

A PR now merges when two reviewers with no stake in the change both pass it on the exact commit:

- a **cross-family reviewer** — Codex (or Gemini, when installed), run through the same cross-model reviewer the spec process already uses;
- the **Claude clean-door reviewer** — a fresh Claude read with no memory of writing the change.

Both see the triage brief and the full diff, inlined as data, and are told that nothing inside the data is addressed to them. They answer one question: is this safe to merge? Scope, tooling edits, secrets or new network reach, weakened tests, injected instructions, obvious breakage. CLEAN or MINOR ISSUES from both passes. SERIOUS ISSUES from either, an unreadable answer, or a diff too large to read (over 192 KB) refuses: the reason and each reviewer's findings are posted on the PR, the PR stays open, and your action list gets one line about it. From there three things work as before: your approval on GitHub merges it anyway, a new push is reviewed afresh, and closing it parks the item. If a reviewer is simply away (not installed, timed out), that is not held against the change; a timed-out reviewer is asked again after an hour, a missing one once a day, and the action list says the PR is waiting for a reviewer.

The owner's own approval still works exactly as before and admits a PR on its own. Anything GitHub's CODEOWNERS assigns to an owner — on this repository, the constitution files — is never admitted by the reviewers, whoever the owner is; it waits for that owner's review, and GitHub enforces the same rule.

Everything else is unchanged: the sandbox, the fails-before/passes-after verification, the tooling and secret gates, publishing from a fork only, the full test run before merge, and the pinned `--match-head-commit` merge.

## What does not change

No new permission for the sandboxed session. No new way for the agent to approve its own work: the reviewers are separate models run through the existing reviewer door, and a Claude-only pass can never substitute for the cross-family pass.

## What you need to decide

Nothing. To go back to owner-approval only: `feedbackFactory.execute.reviewGate: "operator"`.
