# Usage-wall rescue, in plain words

## What happened

Each Claude subscription has a usage allowance. When a session uses it up, Claude Code stops and prints "Usage limit reached · limit resets 8am". On 4 November two of our Telegram conversations hit that wall on an account that was at 100% for the week. The agent had two other accounts with plenty of room (10% and 47% used), and it already knows how to move a conversation to another account and carry on. It just never did. The conversations sat stuck for hours, and the person on the other end was not told anything useful.

## Why

Four separate gaps lined up:

1. The watchdog that looks for stuck sessions only knew about short server hiccups ("temporarily limiting requests"). A real usage wall was, on purpose, "not a hiccup", so nothing raised a hand.
2. The account-move only worked for sessions that were labelled with the account they run on. By default sessions were not labelled, so even a raised hand would have been ignored.
3. The standby messages that tell the person what is going on check whether the wall is still the last thing on screen. The newest Claude Code prints two extra lines under the wall message (an "it will continue automatically at 8am" line and a status bar). The check counted those as new work and decided the session had recovered.
4. New sessions could still start on an account the agent already knew was full.

## What changes

- The watchdog now has a separate "usage wall" signal. It fires only when the wall message is the last real thing on screen and the screen has stopped changing for a short while, so a passing glance never triggers it.
- When that signal fires, the agent works out which account the session is really on (its label, or the login it was started with), and asks the existing account-move machinery to resume the conversation on an account with room. The conversation continues where it left off.
- New sessions get labelled with a good account when they start, so they are never invisible to the move logic again.
- The standby message understands the new screen layout. It only says "being moved, nothing to do" when a move will really happen. If no account has room, the conversation gets one plain message saying every account is at its limit and the session will carry on when the limit resets.
- A new session never starts on an account the agent knows is full.

## Safeguards

- One switch controls all of it: `subscriptionPool.wallRescue.enabled`. It is on by default (Justin approved this on 4 November 2026), but it only does anything when the agent has at least two working accounts of the same kind. An agent with one account or none behaves exactly as before.
- If an operator has already turned this off (or turned off automatic swapping), that choice is kept on update.
- Before moving anything, the agent double-checks the wall against the account's own usage reading. If a recent reading says the account still has room, it does not move the session. If the limit resets within 15 minutes, it waits instead of restarting.
- A session is moved at most once at a time. After any attempt the agent waits at least ten minutes before trying again, and the wait doubles each time a move fails. After five failed moves it stops for a day and tells the person in the conversation. One machine attempts at most twelve moves an hour.
- Accounts that need signing in again are never chosen as a destination, and a new session is only placed on an account the agent has read successfully in the last hour.
- Nothing moves before the wall: the earlier rule that the agent never shuffles an unlabelled conversation pre-emptively still holds.
- There is a status page (`GET /subscription-pool/wall-rescue`) showing whether the rescue is active, how many accounts qualify and what happened recently.

## What you need to decide

Nothing new. The default-on choice was already approved. To turn the whole thing off on any agent, set `subscriptionPool.wallRescue.enabled` to `false`; it takes effect without a restart.
