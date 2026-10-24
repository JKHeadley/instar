# Pre-Push Review Check: Pair It to the Work, Not the Clock — ELI16

## The one-sentence version

A safety check that asks "has this work been reviewed?" was actually asking "was any
review written in the last 24 hours?" — so completed reviews stopped counting as time
passed, and the check began blocking pushes for work that had already been reviewed.

## What already exists

Before anyone pushes to the instar repo, a gate runs. One of its checks (check 5) looks
at the release notes waiting to ship. If those notes claim a fix or a feature, the gate
insists that a **side-effects review** exists — the written analysis of what a change
might break. No review, no push. That part is correct and stays exactly as it is.

Release notes are written as small files, one per change, that pile up in a folder until
a release is cut. At that point they are folded into a single version file and the folder
is emptied. So the pile can hold a week of already-reviewed work.

## What was wrong

To decide whether a review existed, the check looked for **any** review file modified in
the last 24 hours.

That question answers itself differently depending on what day you ask it. A batch of
work reviewed on Tuesday passes on Tuesday, passes on Wednesday morning, and then starts
**failing** on Thursday — not because anything changed, but because the clock moved.

Seen for real on 2026-08-21: nine changes waiting to ship, nine matching reviews written
the same day as the work, and the gate refusing every push — including one that only
touched a documentation file. The newest review was about 41 hours old.

The nasty part is the advice it gave. It said "add a review for this change." But the
change already had one. The only way to literally satisfy it was to write a **second**
review for already-reviewed work, or re-save an old file to reset the clock. The check's
own source code carries a warning about this: three separate times, someone hit a similar
dead end and wrote a placeholder file to get past it. Two of those files admit it in
their own text.

A gate whose only available remedy is to produce a junk document is teaching people to
produce junk documents.

## What changed

One question replaced another.

- **Before:** "Was a review written recently?" (compared against today)
- **After:** "Is there a review at least as recent as the newest thing waiting to ship?"

The second question has a stable answer. If everything waiting to ship was reviewed when
it was written, that stays true tomorrow, next week, and next month.

The error message was rewritten too, because it described the old rule. A message that
misstates its own check is its own small version of this bug.

## The safeguards, in plain terms

**It still refuses unreviewed work.** Add a new change without reviewing it, and its
note becomes the newest file in the pile — newer than every review — so the gate stops
you. This was tested directly: a temporary unreviewed note was added, the gate refused,
the note was removed, and the gate passed again.

**A ten-minute grace window.** When someone freshly clones the repository, every file
gets the same timestamp and their relative order is essentially random. Without a small
tolerance, a clean checkout could fail for no reason — the same cry-wolf problem wearing
a different hat. Ten minutes is far shorter than the gap between writing a change and
forgetting to review it, so it cannot hide a real omission.

**Nothing else moved.** Per-change enforcement at commit time is untouched. The rule
that a release-relevant push must ship notes at all is untouched. Continuous integration
still skips this check entirely, as it did before.

## What you actually need to decide

Whether the replacement question is the right one.

If you think "is there a review at least as new as the newest pending change?" is too
loose, the alternative is matching each note to its own review by name. That is stricter,
but the names do not reliably correspond — one note called `r6-agent-identity-continuity`
pairs with a review called `agent-identity-continuity-on-expansion` — so name-matching
would produce a new class of false refusals, which is the failure being removed.

## Honest limitation

Re-saving an unrelated old review for any reason lifts the bar for the whole batch. That
exposure existed before and is strictly smaller now: the old rule accepted any touch of
any review as proof for any change. This is a real gap, not a solved one — closing it
properly needs reliable note-to-review pairing, which does not exist today.
