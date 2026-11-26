# Convergence Report — Quota pacing, step 3: spend by account

## Cross-model review: codex-cli:gpt-6-astra

A GPT-tier external pass (codex CLI, gpt-6-astra) ran in all three rounds. Gemini was not available (not signed in). The Anthropic clean-door read (claude-code, which ran on claude-opus-5-5) ran in round 3; it is a second Claude read, not a cross-model opinion.

## ELI10 Overview

Instar records every request it sends to Claude or Codex. That record has a slot for which subscription account paid. Today the slot is filled from the account a session was told to use, and on November 17 that label was wrong for three sessions. This step fills it from evidence instead.

A transcript sits in the folder of the login that ran it. Instar already keeps a checked record of which account is signed in to which folder, and the poller confirms Claude sign-ins. The label is kept beside the evidence, so a mislabelled session shows up as a mismatch. A new report gives spend per account across all machines. It also measures roughly how much work one percent of each account's week is worth. The forecast can then stop assuming every account is the same size. Everything is read-only and starts on Echo's machines only.

## Original vs Converged

- **Who was signed in.** Originally the account came from today's enrollment mapping, applied when the file was scanned. After review it comes from evidence about the time of the work:
  - Instar's record of which account sits in which folder, when that record is in use.
  - Otherwise, a new small log of the poller's sign-in checks.

  So a folder signed in to a different login later can't relabel older work.
- **Totals across machines.** Originally the per-account totals would have read the shared all-machine totals. Those can't be split by account. After review the account report asks each machine for its own detailed records and merges them.
- **Unchecked records are kept out.** Codex sign-ins are never checked, and some records carry only a session's label. Both stay out of the size-of-a-point figure and are shown separately.
- **The figure itself.**
  - It is a workload-dependent lower bound. My draft said "ceiling", which was backwards.
  - Points and spend are measured over the same stretches of time.
  - Cycles with no use, or with too little history, say "can't tell".

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | gate (8 flags, fit weak), security/scale, integration/decisions, codex | 15 | 9 | attribution from the credential ledger or enrollment; no rollup re-key; fan-out over raw events; identity at scan time; censored and retention handling |
| 2 | security/scale, codex (integration/decisions: none) | 5 | 8 | drift judged at the row's time from a durable check log; costPerPoint direction corrected; segments; binding-only rows kept separate |
| 3 (cap) | security/scale, codex, clean-door | 7 | 3 | identity-check intervals; one identity key; verification must predate the row; emitted-row cursors; switch history log; 14-day segment limit |

Standards-Conformance Gate: ran in round 1 (8 flags, all addressed in the round-1 revision). Internal reviewers ran on claude-opus-5-5 subagents.

## Proportion

Tier 1 (read-only, additive, dev-gated; a revert undoes it). The spec has about 180 lines, and it used 3 rounds of a cap of 3. Review stayed busy because the existing attribution plumbing (rollups, identity checks, credential ledger) was more involved than the first draft assumed.

## Left behind

- No Codex identity check exists, so the Codex figure stays an unconfirmed estimate.
- No rollup re-key, so `/usage/tree` and `/usage/top` still can't group by account.
- No figure for cycles older than step 1's 14 days of full-detail history.
- Precision items: the exact page-size limit for the fan-out answer, and the timing of the switch-history log write at boot.

## Convergence verdict

Converged at round 3, the Tier-1 cap. The round-3 design findings were fixed in place, and each fix is narrow: interval logging, an identity-key format, a cursor rule, a verification-time rule, a switch-history log, and a history-window limit. None of them is about safety, security or data loss; the change is read-only. The integration and decisions reviewer reported no design findings in round 2. Counts: 5 frontloaded decisions, 0 cheap-to-change tags, 10 contested and cleared, 0 open user decisions.
