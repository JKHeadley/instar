---
title: "Plain-English overview — a status page that froze the whole server"
slug: "worktree-read-path-eventloop-safety-eli16"
covers: "docs/specs/worktree-read-path-eventloop-safety.md"
---

# A status page that froze the whole server

## The short version

Your agent has a housekeeping helper that looks after leftover copies of the
codebase — scratch copies made when work gets done in isolation. There is a status
page that answers "which of these leftovers can be cleaned up, and why is each one
being kept?"

Asking that question froze the entire agent for over ten seconds. Not the status
page — **everything**. Every other page, every scheduled check, the heartbeat that
tells your other machine this one is still alive. One click, ten seconds of a
completely unresponsive agent.

This change makes asking that question stop freezing everything.

## Why it happened

The agent does one thing at a time, very fast. That is normally fine, because each
thing takes a few thousandths of a second.

To answer the status question, the agent has to ask the version-control tool
several questions about **each** leftover copy: has anything been edited here? Is
this work already saved into the main line? Is somebody using it right now? On this
machine there are forty-eight leftover copies, so that is well over a hundred
separate little programs it has to run.

The bug is that it ran them in a way that meant "wait right here until this
finishes, and do nothing else at all." Do that a hundred-odd times in a row and the
agent is simply gone for ten seconds.

## How we know, rather than assume

We measured it on the real running agent. A trivial health check normally answers in
about 17 thousandths of a second. While the status question was being answered, the
same health check took **10.6 seconds**. A second status page had the same flaw and
froze things for 3.7 seconds.

And that ten seconds is the *good* case. The agent gives up early on any leftover
copy that obviously has unsaved edits, and most of them did — so most of them
skipped the expensive checks. A tidier machine would be frozen for longer.

## The part that is a lesson rather than a bug

There was a note in the code explicitly permitting this, on the grounds that the
cleanup helper ships switched off, so nothing was really running it.

That note was wrong in a way nobody noticed. It was true of the *automatic
background cleanup*, but the *status page* runs the same expensive work every time
somebody asks — switched on or not. And on this machine the helper is not switched
off at all: it is switched on. Checking both machines showed them reporting
different states for the same setting.

So a safety claim written in a comment quietly stopped being true when the settings
changed, and nothing re-checked it. That is the real story here, and it is why this
got fixed rather than added to a list.

## What already existed, and what is new

**Already existed:** a way to ask version-control questions *without* freezing
everything, sitting inside the same safety checkpoint that all version-control
commands go through.

**And this is where the plan changed, so it is worth being straight about it.** The
original plan was to use that existing method and add nothing to the safety
checkpoint — which sounded better, because touching a safety checkpoint is the
scariest part of this work. A later review showed the plan did not hold. That
existing method hands back a job that is still running, so the checkpoint writes
down "this was allowed to start" and never learns whether it *succeeded*. A check
that FAILED — the kind of check that decides whether something gets deleted — was
being recorded as though it had gone fine, with no record of the failure at all.
The slower, blocking method records failures properly.

So the choice was: leave the mismatch and describe it honestly in the paperwork, or
close it. It got closed — which means this change **does** add something to the
safety checkpoint after all: a proper non-freezing way to ask a question that
records the answer the same way the old one did. The rules about what is allowed are
untouched and are now written in one shared place instead of copied three times, so
they cannot quietly drift apart.

That reversal is the reason this is still filed at the highest care level.

**New:** the status pages use the non-freezing method; the checks run a few at a
time instead of all at once; one repeated lookup that was being redone for every
single copy is now done once; several people asking at the same moment share one
answer instead of each triggering the whole job again; and every step now has a
time limit, for a reason worth explaining below.

## The safeguards, in plain terms

- **Some decisions DID change, and earlier versions of this page said otherwise.**
  This is the correction that matters most, because this is the page written for
  the person approving the work. The gate ORDER is unchanged, and two tests pin
  that. But in four places the answer itself changed, every one of them toward
  keeping rather than deleting: the last check before a deletion was silently
  broken and now works; a failed scan for "is anything using this?" used to mean
  "nothing is" and now means "keep"; an unreadable lock file used to read as absent
  and now reads as present; and a job abandoned on a time limit is a new outcome
  that did not exist before. The technical documents retracted the "nothing
  changed" claim this morning and this page kept asserting it — a reviewer caught
  that, and it is the fourth time on this change that a correction landed in the
  technical write-up and missed the one a human actually reads.
- **When in doubt, keep.** If any check fails or times out, the answer is "cannot
  tell", which always means keep the copy. A half-finished answer is thrown away
  rather than treated as a success — because a half-answer could look like "this is
  safe to delete" when it is not.
- **One set of rules, not two.** The easier fix would have been a separate fast path
  just for the status page. That was deliberately rejected: the rules that decide
  whether something gets **deleted** must not be able to drift apart from the rules
  the status page shows you.
- **Not a cache.** Sharing only happens between requests arriving at the same
  moment; nothing is stored. The page still tells you what is true right now,
  which was a firm requirement.
- **Nothing can get stuck forever — now on BOTH status pages.** This one came out
  of the same review and is less obvious than it sounds. (The time limits were
  originally added to only one of the two pages while the paperwork claimed both;
  every reviewer in the next round caught it, and the second page has them now.) The "several people share one answer" trick works by
  putting up a sign saying *a job is already running*, and taking the sign down when
  the job finishes. If a job never finishes at all, the sign never comes down — and
  then everyone who asks afterwards waits forever, and the automatic cleanup helper
  quietly stops running altogether. It would look perfectly healthy and simply never
  find anything, which is the exact problem this helper exists to prevent. Killing
  the underlying command is *not* enough to rule this out, because a command can die
  while something it started keeps the line open. So every step now has its own time
  limit and gives up honestly rather than hanging.
- **Giving up says so.** When a check is abandoned this way, the automatic cleanup
  REPORTS that it did nothing that round. Being precise, because an earlier version
  of this line was not: the abandoned job is not actually stopped, so it may still
  finish its own deletions. What it can no longer do — since the latest round — is
  be joined by a SECOND cleanup running at the same time, which is what made the
  "how much may be deleted at once" limit stop meaning anything. But the status page **refuses to answer**
  rather than showing an empty list, because an empty list would read as "nothing to
  clean up here", which is a made-up answer on the page that reports what the
  deleting helper sees.

## An honest note about the testing

The first version of the test that was supposed to prove this was fixed **passed
against the broken code**. That made it worthless — a test that cannot tell broken
from fixed proves nothing.

The cause was subtle: the measurement stopped a fraction too early and never
actually observed the freeze it was looking for. Once corrected, it fails against
the broken code with 758 thousandths of a second of freeze against a 250 limit, and
passes against the fix. Every test here was run against the broken code first, on
purpose, for exactly this reason.

**It happened a second time, in the latest round, and is worth recording rather than
smoothing over.** A test written to prove the new "nothing gets stuck forever"
safeguard also passed against the broken version — so it, too, proved nothing. The
reason is instructive: it tested the safeguard at the layer where the code was
written, and the problem it was hunting only appears one layer up. That test was
deleted rather than kept for appearances, and replaced with three that genuinely
fail when the safeguard is removed.

The habit underneath both is the same one this whole change keeps running into:
claiming something is true, testing the half where it is true, and letting the green
result stand for the whole claim.

## What you actually need to decide

Whether to approve this so it can be committed.

Things worth weighing:

- **Risk of doing it:** it changes how a helper that *deletes things* reads
  version-control state, and it now also adds a piece to the safety checkpoint all
  version-control commands pass through. That is why it is filed at the highest
  care level, even though the automated check thought a lower one was warranted.
  The decision RULES are unchanged; four of the answers changed, all of them toward
  keeping rather than deleting (see above). All three layers of the test suite pass.
- **Risk of not doing it:** every visit to either status page freezes the agent for
  several seconds, including its heartbeat to your other machine. The status page is
  about to be given a *more* important role, so it will be visited more.
- **Backing it out:** one setting makes the checks run strictly one at a time. A
  full reversal is undoing the code AND three things that are easy to forget: the
  new automatic check has to come out of the check list in two places or the test
  suite goes red; a frozen tracking file has to be put back; and a short note this
  change adds to already-updated agents stays behind, because a code reversal
  cannot un-write it. Nothing else is stored and there is no data to repair.
- **One thing that is now caught automatically.** Two mistakes on this branch came
  from the same slip — asking a question the new way but reading the answer the old
  way, which quietly always gives the same reply no matter what is true. An
  automatic check now refuses that pattern outright, and was tested by putting the
  original mistake back to confirm it catches it. A related mistake — changing a
  shared answer without checking everyone who reads it — has **no** automatic check;
  it is written down as a lesson only. That distinction is deliberate, because
  "written down" and "prevented" are not the same thing.
