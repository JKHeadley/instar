# ELI16 — Two reasons finished work sat still on 2026-10-25

## What happened

On 2026-10-25 the operator asked why the agent's own automation didn't pick work
back up. Two separate small problems were each enough to stop it.

## Problem 1: the merge line judged PRs by their branch name

When the agent opens a pull request and the tests pass, a background helper is
supposed to merge it. That helper only looked at PRs whose branch name started with
`echo/`. But the agent names most branches `fix/...`, `chore/...`, `feat/...` and so
on. Nine of ten open PRs were invisible to the merge step. The local tests passed
them, the merge step said "not mine", and nobody was told.

The list the helper reads is already filtered to PRs opened by the agent's own
GitHub account, so the branch name was a bad second guess about ownership.

**The fix:** a PR counts as the agent's own when its branch starts with `echo/`
(as before) OR when GitHub says it was opened by the agent's configured account from
a branch in the same repository (not from a fork). Everything else that protects a
merge stays exactly the same: hold labels, drafts, conflicts, passing tests, files
only the operator may approve, and the final safe-merge check.

If a PR is still skipped for ownership (for example a fork), that is now written to
the log once and counted on the status page, so it can never vanish silently again.

## Problem 2: a restart told the new session to sit and wait

When a conversation switches model or framework, the old session is stopped and a
new one is started with the conversation history. If there was no new message from
the user, the new session was told: "wait silently for the next user message." But
the old session might have been in the middle of something. That day, it had just
said "the PR opens as soon as it's green", and then the new session waited forever.

**The fix:** the new session is now told to keep going with anything clearly still
in progress — the next step its last message promised, or an open commitment for
this conversation (listed for it) — and to report the result normally when done. If
nothing is in progress, it still waits quietly. It is still told not to talk about
the switch itself.

## What you need to decide

Nothing new. Both changes are small and fully undone by reverting the commit. No
settings, no migrations.
