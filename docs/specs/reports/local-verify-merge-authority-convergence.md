# Convergence Report — Local-Verify Merge Authority

**Spec:** [docs/specs/local-verify-merge-authority.md](../local-verify-merge-authority.md)
**Slug:** `local-verify-merge-authority`
**Status:** `convergence-failed` at the 10-round cap (2026-10-21). Operator (Justin) approved as-is on 2026-10-21 17:36 PDT (Telegram topic 128243), choosing the 80/20 path: the build surfaces what remains.
**Iterations:** 10
**Final-round design findings:** 13 (all applied to the spec; none re-reviewed)

## Cross-model review: codex-cli:gpt-6-astra

GPT-6 Astra (through the agent's own codex CLI) reviewed every round. A clean-door Anthropic second read (`claude -p`, `claude-fable-5`) also ran every round; it is recorded separately below and is not a cross-model pass. Gemini was not authed on this machine (`gemini-not-authed`), so there was no Gemini pass.

clean-door-anthropic-review: claude-code:claude-fable-5

Standards-Conformance Gate, per round: round 1 ran (degraded: `error`, 0 flags); round 2 ran (3 flags: Verify the State, Migration-Consumer Completeness, Maturation Path — all addressed in round 2's rewrite); rounds 3 to 7 ran (degraded: `error`, 0 flags); round 8 ran (3 flags: Bounded Blast Radius, Verify the State ×2); round 9 ran (2 flags: Verify the State, Structure beats Willpower). The round 8–9 flags restate residuals the spec now states explicitly (accepted overlap with builder suites while the test-runner bound is watch-only; the unpinned base; forgery with the shared login). The gate's judgment step errored on most rounds, so the constitutional pass was not authoritative; the lessons-aware reviewer covered the constitution on every round.

Per-round internal reviewer model: the authoring session ran on Claude Fable 5.1 through round 2 and Claude Opus 5.5 from round 3 (after a session handoff); internal reviewers inherited the session model. From round 4 the six internal perspectives ran as three combined reviewers (security + adversarial, scalability + integration, decision-completeness + lessons-aware); every perspective still ran every round.

## ELI10 Overview

Before a change to Instar is merged, its tests must pass. Today the merge tool only believes GitHub's own test jobs, which often queue for hours or do not run at all when the monthly allowance runs out. The operator has asked many times for tests to run locally instead, but the merge tool itself kept waiting on GitHub, so the instruction never stuck. Locally, the tests also ran one file at a time, which made a full run take over an hour.

This design makes the agent's own server run the full test suite on the exact code that would be merged and keep the result. The server then posts a pass/fail mark on the pull request using GitHub's free commit-status feature (no Actions minutes, no queue), and GitHub's branch rule requires that mark before any merge, so any merge without a pass is refused by GitHub itself, from any session, tool or machine. After every merge `main` itself is re-tested, so a problem caused by combining two changes is caught within one run, and merges pause (except for the fix) while `main` is broken. Unit tests now run 8 at a time; integration and end-to-end tests stay one at a time for now, because two known clashes make them unsafe to parallelise yet. Pull requests from forks and outside contributors get GitHub's own result copied onto the same mark, so nothing changes for them.

Measured on the Mac Studio: the full suite takes about 43 minutes (unit 4, integration 15, end-to-end 24), about 45 with install and build, against over an hour today, with no GitHub queue or billing limit. The trade-offs: a run still reports its own outcome; the mark is posted with the agents' shared GitHub login, so it stops accidents, not deliberate forgery; one machine verifies one PR at a time, which a throughput and latency go/no-go checks before the switch; and the operator turns on one GitHub branch-rule setting.

## Original vs Converged

- **Originally:** results were signed with the machine's key and stored as git notes. **After review:** no signing and no notes; the server keeps results in memory and is the only authority. Why: the signature added nothing against code running as the same user, and a file on disk could be forged by any session.
- **Originally:** the tests ran as the agent user with the PR's own test harness. **After review (round 2):** a separate OS user and a harness copied from main. **After further review (round 3):** back to the agent user, by a recorded decision, because only trusted principals' branches are ever verified and that code already runs on the machine daily; the protection moved to where it matters (a merge guard, a server-held result, verifying the merge tree, and the installed copy of the merge tool rather than the PR's copy).
- **Originally:** a moved `main` refused every merge until re-verified. **After review:** the base is not pinned (as today), and a post-merge verify of `main` is the compensating control; if `main` breaks, merges stop except for a repair verified against the broken `main`.
- **Originally:** all lanes parallel, about 13 minutes. **After review:** integration and end-to-end stay one at a time until two isolation fixes land; measured honestly at about 45 minutes per verify, with a 16-slot-hour/day go/no-go before the switch.
- **Originally:** no protection against a session typing `gh pr merge`. **Rounds 3–7:** a command-matching guard hook for Claude Code and Codex sessions; every round found new holes (per-account arming, worktrees, machines, file edits). **Round 7–8 (structural cut):** the guard was removed and replaced by a server-posted `instar/local-verify` commit status made a required check in the ruleset, so GitHub itself refuses an unverified merge from anywhere. One operator setting replaces the whole hook machinery.
- **Originally:** the auto-merge namespace filter was dropped. **After review:** kept, because the GitHub login is shared by sibling agents; local verification covers all trusted PRs, automatic merging stays limited to this agent's branches.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | security, adversarial, scalability, integration, decision-completeness, lessons, GPT-6, Fable | ~40 | ~10 | full rewrite |
| 2 | all six internal, GPT-6, gate (3 flags) | ~30 | ~15 | full rewrite (threat model decision) |
| 3 | all six internal, GPT-6, Fable | ~25 | ~15 | §1, §2, §3, multi-machine, decisions |
| 4 | three combined reviewers, GPT-6 | ~20 | ~12 | §2 (eligibility, keys, deadlines), §3 |
| 5 | three combined reviewers, GPT-6 | ~14 | ~12 | §2 (guard, queue), §3 (main-red) |
| 6 | security+adversarial, scalability+integration, GPT-6 | ~12 | ~15 | §2 deadlines/ratchet, guard (later removed) |
| 7 | all three combined reviewers, GPT-6 | ~14 | ~10 | structural cut: guard hook → required status |
| 8 | security+adversarial, scalability+integration, GPT-6, gate (3) | ~11 | ~10 | §3 status projection, reconcile loop, Decision 19 |
| 9 | all three combined reviewers, GPT-6, gate (2) | ~12 | ~10 | root cause: classic branch protection; Decision 19 two-step; safe-merge settle loop skipped |
| 10 | all three combined reviewers, GPT-6, gate (1) | ~13 | ~12 | durable completion journal; floor gated on GitHub's real settings; run boundary + commitment; MergeRunner `sync` strategy |

## Full Findings Catalog

The per-round findings, with the resolution taken for each, are kept in the session's reviewer outputs and summarised round by round above. Every finding was either applied to the spec or answered in the spec's own text (the threat model, the throughput budget, and the stated residuals are where declined suggestions are argued).

## Convergence verdict

**Not converged under the skill's rule.** Every round from 1 to 10 produced design-class findings, so the "two consecutive rounds without a design finding" criterion was never met, and the 10-round cap was reached. Every finding was applied to the spec, but round 10's changes have not themselves been re-reviewed.

What the trajectory shows, honestly:
- Rounds 1–2 found the big design errors (signing, PR-controlled harness, base-pinning cascade).
- Rounds 3–7 were dominated by one part, the command-matching merge guard, which kept leaking; round 7 cut it and replaced it with a server-posted required GitHub status.
- Round 9 found the actual root cause of the bottleneck: classic branch protection requires 12 Actions checks for non-admin merges, which no local run could ever get past.
- Rounds 8–10 found operational edges of the required-status design (reconciling with GitHub, restarts, lease moves, the order of the operator's two edits). The findings were narrower each round but did not reach zero.

The spec author's reading: the core design (parallel lanes, a server-run verify of the merge tree, a server-posted required status, a post-merge `main` verify, two ordered operator edits) has been stable since round 8; the remaining findings are about lifecycle edges, each with a concrete rule now in the spec. The operator's options are: approve as is and let the build surface what remains (the 80/20 path); or ask for one more targeted round on the round-10 changes only.

## Operator decision

2026-10-21 17:36 PDT, Justin, Telegram topic 128243: "Approved", in reply to the two options above. The spec carries a descriptive `review-convergence` tag stating it is not formally converged. Round-10 reviewer points not yet folded in are carried into the build as its first items: the advisory known-flaky lane must be reflected consistently in the inventory and predicate; capacity waits need their own oldest-wait alarm; a stuck-status canary (green record, posted status differs for >N minutes); fencing of an outstanding status write across a lease move; §4's Node-20 drop must not strand the pinned Actions contexts; nightly Linux run needs a failure consumer.
