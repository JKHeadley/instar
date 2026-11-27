# The automatic merge step keeps working when many changes are open — Plain-English Overview

> The one-line version: the step that merges tested changes asked GitHub for the whole list of open changes in one request; once the list got long GitHub refused the request and merging silently stopped. It now asks for the list a small piece at a time.

## The problem in one breath

When a change passes its tests, a part of the agent called the auto-merger merges it. Before it does anything, on every pass, it reads the list of the agent's open changes from GitHub, together with the state of every check on each one.

It read that list in one request: up to 100 changes, each with all of its checks. GitHub gives a request of this kind about ten seconds. On 2026-11-13 the agent had 60 open changes (102 open in the project) and the request no longer finished in time. GitHub answered with an error every time.

The auto-merger is built to be careful: after three failed passes it stops trying for an hour. So from 4:55 AM nothing could merge. A change passed its tests at 5:51 AM and simply sat there.

## What already exists

- **The auto-merger** — reads the open changes, decides which are ready, and hands a ready one to the merge script, which re-checks everything before merging.
- **Its breaker** — three failed passes in a row and it pauses for an hour, so a broken GitHub connection cannot cause a storm of retries.
- **The same fix, one room over** — the previous night the test line had the same fault in its own reading of the list, and was changed to read in small pieces (PR 3130). The auto-merger has its own separate reader, which still used the single big request.

## What this adds

The auto-merger now reads the list 15 changes at a time. Each piece takes a few seconds, well inside GitHub's limit, and the pieces are joined into the same list as before.

## The new pieces

- **A paged reader.** It asks for the first 15 open changes, oldest first, then the next 15, and so on until GitHub says there are no more.
- **A translator.** The small requests come back in a slightly different layout from the old single request. Each change is converted into exactly the old layout, so the rest of the auto-merger is untouched and decides exactly as it did.

## The safeguards

**Never half a list.** If any piece fails, or comes back in a form the reader cannot fully understand, the whole read counts as failed, exactly as the old single request did. The auto-merger then does nothing on that pass. It never acts on a list that might be missing changes.

**Same answers.** On the real project, all 59 of the agent's open changes were read both ways and compared after the auto-merger's own interpretation step: identical, in the same order. Tests pin the cases that matter for merging: all checks green, a check still running, a check failed (with the time it failed), a change with no real checks, and a change opened by a bot.

**Only the agent's own changes.** The old request asked GitHub to filter by author. The new one asks GitHub who the signed-in account is and keeps only that account's changes.

**A hard stop.** The reader gives up, as a failed read, after 40 pieces (600 open changes) so it can never loop without end.

**The merge script still decides.** Reading the list only finds candidates. The merge script re-checks every condition on the change at the moment of merging, as before.

## What it costs

A pass now makes a few small requests where it made one large one: 13 to 17 seconds in total for 60 changes. GitHub allows five thousand requests an hour; this adds a handful per pass.

## What you need to decide

Nothing. This is a narrow repair with no setting. It was run live on the maintainer's machine first: the next pass read the list successfully and the waiting change merged seven minutes later.
