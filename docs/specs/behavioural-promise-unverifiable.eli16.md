# A promise counted as kept because a text box was filled in — Plain-English Overview

> The one-line version: the system that tracks whether I keep my promises to you was
> deciding that question by checking whether one optional text field had been filled in
> when the promise was created — ninety-eight cases out of ninety-eight, with no exceptions.

## The problem in one breath

When I promise you something about how I will behave, that promise gets recorded. There is
a periodic check that marks each one either kept or broken. The check worked like this: it
looked in a reminder file to see whether the promise's identifier appeared there. If yes,
kept. If no, broken.

But **that reminder file is written by the very same system, from its own list of
promises.** And nothing else on the machine reads it. So the check was asking "did I
successfully write my own note?" and reporting the answer as "did Echo keep her word?"

## What the numbers looked like

Seventy-four promises had that optional field filled in. **All seventy-four read "kept."**
Twenty-four did not have it. **All twenty-four read "broken."** No exceptions in either
direction.

And because the check ran every minute or so, each one collected another tally mark every
time. One promise from March had accumulated **a hundred and sixty-two thousand
"violations."** Four created in the same minute all showed the identical number — which no
amount of real behaviour could produce, and which is what gave the game away.

The one holding *your* request — that I re-affirm the goals summary every few hours — was
in the second group. It was **born permanently broken**, and would have read that way
whether I sent you every summary or none of them.

## What this changes

> **Correction added 2026-07-26, after this shipped.** What follows is true of promises
> recorded **from now on**. It is not true of promises that already existed — and I originally
> wrote it as though it were. The fix works by *declining to reach a verdict*, so it never goes
> back and revisits a verdict already stamped. Checked on a live install: ninety-eight existing
> records still showed their old readings, seventy-four "kept" and twenty-four "broken". The
> runaway tally did stop for all of them. The stale verdicts did not clear, and clearing them is
> a separate decision that hasn't been made. Left visible rather than edited away, because a
> description that over-claims is the same fault as the one this page is about.

A promise about behaviour is now left **open** rather than being declared kept or broken.
Nothing here can watch what I actually do, so the honest answer is "not determined yet" —
which is precisely what this same file already does for another kind of promise it cannot
check, ten lines away, with a comment explaining why.

Both wrong answers go, not just one:

- **"Kept" was the more dangerous.** It offered reassurance nobody had earned.
- **"Broken" was a false accusation.** A blank optional field is not a broken promise.

The health readout changes too. It used to say "all verified" whenever nothing was marked
broken — inferring compliance from the absence of complaints. It now says how many
promises are actually verified and how many simply cannot be checked automatically.

## What it does not fix, said plainly

**Whether I actually keep behavioural promises is still not verified by anything.** This
change stops the system claiming otherwise; it does not build real verification. Doing that
would mean genuinely observing my conduct against each rule, which is a much bigger piece
of work and is not attempted here.

So this is a change from a confident wrong answer to an honest absence of one. That is an
improvement, but it is worth being clear about which of the two it is.

## The safeguards

The reminder file still repairs itself if it goes missing — that was worth keeping. It just
no longer counts as evidence about a promise.

Nothing can be blocked, delayed or altered by any of this; it is a status calculation. And
the change *removes* a false alarm: because twenty-four promises were wrongly marked broken,
the commitment component reported itself permanently degraded. It no longer does.

## A note on the old tests

Three existing tests had to be rewritten, because all three asserted the behaviour being
removed — including one that asserted a *missing* optional field should count as a broken
promise.

The middle one is worth quoting. It was named **"detects violation when rules file is
deleted"** and its body asserted that nothing was detected, with a comment conceding "so it
should still pass." A test whose name contradicts its own assertion records an intention
that nobody implemented — and it sat green in the suite, looking like coverage.
