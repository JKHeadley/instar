# The conversation list stops freezing the server — Plain-English Overview

> The one-line version: the app's conversation list now reads a memory copy of the message file instead of re-reading the whole 31 MB file once per conversation, and whenever that copy isn't ready it does exactly what it did before.

## The problem in one breath

The phone and Mac apps' conversation list asked the server, for every conversation, "what was the last message?" For conversations without a running session, the server answered by reading its entire Telegram message file from the start, once per conversation, on its only working thread. With hundreds of conversations that froze the server for 20 to 30 seconds at a time on 21 November 2026, which cost the main computer its role as leader and stopped code merges.

## What this changes

The server keeps a copy in memory of what that slow file read returns: the newest 500 messages of each conversation, exactly as stored in the file. It builds the copy once in the background, in small pieces, and keeps it up to date as messages are saved. Only the conversation list, and the unread counts it shows, read the copy, and the copy is never passed on to anything else: opening a chat always reads the server's ordinary history, never the copy. Before every use the copy checks that the file is still exactly the one it was built from (same file, same size, same last-change time); if anything else changed the file, the list reads the file the old way and the copy is rebuilt. The copy also has a size limit; past it, the old read is used.

If the copy isn't ready (still building, a failed build, or the off switch), the list does exactly what it did before, straight away. Nothing ever waits for the copy, so every way this can go wrong behaves exactly like the old code.

When old messages are trimmed from the file, the copy is thrown away and rebuilt, so it never shows something the file no longer holds. The trimming itself is unchanged, and tests check byte for byte that the file ends up exactly as the old code would leave it.

## What stays exactly as it was

Opening a chat, scrolling back to older messages, requests between the agent's own machines, the first filling of the short-term memory, and trimming the file all stay unchanged here. Those improvements are in a separate, later pull request.

## The safeguards

- One setting, `telegramHistoryView.enabled` set to false, puts the list back on the old read without a code change.
- A save that fails part-way, or that lands on a half-written last line, throws the copy away and rebuilds it from the file.
- Tests compare the copy's answers with a real read of the file, and the trimmed file with a replay of the old trimming code.

## What you need to decide

Nothing beyond the normal review; the operator decides when it goes to the merge line.
