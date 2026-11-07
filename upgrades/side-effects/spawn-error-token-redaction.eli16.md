# Failed session starts stop leaking tokens — Plain-English Overview

> The one-line version: when a new session failed to start, the error message included the GitHub token we had just handed to it, and now it doesn't.

## The problem in one breath

To start a session, Instar runs tmux and passes it the session's credentials (its GitHub token, its Instar API token, sometimes a model API key) as part of the command. If tmux refuses, Node builds an error message that repeats the whole command word for word. Instar passed that message straight back to whoever asked for the session, so the reply could contain a working GitHub token in plain text.

## What already exists

- **A cleanup step on the error** — every place that starts a tmux session already ran the error through one small function before throwing it. That function only removed one kind of internal token, so GitHub and API tokens got through.
- **A shared secret scrubber** — Instar already has a function that recognises common token shapes (GitHub tokens, provider keys, Slack and Telegram tokens). It was not used here.

## What this adds

The cleanup step now throws away the line that repeats the command, because that line is where the credentials live. What is left is the part that actually explains the failure: tmux's exit code and its own short complaint, such as "duplicate session". That remainder is also run through the shared scrubber and through a rule that blanks out any `NAME=value` pair, and it is cut off at 500 characters. The two web endpoints that start or restart sessions apply the same cleanup again before replying, as a second line of defence.

## The safeguards

**The command line is removed, not just filtered.** Some GitHub tokens (the newer fine-grained ones) are not recognised by the shared scrubber. Removing the whole line means a token of any shape cannot slip through it.

**The reason for the failure is kept.** An operator still sees why tmux refused, so the fix does not make failures harder to diagnose.

**Proved against the old code.** The new test starts a session with a fake GitHub token and makes tmux fail. On the old code the test fails because the token is in the error. On the new code it passes, and the existing 53 spawn tests still pass.

## What this does not change

Sessions still receive their credentials through the tmux command, as before. Whether a session starts, retries or is refused is unchanged. Only the wording of the error changes.

## What to do

Nothing for most people. If you have seen a session-start error that contained a token, treat that token as exposed and rotate it.
