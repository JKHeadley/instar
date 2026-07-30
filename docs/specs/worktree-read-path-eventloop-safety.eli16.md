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
commands go through. Another part of the agent already uses it for exactly this
reason. This was genuinely useful to discover — it meant no new hole had to be cut
in a safety checkpoint. The fix rides on something already built and reviewed.

**New:** the status pages now use that non-freezing method; the checks run a few at
a time instead of all at once; one repeated lookup that was being redone for every
single copy is now done once; and if several people ask at the same moment they
share one answer instead of each triggering the whole job again.

## The safeguards, in plain terms

- **Nothing about the decisions changed.** Which leftovers are safe to clean up, and
  which are kept, is exactly as before. Two tests exist purely to prove that, and
  they are labelled honestly as *not* being proof the freezing is fixed.
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

## An honest note about the testing

The first version of the test that was supposed to prove this was fixed **passed
against the broken code**. That made it worthless — a test that cannot tell broken
from fixed proves nothing.

The cause was subtle: the measurement stopped a fraction too early and never
actually observed the freeze it was looking for. Once corrected, it fails against
the broken code with 758 thousandths of a second of freeze against a 250 limit, and
passes against the fix. Every test here was run against the broken code first, on
purpose, for exactly this reason.

## What you actually need to decide

Whether to approve this so it can be committed.

Things worth weighing:

- **Risk of doing it:** it changes how a helper that *deletes things* reads
  version-control state. That is why it is filed at the highest care level, even
  though the automated check thought a lower one was warranted. No decision logic
  changed, and all three layers of the test suite pass.
- **Risk of not doing it:** every visit to either status page freezes the agent for
  several seconds, including its heartbeat to your other machine. The status page is
  about to be given a *more* important role, so it will be visited more.
- **Backing it out:** one setting makes the checks run strictly one at a time, and a
  full reversal is just undoing the code. Nothing is stored, nothing is migrated,
  and there is no data to repair.
