# Usage-wall rescue on the current Claude Code screen — Plain-English Overview

> The one-line version: the agent now notices when a conversation has run out of its account's weekly or session allowance, even on Claude Code's newest screen layout, and it stops putting off a pre-emptive move forever when the account is about to run out.

## The problem in one breath

On 2026-11-10 one of the operator's conversations stopped at "You've hit your weekly limit" and stayed stuck, although seven other accounts had room. Instar has a rescue that moves a stuck conversation to an account with room, and it is on by default. It never started, because the part that reads the screen did not recognise the new rows Claude Code now draws under the limit message. Separately, the earlier "move it before it hits the limit" step kept waiting for the conversation to finish its work. Background commands kept the conversation looking busy all night, so the wait never ended.

## What already exists

- **The wall rescue** moves a conversation that has hit its account's limit to another account with room, after checking the account's own usage reading.
- **The screen watcher** looks at each conversation's terminal every half minute. When the limit message is the last real thing on screen and the screen has stopped changing, it tells the rescue.
- **The pre-emptive mover** moves a conversation off an account at about 80% use, before the limit. When the conversation is in the middle of work, it waits, for up to 30 minutes, and then gives up and lets the rescue deal with the limit.
- **The conversation's own record** (its transcript file) stores the limit message as a structured error entry.

## What this adds

The screen watcher now reads the conversation's own record when the screen shows a limit message it cannot fully make sense of. If the record's latest entry is the account's limit error, and not the short "servers are busy" error that uses the same code, the wall counts. The screen still has to show the limit message, so a stale record alone never triggers a move.

Also:

- The watcher recognises every new row Claude Code draws under the limit message: the new "/usage-credits" wording, a discount offer, the "finished, 7 shells still running" line, the update notice, the busy-shells status line and the list of background helpers with their running timers. Each pattern matches only the whole row, so ordinary text that happens to use the same words still counts as the conversation working.
- A side panel (the diff view on the right of the screen) is cut off before reading.
- Timers that tick every second under the limit message no longer stop the screen from counting as settled.
- The pre-emptive mover remembers how long a conversation has been busy, even across its 30-minute give-up. Once the conversation has been busy a full 30 minutes and its account is at 95% or more, it moves the conversation the same way the rescue does at the limit: it gives the work two minutes to finish, then moves it and tells the new session what was interrupted.

## The safeguards

**No false moves from look-alike text.** Every new screen pattern is tested against similar ordinary sentences, which must still count as work.

**A limit is still checked before anything moves.** The rescue still confirms the account is really out of room before moving a conversation.

**The earlier move is bounded.** It happens at most once per busy stretch, only at 95% or more, only after the conversation has looked busy at every check for 30 minutes (any idle check starts the count again), and only after all the existing anti-thrash checks agree. If it fails, the old behaviour (give up and leave it to the rescue) applies. Setting the threshold above 100 turns it off.

## What ships when

Everything ships together in one pull request. There is no data migration. Undoing it is a revert.

Transcript lookup follow-up: no reader-facing change.
