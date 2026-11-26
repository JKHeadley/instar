# Convergence report — feedback-inbox-vault-token

## Cross-model review: ⚠ UNAVAILABLE

No non-Claude reviewer ran. Codex capacity on this machine is reserved for Astra reviews by
standing operator direction (2026-09-27: "Codex ONLY for Astra reviews"), so the external pass
was not launched. Every round was reviewed by independent Claude (Opus) subagents plus the
code-backed Standards-Conformance Gate.

## ELI10 Overview

The mover that brings other agents' bug reports onto the Mac Studio never started, because it
only looked for its password in a place the server can't see. The password was in the agent's
locked safe the whole time. Now the mover checks the safe too, but only on the one machine that
owns the job, so reports never get split between machines. The half-hourly checker job used to
say "all fine" no matter what, because jobs had no way to say "this failed". Now a job can write
a short note that the scheduler turns into a real failure, and the server also raises its own
warning when the drain is unavailable.

## Original vs Converged

- **Original:** env-or-vault token lookup; a per-slug failure file with a modification-time
  freshness check; the job fails on 503 or `unavailable`.
- **Converged:** the same lookup, but the drainer runs only on the drain owner; a per-run failure
  file named by the tmux session and handed to the job by environment variable; one posture table
  keyed on the response body; server-side degradations for an unavailable drain posture and for a
  missing token on the owner; sanitised reasons; the awareness refresh reaches AGENTS.md/GEMINI.md;
  a full three-tier test plan; a rollout note for `operatedHostMachineId`.

## Iteration Summary

- **Round 1** — Standards-Conformance Gate: ran (1 flag: "Verify the State, Not Its Symbol" —
  mtime attribution). Internal reviewers (model: claude-opus-5-5 subagents): security +
  adversarial + integration (one reviewer), decision-completeness + lessons-aware + scalability
  (one reviewer). 9 material findings across both (2 overlapping). Cross-model: unavailable
  (reason above).
- **Round 2** — Internal reviewer (claude-opus-5-5) re-checked every round-1 finding against the
  code: all resolved; 1 new material finding (dark drainer on the owner is silent). Resolved.
- **Round 3** — delta check by the author against the round-2 finding: the owner-side no-token
  degradation and its E2E test are in the spec and the code. No new material findings.

## Full Findings Catalog

1. mtime freshness can misattribute a failure (conformance gate) → per-session file.
2. Job body path / directory unspecified → env var `INSTAR_JOB_FAILURE_FILE`, directory created at spawn.
3. "Write the file, then stop" can turn into a timeout → "finish normally"; killed keeps timeout with the reason appended.
4. Posture rules incomplete (401/403/unreachable/no posture/fleet unavailable) → one table.
5. Core check left to a model → server `FeedbackFactory.drainPosture` degradation.
6. Owner-missing rollout unaddressed → rollout section; the Mac Studio config already names itself.
7. No test plan → three-tier plan.
8. Every machine could drain once the token syncs → owner gate.
9. `processQueue` runs before `notifyJobComplete` → per-session file removes the ordering question.
10. Dark drainer on the owner stays silent (round 2) → `FeedbackInbox.blobToken` degradation.
Minor: SafeFsExecutor for deletes; scrub reasons; mirrored shadows; tmux wording; fresh-install literal; leftovers documented.

## Convergence verdict

Converged after 3 rounds: zero material findings in the final round. Open questions: none.
Cross-model review unavailable, disclosed above.
