# safe-merge could not merge big pull requests, or approved constitution changes — the plain version

## What was wrong

Instar has a merge tool, `safe-merge`, that checks a pull request is really ready before it
merges it. To do those checks it asks GitHub's command-line tool, `gh`, questions such as
"which files does this pull request change?". GitHub answers with every changed file AND the
full text of every change.

The tool was reading those answers with Node's default setting, which only allows 1 MiB of
output. When a pull request was big (the one that exposed this changes 94 files, about
1.6 MB of changes), the answer was larger than that limit. Node then killed the `gh` process
with an error called ENOBUFS ("no buffer space"), and safe-merge treated that as "I could not
verify the checks" and refused the merge. So any pull request that big could never be merged
by the tool, no matter how good it was.

## What changes

Every place safe-merge runs `gh` now uses one shared setting that allows up to 256 MiB of
output, far more than any real pull request. Nothing else changes: the same questions are
asked, the answers are read the same way, and every refusal that was correct before is still
made.

## Safeguards

- A new test runs a real process that prints 3 MiB through the tool's own `gh` helper and
  checks it comes back whole, and checks the old default setting really does fail on it.
- The test also checks that every `gh` call in the script uses the shared setting, so a new
  call cannot quietly go back to the 1 MiB default.
- A real failure to start `gh` still stops the merge, as before.

## The second problem: approved constitution changes could never merge

Some files (the constitution, `docs/STANDARDS-REGISTRY.md`, and the file that says who owns
it) need Justin's approval before they can merge. GitHub records that approval, but because of
how the main branch rule is set up (it asks for the owner's review but "0 required approvals"),
GitHub never fills in the summary field that says "approved". safe-merge only looked at that
summary field, saw it empty, and refused, every time, even after Justin approved. So no
constitution change could ever be merged by the tool.

Now, only in that exact case (the owner's review is required, an owned file is changed, and
GitHub's summary is empty), safe-merge reads the reviews themselves. It lets the merge go ahead
only if, for every owned file, one of that file's owners approved the exact latest version of
the pull request, and did not later ask for changes. An approval on an older version does not
count, the person who wrote the pull request does not count, and the account doing the merge
does not count. If a file is owned by a team instead of a person, safe-merge cannot tell who is
on the team, so it keeps refusing and says why. Whenever GitHub's summary is filled in, nothing
changes.

Tests cover each side: owner approval on the latest version passes; an old-version approval, a
non-owner approval, a later "changes requested", and a self-approval are all refused; the
filled-in summary still behaves as before.

## What you need to decide

Nothing. It is a small, fully reversible fix to an internal tool: reverting the commit undoes it.
