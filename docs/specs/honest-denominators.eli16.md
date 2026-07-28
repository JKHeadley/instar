# Honest denominators — plain-English overview

## What this actually is

Two places where one of our own safety checks announced a result it had not earned. Both were
found while auditing whether our systems can actually see themselves, on 2026-07-25.

## The first one: a gate that said "blocked" and did not block

Before you can commit a change to instar, a check runs that makes sure the change went through
the proper development process. When it objects it prints a large banner reading **"commit
BLOCKED"**, lists the files it objects to, and explains what is missing.

It was not blocking anything.

The reason is small and completely mechanical. That check is one of seven commands run in a list,
and the list did not stop when a command failed. The objecting check ran, failed correctly, and
printed its banner — then three more checks ran after it, all succeeded, and the computer read the
*last* result. So a clear, correct refusal was computed and then thrown away one line later.

This was proved rather than guessed: a commit was deliberately made through a printed block, and
it landed. It has since been backed out.

The practical effect is that **every check in that list except the final one could shout but not
stop anything.** Worse than having no check, because everyone involved — including the agent using
it to hold another agent to the process — believed it was working.

**The fix is one line**: tell the list to stop at the first failure. The proof it works is that
the exact commit which slipped through before is now refused.

## The second one: a score of 100% for having measured nothing

We keep a map of the codebase so any part of it can be navigated from the top. There is a health
figure that reports how fresh that map is, and a check in our build pipeline that fails when
freshness drops too low.

The map is currently empty. The freshness figure read **100%**.

That was not an accident either — the code explicitly says *if there is nothing to divide by,
report one*. Someone considered the empty case and chose the flattering answer.

The consequence is the same shape as the first problem. A perfect score passes every possible
threshold, so **the check that exists to catch a rotting map cannot fail on a map that does not
exist at all.**

**The fix** is that the figure now reports "unknown" rather than a perfect score when it has
nothing to measure, and the build check treats unknown as *could not assess* instead of *passed*.

## The safeguards, in plain terms

Two different kinds of "empty" are now told apart, because conflating them would have broken
things:

- **No map at all** — the normal situation, since this feature ships switched off. This still
  passes, but now says out loud "this check gated on nothing" instead of quietly reporting success.
- **A map that exists and is empty** — the genuinely worrying case. This now fails.
- **A brand-new map whose entries are all still inside their grace period** — legitimately too
  early to judge, so this still passes. This one was found the hard way: the first version of the
  fix failed it, and two existing tests caught the over-reach.

## One thing worth knowing about how this was built

An existing test asserted that the freshness figure must be a number, on a map with nothing in it.
That assertion had the side effect of locking in the 100%-for-nothing behaviour — anyone fixing
this honestly would have been failed by our own test suite for doing so. It now checks the honest
answer instead, and the reason is written next to it so it does not get quietly reverted.

Three new tests fail if anyone puts the flattering default back.

## What you actually need to decide

Nothing is being asked of you here. Both changes make existing machinery do what it already
claimed to do, and both back out completely by reverting — one is a single line, the other a
single commit. There is no data to migrate and no stored state that depends on the old shape.

The one thing worth your attention is a judgement call deliberately **not** bundled in: the
freshness threshold is currently set to zero, which means even a populated-but-rotting map would
pass. Raising it is a separate decision about how strict we want to be, and mixing it in would
have hidden which change caused which effect.
