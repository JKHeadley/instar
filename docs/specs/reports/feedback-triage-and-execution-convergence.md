# Convergence Report — Feedback Triage and Execution

**Spec:** [docs/specs/feedback-triage-and-execution.md](../feedback-triage-and-execution.md)
**Slug:** `feedback-triage-and-execution`
**Converged at:** 2026-10-08 (round 10, under the operator's 80/20 convergence standard — see verdict)
**Iterations:** 10

---

## Cross-model review: codex-cli:gpt-5.5

GPT-5.5 reviewed every round through the agent's codex CLI. Gemini was not available (`gemini-not-authed`). A clean-door Claude reviewer (claude-fable-5) also read every round; it is a second reading, not a cross-model opinion.

## ELI10 Overview

Instar agents send in bug reports. Today those reports are collected and grouped, and each group becomes a work item — and then nothing happens. 426 work items were sitting untouched, all ranked the same, none ever closed.

This spec adds the missing last step in two parts. First, a strong model reads each item's actual reports and decides: work on it, hold it for later, or ignore it, with a severity, a rank and a reason. Plain code checks every answer: an unsure model holds rather than ignores, anything serious or security-shaped can never be ignored without a second model agreeing, and "ignore" itself runs in practice mode until it has proven itself and the operator approves it with the dashboard PIN. Nothing is ever deleted, and every decision can be undone.

Second, a worker takes the top-ranked items and starts a build session on each. Because report text comes from outside, that session is locked in an operating-system sandbox with no internet, no keys and no files outside its own copy of the code, and a check proves the sandbox holds before every run. The worker's trusted code double-checks the fix, refuses changes to build tooling or anything that looks like a secret, and opens a pull request. It only merges the exact version the repository owner approved on GitHub. The tradeoff: every fix costs the operator one approval tap, and the design is larger than a simple "run a job" would be — that size is the price of letting untrusted text drive code changes safely.

## Original vs Converged

- **Originally** triage moved clusters through the product lifecycle (`wontfix`, `closed`). **After review** it keeps its own disposition table and never touches `Cluster.status` — the parent spec reserves that to the curator, and several of the original moves were illegal in the state machine anyway.
- **Originally** "ignore" archived the work item. **After review** hold and ignore both pause it (reversible), ignored items come back on new reports, and ignore runs in shadow until graded evidence and a PIN-bound operator approval turn it on.
- **Originally** the build session got report text and full machine access, and merged through the normal auto-merge. **After review** the session is OS-sandboxed (verified by a must-fail/must-succeed canary), never commits or pushes, and trusted code copies its changes as bytes into a separate clone it alone controls, refusing tooling paths, symlinks and secret-shaped content.
- **Originally** human review was assumed to come from the repository's ruleset. **Review found the live `main` ruleset does not require approval in general.** The feature now enforces its own gate: only the repository owner's approval of the exact head counts, the merge is pinned to that SHA, and the executor refuses to run if the agent itself could act as the approver (Echo holds `JKHeadley`, so it waits for a PIN-bound acceptance).
- **Originally** operator confirmations could be given in chat. **After review** the three authority-changing confirmations require the dashboard PIN, because the agent can post through the operator's own Telegram account.
- **Originally** a fix was "done" when merged. **After review** `verify` completes only after the fix ships in a release and 30 days pass with no matching report (plus a live-channel test for user-facing fixes).

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | security, adversarial, scalability, integration, decision-completeness, lessons-aware, codex-cli:gpt-5.5, clean-door claude-fable-5 | ~30 (deduplicated to 16 themes) | ~10 | Rewrite: no `Cluster.status` writes; own triage/execution tables; Initiative `paused`; brief-only executor input; branch+author PR identity; never-ignore floor on all paths; ignore shadow; spec-needing items converge a spec first |
| 2 | security, adversarial, scalability, integration, decision-completeness; codex-cli (minor), clean-door (minor) | 15 | 12 | Restricted executor profile with refuse-if-unenforceable; schema-bounded brief; spec approval via operator GitHub review; approved-head SHA match; rolling ignore-rate brake; 24 h re-queue throttle; cross-family second opinion; self-heal ladder; authority approval card; source-repo scoping; action-list job |
| 3 | security, adversarial, scalability, integration, decision-completeness; codex-cli (minor), clean-door (minor) | 9 | 10 | Executor confinement via Claude Code OS sandbox; trusted code does all credentialed actions; result file + executor-side verification; spec drafts leave the untrusted lane; self-heal status within 300 s; per-account quota gate; severity rubric, priority bands, second baseline |
| 4 | security, adversarial, scalability, integration, decision-completeness; codex-cli, clean-door | 6 | 8 | All workspace-code execution confined (sandbox runtime); hooks-disabled commit; tooling-path diff gate; standalone clone at origin/main; session never commits; positive canary probes; merge-tree rule; shadow bar fixed |
| 5 | security, adversarial, scalability, integration, decision-completeness; codex-cli, clean-door (minor) | 7 | 9 | Two clones (session workspace with read-only `.git`, trusted publish clone); byte-level change set; secret gate; one-file spec drafts; Codex ineligible at ship; verify = release + 30 quiet days (+ live harness); duplicates feed target; execution-failed loop terminator |
| 6 | security, scalability, integration (decision-completeness: none); codex-cli, clean-door (minor) | 4 | 9 | GitHub-native ruleset gate (later replaced); per-lockfile dependency cache; third clone for base check; `git tag --contains`; lstat walk; secret gate as signal → hold; stale hold/ignore not applied |
| 7 | security, scalability (decision-completeness: none); codex-cli, clean-door (minor) | 3 | 6 | Live ruleset found NOT to require approval → feature-enforced gate; native allow-list rebuild; cache eviction; secret-hold exit; brief filter never holds; severity cap → ranking tiebreak; action-list cap |
| 8 | security, decision-completeness (scalability: none); codex-cli (minor), clean-door (minor) | 2 | 8 | Approver = repository owner via API + independence check; pre-filter only routes; ready-for-review PRs; `safe-merge --auto --match-head-commit` with refusals mapped; CODEOWNERS check; hold-reason table and backoff |
| 9 | security (decision-completeness: none; scalability: none); codex-cli (minor), clean-door (minor) | 1 | 9 | PIN plan/commit for three operator authorities; pre-filter dropped; exit-5 `merge-armed` mapping; `--disable-auto` on every stop path; work-queue ceiling; resource limits |
| 10 | security (low, factual), decision-completeness (low, internal contradiction) (scalability: none); codex-cli (scope), clean-door (minor) | 2 (both low; corrections, no new mechanism) | 8 | Detection claim corrected to "accepted, undetected"; merge confirmation by `mergedAt` + `headRefOid`; secret-hold exit made PIN-only in the table; PIN routes named; ceiling paused when executor unavailable; operator Initiative changes win; `superseded` grade; second-opinion sub-cap; two-phase build order |

Standards-Conformance Gate: ran every round — flags per round 7, 8, 5, 5, 4, 2, 3, 2, 3, 2. Final-round flags: Framework-Agnostic (accepted, stated gap: confinement is a safety floor only Claude Code meets today) and Verify the State (addressed by the `superseded` grade).
Internal reviewer model: claude-opus-5-5 subagents every round (no silent model drop).
Externals were never delta-skipped: the spec body changed every round.

## Full Findings Catalog

The per-round findings are summarized in the table above; the material ones are described in "Original vs Converged". The largest classes, in order of rounds spent: executor confinement and the trusted/untrusted boundary (rounds 1–6), the human review gate and approver authority (rounds 6–10), dependency installation under confinement (rounds 4–8), grading honesty (rounds 2–10), and spam/cost resistance (rounds 2–7).

## What was left behind

Recorded so "converged" does not silently mean "stopped":
- **Scope (codex-cli, rounds 4–10):** the executor is a large, purpose-built subsystem; GPT recommended staging it after triage. Response: the spec now builds in two phases, and the executor gets a further focused review round against its built code before merging.
- **Rules-first triage (codex-cli and clean-door, several rounds):** a deterministic pre-pass for obvious cases. Considered and not adopted; the deterministic rule is recorded as a comparison baseline only.
- **Container isolation (clean-door, rounds 8 and 10):** stronger than the OS sandbox; not adopted because no container runtime is guaranteed on the operated macOS host. A container confinement adapter can join later by passing the canary.
- **Framework-Agnostic gate flag:** the executor runs only on Claude Code at ship. Accepted and stated.
- **Approver independence after acceptance:** a full-tool agent session could still approve as the operator once the operator accepts that condition; accepted by name as undetected.
- **Precision items** in round 10 (terminology load, priority calibration within bands) noted and not iterated.

## Convergence verdict

The skill's strict criterion — no design-class findings for two consecutive rounds — was **not** met within the 10-round cap: rounds 9 and 10 each still produced design-class findings. Round 10's two were low-severity corrections (a false statement about an existing log, and a table row contradicting a frontloaded decision); both were fixed without adding any new mechanism.

Under the operator's convergence standard (2026-08-19: stop when a round's findings stop changing what gets built, and say plainly what was left), the spec is converged: findings fell from ~30 to 2 low-severity corrections, the internal scalability and decision-completeness reviewers found nothing design-class in the final rounds, and the remaining external comments are scope recommendations answered by the two-phase build order. The executor half gets one more focused review against its built code before it merges.
