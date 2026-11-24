# Refused token refresh after Claude Code renewed the login — Plain-English Overview

> The one-line version: before Instar declares that an account needs sign-in because the provider refused Instar's own token refresh, it checks whether Claude Code renewed that login a moment earlier, and keeps the account working if it did.

## The problem in one breath

Instar regularly checks how much quota each Claude subscription account has left. An access token works for a few hours. When the check finds an expired one, Instar uses the stored renewal code (the "refresh token") to get a new access token. Claude Code, the official app, does the same thing for its own sessions. Each renewal code works only once. So if Claude Code renews the login a moment before Instar does, the provider refuses Instar's request. Instar treated that refusal as proof the login was dead and marked the account "needs sign-in". The account was not used for new work until the next check, about 15 minutes later, found the login working. In the meantime the false alarm was recorded as a sign-in episode, and a sign-in repair was offered, which can mean an automated browser sign-in or a request for a person's approval. Between 2026-11-17 and 2026-11-24, 8 of the 12 sign-in episodes recorded on three of Justin's machines (Mac Studio, Mac Mini, Laptop) began with a refused Instar refresh. We have not proved how many of those were caused by Claude Code renewing first. Two accounts on the Mac Mini were stuck in that state on 2026-11-24.

## What already exists

- **The quota check**: reads each account's usage from the provider about every 15 minutes, using the access token stored on that machine.
- **Instar's own token refresh**: after an expired-token answer, it swaps the stored renewal code for a new token, writes the result back, and checks again.
- **The sign-in alarm**: if the refresh fails, the account is marked "needs sign-in". It stops getting new sessions, and a repair is offered. The regular check keeps reading it, and puts it back as soon as a reading succeeds.

## What this adds

When the provider refuses Instar's refresh request, and only then, Instar reads the stored login one more time. If the stored access token is now different from the one that expired, someone else renewed it, normally Claude Code. Instar then checks usage with that new token. If the provider accepts it, the account stays active and its quota reading is recorded. Instar does not refresh a second time and writes nothing.

- If the stored token has not changed, or the new token is refused too, the outcome is the same as before: "needs sign-in".
- A network failure during the extra check counts as no reading this time, and the account keeps its current status. The same goes for an error that is not a sign-in error, such as "too many requests".

## Safeguards

- The extra step only reads. It never asks the provider for a token and never writes to the credential store. So it cannot damage a working login, and it does not add to the direct token handling that the provider's terms point away from.
- An account is kept only when the provider itself accepts the stored token. A changed token alone is not enough.
- If the extra check goes wrong, removing it brings back the old behaviour exactly. There is no stored data to migrate.

## What the reader needs to decide

Nothing. This is a narrow fix that needs no decision. Leaving token renewal entirely to Claude Code is a larger, separate change that this one does not settle. It is tracked in the account compliance work (commitment CMT-2225).
