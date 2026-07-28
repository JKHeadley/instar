# CommitmentSentinel bare-continuation guard — plain English

## The problem
The agent has a watcher that tries to notice when it has made a promise it should
follow through on ("I'll report back when X"). But it was too eager: it treated
almost every message you sent — even a plain "yes" or "please proceed" — as if it
created a promise to track. The result was a registry full of fake "commitments"
(36 of them showed as broken), which is exactly why it got hard to tell what was
actually open.

## The fix
Before the watcher even considers an exchange, a simple deterministic check drops
the ones where your message was just an approval or a "keep going" — those ask for
nothing durable, so they can't be a promise. Real requests are untouched: anything
with an action word ("deploy", "set", "restart", "turn off") still goes through, so
"go ahead and deploy the latest" is correctly kept.

## How safe is it?
Very. The watcher only *detects* promises — it never deletes or changes one. The
worst case is missing a promise from a one-word message with no verb (almost never),
which is the safe direction. Explicitly opening a commitment via the API still works
exactly as before. 50 tests cover both sides (drops the bare ones, keeps the real
requests).

## What you need to decide
Nothing — it just makes the commitment registry trustworthy again.
