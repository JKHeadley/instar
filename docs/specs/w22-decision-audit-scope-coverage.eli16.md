# Plain-English overview — the audit gate now checks that the paperwork matches the work

## What this is

Every time this agent changes its own source code, a local check runs before the change is saved and
writes a small record: what was changed, and which files it covered. When the change later becomes a
pull request, a second check on the server side confirms that record came along for the ride. That
second check is what this change is about.

## What was wrong

The server-side check only asked whether *a* record was present. It never compared the record to the
change. So a pull request that touched five files could carry a record describing one completely
different file, and the check would report everything in order. Anyone reading the green tick would
reasonably conclude the change had been reviewed by the local gate. It might not have been.

That is not a hypothetical. The record is written per gate run, and a pull request can easily contain
commits from more than one run — or commits made in a workspace where the local gate never ran at
all. The check existed precisely to catch that second case, and a stale record from an unrelated
commit was enough to satisfy it.

## What changes

The check now reads the records the pull request carries, collects the file paths each one declares
it covers, and requires every in-scope changed file to appear somewhere in that collection. If a file
was changed and no record claims it, the check fails and names the specific files that are not
covered, along with what to do about it: re-run the local gate so the record declares them.

## What is deliberately kept

Three existing escapes are untouched. Pull requests opened by a bot are still exempt. Release-cut
pull requests are still exempt. A pull request that changes no in-scope files still passes without
needing any record at all. The older single-file record format still satisfies the check, so any
pull request already in flight on the old format is unaffected.

## The safeguards, in plain terms

If a record is missing the list of files it covers, or that list is unreadable or malformed, the
record contributes nothing. It does not get the benefit of the doubt. A guard whose failure costs
someone a re-run, but whose false pass lets an unreviewed change through, should err toward the
re-run.

The strictest choice made here is that naming a folder does not count as covering the files inside
it. The local gate writes concrete file paths, so this only matters for a hand-written record, and in
that case being strict is the safer default.

## What this does not claim

This is a correction to one check's logic, reviewed by a human before it lands. It is **not** proven
effective in the formal sense this project uses that word. The measuring instrument that would let
anyone call a guard properly fixed — a test that mutates a guard and confirms the guard notices —
exists only as a draft document; the tool it describes was never built. So the honest label here is
review-grade: better than it was, checked by tests on both sides of the boundary, and not blessed by
an instrument that does not yet exist.

## What the reader actually needs to decide

Whether requiring the paperwork to match the work is worth the friction of occasionally re-running a
local gate before opening a pull request. The failure is loud, names the exact files, and takes a
minute to resolve. The alternative is a check that reports "reviewed" when nothing reviewed the
change — which is worse than having no check, because the green tick is trusted.
