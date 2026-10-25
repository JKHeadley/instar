# Why two working accounts kept saying "sign in again" — plain English

## What the operator saw

Four machines, eight subscription accounts. Every time he looked, a handful of them
were showing "this account needs signing in again" on the dashboard. Each one costs
about fifteen taps to clear: click sign in, pick the Google account, close the tab
that cancels the flow, click sign in again, authorize, copy the code, paste it,
submit. Doing that on repeat, forever, is what prompted "this is getting exhausting."

## What was actually happening

Two of the six Claude accounts on this machine had been flagged "needs owner
sign-in" since Monday morning. I checked them directly. Both logins were **present,
valid, unexpired, with working refresh tokens, on Max subscriptions**. When I asked
the system's own identity check about them, both answered instantly and correctly.

They did not need signing in. They never did.

## The bug

To work out which account a stored login belongs to, the system asks Anthropic
"whose login is this?", gets an email back, and then looks that email up in the list
of subscription accounts. It insists on finding **exactly one** match — sensibly, because
this answer is used to decide whether to physically move credentials between folders,
and guessing there would be genuinely dangerous.

But the lookup searched the *whole* account list — Claude accounts and Codex accounts
together.

The operator uses the same Google account for both kinds of subscription. One Gmail
address backs a Claude subscription *and* a Codex subscription. So the lookup found
two rows, concluded the answer was ambiguous, and gave up. Giving up is reported as
"identity unavailable," and further down the chain "identity unavailable" is written
into the account record as the words **missing local login**.

The correlation is exact and it is the whole story: six Claude accounts on this
machine, and the only two ever flagged are precisely the two whose Google account
also backs a Codex subscription. The other four have unique emails and have never
been flagged once.

## Why it could never fix itself

The code that would *clear* the flag once a login is healthy performs the same lookup.
It gets the same "can't tell" answer, and it is deliberately written to never change a
recorded state on an uncertain reading — which is the right instinct, and here it meant
the flag latched permanently. Signing in again did not help, because signing in was
never the problem. That is why it had been stuck since 3:29am on Monday.

There was a second, quieter symptom: an account carrying this flag is excluded from the
pool the agent draws capacity from. So two paid Max subscriptions sat unused for a day
and a half on a machine that was reporting them broken.

## The fix

Scope the lookup to Claude accounts when the question came from Anthropic's Claude
endpoint. An email issued by Anthropic's Claude service cannot possibly denote a Codex
account, so a Codex row was never a legitimate candidate and should never have been in
the comparison.

The rule that fixes this was already written down, one file over. A sibling function
that answers the very similar question "which account is this session running on" has
scoped itself to Claude accounts since the day it was written, with a comment saying
exactly why. The credential resolver simply never inherited it — it re-implemented the
lookup from scratch and left the scope out.

So rather than paste the rule into a second place and leave two copies to drift apart
again, the change lifts it into one shared, documented function that both callers use.
That is the actual repair: not the missing filter, but the fact that the filter had two
homes and only one of them knew about it.

## What deliberately did NOT change

Real ambiguity still fails closed. If two *Claude* accounts genuinely shared an email,
the resolver still refuses to guess, exactly as before — because this answer authorizes
moving credential files between folders, and a wrong guess there could put the wrong
login in the wrong place. Only the false ambiguity is gone.

An oracle that cannot answer at all — network down, no token, a rejected token — is
still treated as unavailable and still quarantines the slot. Nothing about that path
moved. The change makes a *correct* answer reachable; it does not make an *uncertain*
one acceptable.

## What this does not fix

It does not tell anyone how often sign-ins genuinely go stale. Nothing has ever
recorded a sign-in, so the real rate is still unknown, and this fix removes one
manufactured source of churn without measuring what remains. That measurement is a
separate piece of work, and it matters that it comes before any attempt to automate the
sign-in flow: a robot built to re-sign accounts on this signal would have spent its life
re-signing two accounts that were fine.

## How to check it worked

The two accounts should clear their flag on the next identity pass and return to the
usable pool without anybody signing in to anything. If they clear without a single tap,
that is the proof — the login was there the whole time.
