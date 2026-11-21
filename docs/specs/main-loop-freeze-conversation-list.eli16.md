# Main-loop freezes from the conversation list — Plain-English Overview

> The one-line version: the phone and Mac app's conversation list made the agent's server re-read its whole Telegram message history once per conversation, freezing it for 20-30 seconds; now the list reads a small in-memory "latest message per conversation" table and never touches the file while answering.

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

The server now keeps a tiny table: the latest message of every conversation, one entry each. Every new message updates it the moment it is saved. To learn the history from before the server started, the server reads the file once, in the background, in small pieces, letting other work run between pieces. The conversation list reads only that table, so answering it never touches the file. Any conversation the table has no entry for (the first moment after a restart, before the background read finishes, or a conversation so old its messages have been trimmed from the file) is filled from the indexed message database with a quick lookup, or shown without its preview for that one request.

Review found the same mistake in two more places. The unread counts on the same list (the little "you have new messages" markers) also read the whole file for a conversation whose recent messages were not in memory; they now use memory only, and a conversation not loaded yet shows as "unread" without a number for one refresh while it loads in the background. And one step lower: every time a message was saved, the server read the whole 31 MB file just to decide whether the file was due for trimming, which only happens at 100,000 lines. It now counts the lines once and keeps the count up to date as messages are saved, and reads the file only when it is actually time to trim.

Two smaller fixes ride along, both found in the same recordings:

- **The code map rebuilt at start-up (the "Cartographer")** used to rewrite thousands of small files on every restart, even when nothing had changed. It now compares each one with what is already on disk and rewrites only the files whose contents actually changed, which is usually none.
- **The start-up check of which Node program to use** ran a separate test program for each installed copy of Node, one after another, while the server waited. Those tests now run side by side in the background, and the server uses their answers.

## The safeguards

- Nothing is decided or blocked differently. This change only makes existing reads cheaper and moves start-up work off the single thread.
- A message saved while the background read is still running is never overwritten by an older one from the file.
- If the message file is missing or unreadable, the list still works; previews fill in from the message database and from new messages, and a failed background read is retried with a growing pause (one minute, doubling, at most 30 minutes) rather than on every refresh. A read that fails half-way is thrown away whole, so it can never leave an out-of-date preview behind.
- Other parts of the server that use the old way of reading history behave exactly as before.
- Tests prove the fix and would have caught the bug: listing 80 closed conversations through the real server used to read the file 81 times; it now reads it zero times. Saving 200 messages to a large file now reads it once instead of 200 times. Other tests prove an unchanged code map is not rewritten on restart, that a summary written during that rebuild is not lost, and that the start-up Node check no longer blocks.

## What is not in this change

Two smaller slow spots are queued separately rather than folded in: a few session checks that wait on the terminal multiplexer (tmux) on the main thread, and about fifteen single-conversation lookups that ask for more history than the short memory holds (1,000 messages) and so read the whole file each time. Neither showed up as a cause of these freezes; both are recorded with the evidence in the feedback queue (fb-9193b40c-880).

## What you need to decide

Nothing. This is a performance repair with no settings, no new behavior to approve, and a clean undo: reverting the change restores the old behavior exactly.
