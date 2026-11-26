# Convergence Report — Sign-in repair: unattended on the agent-session path, and slow retry of failed repairs

**Spec:** [docs/specs/relogin-unattended-agent-session-and-slow-retry.md](../relogin-unattended-agent-session-and-slow-retry.md)
**ELI16:** [docs/specs/relogin-unattended-agent-session-and-slow-retry.eli16.md](../relogin-unattended-agent-session-and-slow-retry.eli16.md)
**Slug:** `relogin-unattended-agent-session-and-slow-retry`
**Status:** Converged at iteration 8 under the 80/20 convergence standard (stop when findings stop changing what is built in a material way). The cross-model reviewer was MINOR in rounds 7 and 8. The internal reviewer still found one narrow design-class edge case in each of rounds 7 and 8; each was fixed in code with a test before stopping. By the strict "two consecutive design-quiet rounds" reading, the internal reviewer never had a fully quiet round — this is disclosed rather than hidden.

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier pass ran in all eight rounds (SERIOUS in rounds 1–6, MINOR in rounds 7 and 8). Across rounds it consistently noted the trust boundary of the trusted local helper; the spec now states that trade explicitly and the operator chose it.

Disclosures:
- **Combined internal reviewer.** From round 2 the six internal perspectives (security, adversarial, scalability, integration, decision-completeness, lessons-aware) ran as one combined reviewer per round; round 1 ran three separate reviewers.
- **Standards-Conformance Gate:** ran in round 1 (2 possible-violation flags, both addressed: login-ownership proof and the "surface once" rule). Not re-run in later rounds.

## ELI10 Overview

When a Claude or Codex subscription gets signed out, Instar can sign it back in itself. The operator listed the accounts it may fix without asking, but on the Macs the newer helper-session way of signing in ignored that list, so those repairs waited all day for a tap. And a repair that failed just stayed failed forever.

This change makes the helper path respect the list exactly like the other paths, and adds a slow, capped retry for ordinary failures: 6 hours, then a day apart, at most 3 times per sign-in problem, re-checking everything first. Safety stops, operator cancels and anything that needed the operator's phone are never retried. Accounts not on the list are re-offered for one tap rather than started.

## Original vs Converged

- **Login ownership.** The draft released a leftover login if it was created inside the failed run's time window. Review showed that could take an operator's sign-in and was also tried before admission. Now the repair records the exact login it created, admission simply ignores only that login, and the existing `cli-starting` replacement takes it over.
- **Hard lines.** The helper had no way to say "I hit a CAPTCHA", so such stops would have been retried. A new strict report hands the repair to the operator and holds the account at approval until a verified success.
- **Backup codes.** Unattended runs could have spent the last single-use Google backup codes. Backup-code accounts now need a full run's worth plus one, and on the helper path (which cannot keep that count honest) they always need a tap.
- **One retry path.** Re-admission on changed inputs used to restart failed rows with no pacing; now failed rows go only through the paced slow retry, and an operator cancel is never followed by a tap-free run.
- **Upgrade heal.** Review found the stuck `echo@` suggestions would never have re-admitted (the row counted itself as "another live repair") and the operator's tap would have failed. Fixed, with a test proven to fail without the fix.
- **Notices.** Failure notices are held while a retry is coming (bounded, and never released into quiet hours ahead of a morning re-offer); notice keys stay distinct across retries; stale "repair ended" notices for a restarted repair are dropped.
- **Breaker.** Counts failed runs from the audit events, so retries still count toward "3 in 24 h".
- **Operator surface.** "Don't retry on its own" button and a "won't try again" line; approval-mode cells say "Will offer to try again".
- **Smaller fixes.** Explicit retry allowlist; quiet hours; one retry per machine (only seat-holding states block); per-cell offset for long-failed rows; malformed config falls back; dry-run refuses an operator re-offer; fresh profile/login method written with the fresh digest; a verified wrong identity whose quarantine failed is now `wrong-identity`.

## Iteration Summary

| Iteration | Reviewers who flagged | Design-class | Spec/code changes |
|---|---|---|---|
| 1 | conformance gate, codex, security, integration, lessons | many | ownership record, hard-line report, backup-code floor, hold, quiet hours, notice hold |
| 2 | codex, combined | 4 + 3 | failed rows out of re-admission, seat-only gate, legacy fallback, helper-path code hold |
| 3 | codex, combined | 4 + 3 | allowlist, per-cell offset, legacy pin, held text |
| 4 | codex, combined | 3 + 2 | challenge-since-admission, approval hold to quiet-hours end, `.oN` keys |
| 5 | codex, combined | 3 + 1 | phone-tap counts as challenge, rollback note, `.oN` on all kinds |
| 6 | codex, combined | 3 + 1 | upgrade heal fix, operator cancel stays approval, breaker counts runs |
| 7 | codex MINOR, combined | 0 + 2 | cancel-during-revalidate guard, fresh profile/method |
| 8 | codex MINOR, combined | 0 + 1 | dry-run refuses operator re-offer; wording |

## Convergence verdict

Converged at iteration 8 under the 80/20 standard: the last two rounds' cross-model findings were minor and wording-level, and the internal reviewer's remaining findings were narrow races/edge cases, each fixed in code with a regression test. No open questions remain.
