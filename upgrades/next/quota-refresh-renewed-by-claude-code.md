# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

When a subscription account's usage check finds an expired access token, Instar asks the provider for a fresh one. If Claude Code renewed the same login a moment earlier, the provider refuses Instar's request, because the renewal code Instar sent was already used. Instar used to mark the account "needs sign-in" at that point. The account then dropped out of use until the next usage check, about 15 minutes later. Meanwhile a sign-in episode was recorded and a sign-in repair was offered for a login that was working.

Now, when the provider refuses the request, Instar reads the stored login once more. If the stored token has changed and the usage check accepts it, the account stays active and nobody is asked to sign in. In every other case Instar makes the same decision as before. The extra check only reads: it never asks the provider for a token and never writes to the credential store.

## What to Tell Your User

"Fewer false 'please sign in again' alerts. When Claude Code had already renewed an account's login itself, I now notice that and leave the account working instead of asking you to sign in."

## Summary of New Capabilities

Subscription accounts that Claude Code renewed itself no longer get stuck as needing sign-in.

## Evidence

The new unit tests in quota-poller-renewed-by-official-app cover both sides of the decision. A renewed token the usage check accepts recovers the account. Cases that keep "needs sign-in": the same token, a renewed token that is also refused, and a failure that was not a refused request. Cases where the account keeps its current status: a network error, and a non-sign-in error (429) on the renewed token. The tests fail on the previous code. The existing quota-poller unit tests, the subscription-quota and interactive-login-expired integration tests, and the login-expired end-to-end lifecycle test pass unchanged.
