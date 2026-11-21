# Main-loop freezes from the conversation list — Plain-English Overview

> The one-line version: the phone and Mac app's conversation list made the agent's server re-read its whole Telegram message history once per conversation, freezing it for 20-30 seconds; now one background read keeps a memory copy, and the list answers from that.

## The problem in one breath

An instar agent's server does all its work on one thread, so anything slow on that thread makes everything else wait. On 21 November 2026 Echo's main computer (the Studio) froze for 20 to 30 seconds at a time, four times in one hour. While frozen it missed the check-ins that keep it in charge of the other machines, and the queue that merges code changes stopped. A recording of where the server spent its time during one freeze showed the biggest cost was the conversation list in the phone and Mac apps.

## What already exists

- **The Telegram message log** — one file on disk holding up to 75,000 recent messages (about 20 MB). It is the record of every Telegram conversation.
- **A short per-conversation memory of recent messages** — kept in the server's memory so repeated reads are cheap. It is filled in one pass for conversations that have a running session, and dropped when a conversation's session closes, so memory stays bounded.
- **The searchable message database (TopicMemory)** — a second copy of every message in an indexed database, used for search and summaries.
- **The conversation list** — what the phone and Mac app show: one row per conversation, with its latest message as a preview and its time for sorting. The apps ask for it often.

## What was going wrong

For each conversation in the list, the server asked "what is this conversation's latest message?" For a conversation with no running session, the short memory did not have it, so the server read and parsed the entire 20 MB file to find it. Echo has hundreds of such conversations, so one list request could read the whole file hundreds of times in a row, all on the single thread. Closing a session made it worse, because closing drops that conversation from the short memory, so it cost a full read again next time.

## What this adds

The server now keeps a copy in memory of what that slow file read would have returned: the newest 500 messages of each conversation, exactly as stored in the file. It builds this once in the background, in small pieces, and updates it with every saved message. Everything above that step works as it did, so previews, order and unread counts should not change, and a comparison of old and new servers on identical data checks that.

The phone and Mac wait briefly for that first background read. If it cannot finish within 15 seconds (four seconds when another of the agent's machines is asking), or if rebuilding it fails, the request is simply answered the old way, from the file, so the app sees exactly what it saw before.

Two earlier versions of this fix were thrown away after outside review found they could change what the apps show.

Trimming the file (which happens once the file holds 100,000 messages) is left exactly as it was, so it cannot delete anything it did not delete before; the memory copy is simply rebuilt after each trim. Earlier versions of this change tried to make the check before each save cheaper, and each one could, in some failure case, delete a message the old code would have kept. A test now saves messages through both of the server's save routes into a file built just over 20 MB, injects failures, and checks after every save that the file is byte-for-byte what the old code would have written. The old check costs under a tenth of a second per saved message on Echo's real file, which is well within the goal, so it stays.

Two start-up improvements that were part of this change (the code map and the Node check) now have their own pull request, so this one covers only the conversation list, chat history and saving messages.

There is also an off switch: one setting (`telegramHistoryView.enabled` set to false) puts every read back on the old path without a code change.

## The safeguards

- Nothing is decided or blocked differently. This change only makes existing reads cheaper and moves start-up work off the single thread.
- A message saved during the background read appears once. When old messages are trimmed from the file, the memory copy is dropped and rebuilt, so it never shows a message the file no longer holds.
- If the background read fails, nothing partial is kept and requests are answered the old way, from the file. The server tries the background read again after a growing pause (five seconds, doubling, at most five minutes), not on every request.
- Other parts of the server that use the old way of reading history behave exactly as before.
- Tests cover the old failure: the list used to read the file once per conversation and now reads it zero times on the main thread. Others inject failures (a trim during loading, a save that half-fails, a trim that fails and succeeds later, another machine still loading) and check that nothing is lost, hidden or duplicated.

## What is not in this change

Two smaller slow spots are queued separately rather than folded in: a few session checks that wait on the terminal multiplexer (tmux) on the main thread, and about fifteen single-conversation lookups that ask for more history than the short memory holds (1,000 messages) and so read the whole file each time. Neither showed up as a cause of these freezes; both are recorded with the evidence in the feedback queue (fb-9193b40c-880).

## What you need to decide

Nothing. This is a performance repair with no settings, no new behavior to approve, and a clean undo: reverting the change restores the old behavior exactly.
