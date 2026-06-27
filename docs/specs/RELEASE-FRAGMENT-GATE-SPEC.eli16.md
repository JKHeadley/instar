# Release-Fragment Gate — ELI16

## What's broken

Every time instar ships a new version, the release robot needs a short "what
changed" note (a little file under `upgrades/next/`). If that note is missing, the
robot does the safe thing and **refuses to ship** — which is correct. The problem
is it refuses **silently**: the release job lights up green and looks like it
worked, but no new version actually came out.

On June 27 this bit us. Three real bug fixes reached the main codebase, but nobody
attached the "what changed" note. So the robot quietly skipped shipping them, and
they sat unshipped for about seven hours. Worse, an earlier session saw the green
checkmark and wrongly told the operator it was an "upstream pipeline glitch," when
really it was our own missing note.

## The twist the review uncovered

There IS already a guard that demands the note — but it only runs on your own
computer when you push code by hand. The way code actually lands these days (the
robot squash-merges an approved pull request on the server) skips that guard
entirely. So the rule existed but was checked in the one place merges don't happen.
That's the real hole.

## The fix

Move the SAME rule to where merges actually land — the server — so it can't be
skipped, and make any leftover silent skip **loud**:

1. **A check on the pull request (the real fix).** Before code merges, a server-side
   check notices "this PR changes real code but has no note" and asks the author to
   add one — or to drop in a one-line "no user-facing note needed" marker for tiny
   internal changes. Because it runs on the server, nobody can route around it. It
   starts in "just warn" mode so we can watch for false alarms, then becomes a hard
   block once it's proven calm.

2. **A loud alarm for anything that still slips by.** If a release ever skips while
   real code went unshipped, the agent's own release-watcher raises a visible alarm
   instead of staying quiet, and the release log prints a big warning. No more silent
   green.

## What does NOT change

The robot still refuses to ship a version with no note — that rule is right and
stays. We're only making the refusal **un-skippable and loud** instead of
locally-checked and silent. And the block is deliberately simple: "is a note (or a
'no note needed' marker) there, yes or no?" — never a fuzzy judgment a regex would
get wrong.

## Why it matters

This is the "build it into the structure, don't rely on remembering" rule. A guard
that only runs on your laptop is a guard people route around. A guard at the place
work actually merges is a guarantee. And a release that silently swallows finished
work is exactly the "looks protected while being fake-protected" failure the
constitution warns about.

---

*Status (2026-06-27): approved by Justin and built. Ships in this PR — the Layer-1
PR check starts in warn-only mode; flip to a required blocking check per the spec's
D3 criterion.*
