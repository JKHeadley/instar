# Running out of Claude usage no longer goes quiet

> The one-line version: when an agent runs out of Claude usage and no other account can take over, the operator is told, the person waiting is told, and waiting conversations pick up by themselves when usage returns.

## The problem

On 4 November a test agent ran out of its weekly usage. A person's message got "actively working", then nothing. The person who ran the agent got no word, the health page said all was well, and nothing would have answered the message after the reset, even though the notices said the conversation would carry on.

## What already exists

- **Two earlier fixes** let the standby recognise the weekly-limit message and check it against the session's own record, so a person with a live session is told.
- **The account rescue** moves a conversation to another account with room. It only works with two or more accounts.
- **The sign-in key monitor** tells the operator about a dead key and restarts stuck conversations. A limit is not a dead key, so it stays quiet.

## What this adds

A small watcher takes the case the rescue can't: one account, or no account with room. It opens when a session's own record shows it was refused for usage, or when a background call is refused and a test call confirms it. Then:

- The operator is told once, with the reset time and how to add capacity.
- A person who messages is told straight away, in place of "actively working".
- The health page shows `claudeUsage`.
- It tests whether usage is back at growing intervals, up to every 30 minutes, and at once if the key changes. A fresh reading of an account with room also ends it.
- When usage returns, each conversation with unanswered messages restarts with those messages quoted, and the agent checks a real reply appears. If none does in 15 minutes, the person is asked to send it again. A conversation with nothing waiting is left alone. The operator gets an all-clear.

## The safeguards

- The words alone never count: a session that prints the limit text doesn't trigger it. A session on a server throttle doesn't either, since the wording differs.
- It stands aside while any usable account isn't known to be full, so nobody is told their conversation can't reply when that isn't true. Conversations on Codex or another framework hear nothing about it.
- A session that picked up by itself is never restarted.
- One conversation gets at most 3 restart attempts a day, then the person is asked to resend and it's reported. An old message on the screen can't cause repeat alarms: there's a one-hour cooldown, and at most one operator notice in six hours.
- It stores session names and times, never keys or message text.

## What this does not do

Scheduled jobs still start during the limit and fail in seconds. That wastes little, since they are refused, and the job record marking them successful is already filed separately. The test call uses the fast model, so a limit on one model alone reads as back too soon; the session hits it again and the caps above bound that. The exact error text a background call returns is taken from field notes, and the live run on a cloud test agent will confirm it.
