# Plain-English overview: automated rebase must not leave a conflicted tree

## The everyday version

Imagine a shared workshop. One of the machines is a "tidy up my bench" routine
that reorganises your tools onto the newest layout. Usually it works. Sometimes
two people moved the same tool and the routine gets stuck halfway — bench half
disassembled, drawers open, parts on the floor.

Our code runs that routine automatically three times, in three different places.
In all three, the code says: *"if the tidy-up fails, never mind, carry on."* And
carrying on is fine — the tidy-up was optional. The problem is that "never mind"
does not put the bench back. It walks away from a half-disassembled bench.

The next person to use that bench cannot use it at all. Not "their work is
harder" — the door is jammed. In git terms: a rebase that hits a conflict does
not undo itself. It leaves the repository parked mid-operation, and the next
command anybody runs there fails.

## What's odd about this one

One of our modules — GitSync — already learned this the hard way in production.
It has code that detects a repository stuck mid-rebase, backs it out, and then
deliberately uses a *different* strategy so it doesn't get stuck the same way
again. There are two comments in the code explaining exactly why. Somebody
already paid for this lesson.

Two sibling modules never got the memo. Same operation, same failure, no
cleanup.

## The thing we checked before believing the story

The proposal that started this said something reasonable: probably the sibling
module is the one *creating* the mess that GitSync keeps cleaning up. One
machine makes the problem, another quietly fixes it, and neither knows about the
other. Good story.

We went and looked instead of assuming. Two findings:

1. The server's log contains **zero** mentions of GitSync ever finding a stuck
   rebase. Not "a few" — none.
2. Nothing in the running product actually *starts* those two sibling modules.
   They're exported for other people to use, and only our tests construct them.

So the tidy story is wrong for this machine. The repairing half runs; the
producing half doesn't. That downgrades this from "an active bug hurting us now"
to "a latent bug in code we ship for others" — still worth fixing, cheap to fix
now, but we say which one it is rather than borrowing urgency the evidence
doesn't support.

## What we're actually changing

**Two of the three places** are pure optional tidy-ups — nobody downstream cares
about the conflict. There, we simply back the operation out before walking away.
Five lines. The success path doesn't change at all.

**The third place is deliberately different**, and this is the part worth getting
right. There, the half-finished state is *the point*: the code hands the conflict
to a resolution step that's supposed to sort it out. Backing it out there would
throw away the very thing the next step needs. So instead we add one small label
saying *how* the tree got messy — because the cleanup command is different
depending on which operation caused it, and right now the resolver isn't told.

The tempting move was "apply the same fix to all three, it's the same operation."
That would have been a regression dressed as consistency.

## Why we didn't just add a rule against ignoring errors

We already have one. There's a test that fails the build if you write an
error-handler that does nothing, precisely so nobody swallows failures without
thinking. **It passes on all three of these.** The rule is satisfied by writing a
comment explaining yourself — and all three have comments. They're just wrong:
"not fatal to the sync" is true, and "not fatal to the repository" is what
mattered.

That's the useful lesson beyond this fix. A check that asks *"did you think about
this?"* can't tell a correct answer from a confident one. So the new guard checks
the **outcome** instead: after any automatic rebase, either the code cleans up,
or it explicitly names who owns the mess it left behind. You can't add a fourth
one of these by accident.

## What we're deliberately not doing yet

The proposal also suggested pulling GitSync's hard-won strategy into a shared
helper the other three could share. We're holding off, and saying why: that
argument assumes three real users. There's one real user and two that only tests
ever start. Building a shared abstraction for two hypothetical callers is the
kind of tidy-looking work that ages badly — and the interesting part of GitSync's
behaviour (retrying a different way) is something we specifically *don't* want at
the other two sites, because their work was optional to begin with.

Deferred, not dropped, with the reasoning written down so nobody has to
re-derive it.

## How you'd know it worked

Make two branches that edit the same line, run the sync, then try to switch
branches. Today that switch fails, because the repository is stuck mid-operation.
After this change it succeeds — and the sync still reports honestly that the
optional freshen didn't happen.
