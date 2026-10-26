# ELI16 — A pull request that can no longer merge now says so

## What happened

Before a pull request is merged, the server tests the exact code the merge would
produce: the pull request's latest commit combined with the current `main`. To do
that it first asks git to combine the two. Sometimes git cannot, because another
change already merged into `main` edited the same lines. That is a merge conflict,
and only a person (or the agent) can fix it, by rebasing the branch and pushing.

On 2026-10-25, PR #2363 hit exactly this. The server recorded a technical error
("error:conflict"), tried the same combination a second time a moment later (which
can never give a different answer), and then simply stopped. GitHub's auto-merge was
still switched on, waiting for a passing check that could never come. Nothing asked
anyone to rebase, so the PR sat for hours before someone noticed.

## What changes

1. **No pointless retry.** A conflict depends only on the two commits being combined,
   so the server no longer runs it a second time. Other errors (a crashed install, a
   timeout) keep their one automatic retry.
2. **It stays visible.** The queue page (`GET /local-verify`) now has a `conflicts`
   list naming each PR that no longer merges, with the commit and the `main` commit it
   was tested against. The saved result for that commit still says `error:conflict`.
3. **The PR page says what to do.** The required check on the PR now reads
   "no longer merges into main — rebase needed (base abc1234)" instead of a technical
   error label.
4. **Someone is told, once.** One attention item is raised per pull request and
   commit, titled "PR #N no longer merges into main — rebase needed". It is marked as
   raised by the agent, so it reaches the Attention topic instead of being filed as
   routine status.
5. **It cleans itself up.** When a rebase is pushed, the new commit is queued and
   tested as usual and the attention item is closed. It also closes if a later test
   of the same commit passes (for example the conflicting change was reverted) or the
   PR is closed. After a server restart the open conflict is rebuilt from the saved
   results, so the clean-up still happens and no second item is raised.

## What does not change

Nothing is rebased automatically, and auto-merge is not switched off: the failing
required check already stops the merge. No new channel is added; the existing
attention queue and commit-status posting are used.

## What a reader needs to decide

Nothing. This is a small, reversible fix to a silent failure. Reverting the change
returns the old behaviour exactly; it leaves no new saved state behind (the
`conflicts` list is rebuilt from the existing results journal).
