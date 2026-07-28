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
unmerged PR, the existing session-exit guard blocks me once: "hold it, or just end the
session — the watcher lands it in ~10 minutes. Don't merge it by hand." (The final
review round removed the ready-to-run merge command this message originally included:
if the watcher is healthy, a manual merge is exactly the manual work this whole build
exists to kill.) Sessions unrelated to the PR are never bothered, and if anything about
the check errors, the session ends normally — it nudges, it never traps.

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

Round 5 closed four more: a PR that touches the merge machinery
itself (CI workflows, the verifier script, the watcher's own code) was already excluded
from auto-merge — "those need human eyes" — but the session-exit nudge would have handed
the agent an exact ready-to-run merge command for them, quietly defeating the human-eyes
rule; now those PRs route to you instead, never to a command the agent can run. The
watcher's safety timer now survives the server restarting mid-merge (which its own merges
routinely cause). The "is our pinned list of required checks stale?" self-check got a
real reference point (the newest commit that actually ran CI — the tip of main usually
hasn't). And both outside models (GPT-5.5 and Gemini) agreed on one condition we've made
binding: before this ever expands beyond me to other agents, the credential must move
from your admin token to a narrowly-scoped GitHub App.

## One honest limitation you're also ratifying

Skipping the "branch must be up to date" rule is the whole point (it's what kills the
stale-PR treadmill), but it has a flip side: my PR's tests ran against main *as it was
then*, so a logically conflicting change that lands on main minutes before my merge
isn't re-tested against it. Today's manual merges have exactly the same gap, textual
conflicts still always block, and main re-runs the full test suite after every merge —
so a rare bad interaction is caught minutes later and the audit names exactly which
merge did it. If you'd rather pay the treadmill cost for re-testing, there's a knob.

## What it will NOT do

- Never merges anyone else's PR — only ones verifiably mine.
- Never merges anything red, conflicted, draft, or held — and a hardened verifier script
  makes the actual merge decision, not new code.
- Doesn't resolve conflicts; a stale PR is reported, and fixing it stays my job.

Round 6 (the final round) caught that two of the staleness self-checks added in round 5
were aimed at the wrong target (the CI checks they validate only ever run on PRs, never
on main itself — so they now validate against recently-merged PRs instead), gave the
"this pool deliberately turned the watcher on" breadcrumb a proper off-switch so a
deliberate disable can't alarm forever, and removed that session-exit merge command.
One outside reviewer (Gemini) went further than the others and said the scoped-GitHub-App
credential should come *before* shipping at all, not just before fleet expansion — the
full report quotes that dissent so you're deciding with it on the table.

## The decisions you're ratifying with "approved: true"

**This ships live on me immediately — no observe-only trial period.** My reasoning: you've
directed this exact behavior twice, the merge has been formally mandatory (just manual)
since June 9, and the hardened verifier re-checks everything at merge time. The trial
period would just recreate the waiting you're trying to kill. The kill switch, dry-run
lever, and off-by-default fleet posture all remain if you ever want to pull it back. If
you'd rather have a dry-run week first, say so before approving and I'll fold it in.
