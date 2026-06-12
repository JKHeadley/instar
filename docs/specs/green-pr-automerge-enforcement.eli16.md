# Green-PR Auto-Merge Enforcement — Plain-English Overview

> The one-line version: when a code change I authored has passed every review, gate, and
> test, a background watcher merges it — nobody has to remember to click anything, and I
> can't hand the click back to you.

## The problem

Twice now (June 9 and June 12) I finished a change, watched it go fully green, and then
told Justin "merge is yours whenever you're ready." That's backwards: by the time my own PR
is green it has already been through the converged spec review, the commit gates, and the
full CI suite — it is pre-approved by definition. Handing the click back creates manual
work, and on June 12 it also cost real time: while the PR sat waiting, the main branch
moved and the PR went stale, forcing a whole extra conflict-fix-and-retest round.

The June 9 fix was written into my build instructions ("Phase 7: merge it yourself, never
ask"). It failed anyway — the session running the build crashed, and the sessions that
picked the work back up never saw that instruction. A rule that lives in instructions dies
with the session that read them.

## The fix — two layers, both structural

**1. A watcher that merges for me.** A small background component checks every ~10 minutes:
do I have any open PRs that I authored, fully green, not marked as a deliberate hold? If
yes, it merges the oldest one. It merges at most one PR per pass, backs off and gives up
loudly (one combined heads-up, never a spam) if merging keeps failing, writes every
decision to an audit log, and has a one-call kill switch you (or an emergency stop) can
flip at any time without a restart. A PR that's *supposed* to wait — a `[HOLD:` title or a
`hold` label — is always left alone, and the hold is re-checked right before the merge,
not just when the PR was first seen. Held PRs that sit for over a week get surfaced so a
lazy hold can't become the new way work rots.

**2. A nudge at session exit.** If I try to end a session whose branch has a green
unmerged PR, the existing session-exit guard blocks me once: "merge it or mark it [HOLD]."
Sessions unrelated to the PR are never bothered, and if anything about the check errors,
the session ends normally — it nudges, it never traps.

## What the review process hardened (the honest part)

The first draft trusted the existing merge script more than it deserved. The deep review
(six internal reviewers plus GPT-5.5 and Gemini 2.5 Pro) found the script could — in rare
windows — merge a commit that arrived *after* the checks passed, report "merged" when the
merge actually failed, and was pinned to one hardcoded repo. This build fixes the script
itself: it now pins the exact verified commit (a late push means refusal, not a surprise
merge), double-checks the merge really landed before claiming success, cross-checks the
repo's required checks list, and takes the repo as an explicit parameter. The review also
caught that my GitHub login is actually **your** account on these machines — so "my own
PRs" is now verified two ways (the login AND my branch-name prefix `echo/…`), and the
watcher refuses to run at all if the identity doesn't match what's configured.

Also: only one machine in my pool runs the watcher at a time (the same leadership lease
the rest of multi-machine uses), so two machines can never race the same merge — and the
kill switch follows the pool, not one machine, so disabling it anywhere disables it
everywhere. Two more things the second review round added: "my PRs" is no longer just a
naming convention — a candidate must also carry passing runs of the specific CI checks
that only the real dev process produces, so junk on a lookalike branch can't ride; and if
you say "hold #N" in chat, I have a one-call lever that stamps the hold marker on the PR
immediately, so a conversational hold becomes a real hold the machinery respects.

## What it will NOT do

- Never merges anyone else's PR — only ones verifiably mine.
- Never merges anything red, conflicted, draft, or held — and a hardened verifier script
  makes the actual merge decision, not new code.
- Doesn't resolve conflicts; a stale PR is reported, and fixing it stays my job.

## The one decision you're ratifying with "approved: true"

**This ships live on me immediately — no observe-only trial period.** My reasoning: you've
directed this exact behavior twice, the merge has been formally mandatory (just manual)
since June 9, and the hardened verifier re-checks everything at merge time. The trial
period would just recreate the waiting you're trying to kill. The kill switch, dry-run
lever, and off-by-default fleet posture all remain if you ever want to pull it back. If
you'd rather have a dry-run week first, say so before approving and I'll fold it in.
