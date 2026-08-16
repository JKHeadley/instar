# Codex sign-in kept asking forever — plain-English overview

## The thing that went wrong

Instar can sign you in to a Codex (OpenAI) subscription. It shows you a short code, you open a page,
you approve it, and from then on that account is part of your pool.

For one operator that never finished. Instar showed a code, the code expired about fifteen minutes
later, instar showed a new one, and it did that **33 times between 1am and 9am** — still going when we
found it. Approving a code correctly changed nothing.

Worse, and not obvious from the outside: each of those attempts was quietly operating on the
machine's **real** Codex account rather than a separate slot. That is almost certainly what signed the
operator out of Codex earlier.

## What already existed

- Instar keeps a record of each sign-in that is still in progress, with the code and when it expires.
- A background sweep every five minutes refreshes any record whose code has expired, so an operator
  who wanders off does not come back to a dead code.
- Each sign-in runs in its own terminal window, and instar is supposed to point it at a private
  folder so two accounts cannot tread on each other.

None of that is new. The problem was in the details of all three.

## What is new

Three fixes, because there were three separate bugs and any one of them alone would still have
produced a loop.

**1. Point Codex at the folder it actually reads.** Instar was setting the private-folder setting
that *Claude* uses. Codex ignores it and uses a different one. We did not assume this — we tested it:
told Codex to use an empty folder via the setting instar was using, and it happily reported it was
still logged in to the real account; told it via the setting Codex actually reads, and it correctly
said it was not logged in. Now each tool gets the setting it genuinely reads, and a tool with no
setting we have verified gets none at all rather than a misleading one. Handing a program a setting
it ignores is worse than handing it nothing, because everything downstream then believes the account
is safely isolated when it is not.

**2. Notice when a sign-in actually worked.** This was the real cause. There are two shapes of
sign-in. Claude's ends with you pasting a code back into the dashboard — which tells instar, in so
many words, "this one is done". Codex's does not: you approve it on OpenAI's site, the Codex program
writes its own credential and closes, and nobody ever tells instar. So the record sat there marked
"still waiting" forever. Now, before instar refreshes an expired sign-in, it checks whether that
sign-in already succeeded — by looking for the credential in the folder it was supposed to land in —
and if so marks it finished instead.

**3. Stop destroying the thing waiting for your approval.** Every refresh closed the terminal window
running the sign-in and opened a new one. That window was what was listening for your approval. Fix 2
takes care of this: a sign-in that already worked is never refreshed, so its window is never closed.

## The safeguards, in plain terms

The obvious risk in fix 2 is deciding a sign-in worked when it did not — that would mark an account
as connected when it never signed in, and leave you holding a dead code with no new one coming. Three
things keep that from happening:

- **The credential has to be newer than the sign-in attempt.** If you are re-connecting a slot that
  still holds the previous account's credential, an old file does not count as this attempt
  succeeding.
- **Only the Codex-style sign-in is checked this way.** Claude's kind is left completely alone,
  because a Claude folder's credential file gets rewritten during ordinary token refresh, and we did
  not want a routine refresh mistaken for someone finishing a sign-in.
- **Every uncertainty means "not finished".** Cannot read the folder, no credential there, the check
  itself errors, the timestamps do not make sense — all of those fall back to exactly the old
  behaviour of issuing a fresh code. The new check can only ever *prevent* instar from throwing away
  a sign-in that worked; it can never leave you stranded on a dead code.

## What is honestly still not covered

- It confirms that *a* credential appeared, not *whose*. If you happened to sign in to a different
  Codex account by hand in the same folder while an instar sign-in was pending, instar would credit
  its own attempt. The account genuinely works and the pool entry points at a real credential, so the
  outcome is harmless, but the record is not strictly accurate.
- One error message still says "start a fresh sign-in" in a case where the sign-in has in fact
  already finished. Slightly off, shared with a case where it is correct, and left alone rather than
  reworded blind.

## What you actually need to decide

Nothing, to take the fix — it is a straight bug fix with no new settings and no new behaviour to opt
into. Reverting it is a plain revert, but is worth pairing with turning Codex enrolment off, because
going back also brings back the behaviour that signs you out of your real Codex account.

The one thing worth your attention: if you have a Codex account that was enrolled *before* this fix,
its credential may not be where the pool record claims. Worth checking rather than assuming.
