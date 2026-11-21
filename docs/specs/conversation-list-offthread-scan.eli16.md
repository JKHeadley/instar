# Reading the message history without freezing the server: plain-English overview

## What was wrong

Every agent keeps one long file with its Telegram message history. When the phone or Mac app
opened its conversation list, the server looked up each conversation's newest message. For any
conversation it had not looked at since it started, it read that whole file from top to bottom.
While it reads, the server can do nothing else. On Echo the file is about 31 MB, and the list asked
about more than 200 conversations, so the server sat frozen for about 20 seconds. Nobody's
messages, buttons or other requests got an answer in that time.

## What already exists

The server already keeps a small memory of each conversation's newest 500 messages, once it has
read that conversation. After the first read it stays current by itself. The freeze came only from
filling that memory the first time, conversation by conversation, with a full blocking read each.

## What is new

When the list (or a chat opened before any list, say from a notification) needs conversations that
are not in that memory yet, the server reads the file once for all of them, in small pieces. Between
pieces it goes back to answering everything else. There is no separate helper thread doing this
work: the server's one thread still does the reading and checking, one 64 KiB piece at a time, and
what changes is that it pauses between pieces instead of holding everything up until the end. When
it reaches the end it checks the file is
still the same file with the same contents, and only then fills the same memory it already had.
The list then runs exactly as before. It finds what it needs already in memory, so it never does
the slow read.

Nothing new is stored. There is no second copy of the history that could drift out of step with
the file. The only change is when and how the first read happens.

## The safeguards, in plain terms

- **Same answers.** The new read uses the same rules as the old one for what counts as a message
  and which conversation it belongs to. Tests and a run on a copy of Echo's real history compared
  the two and found no differences.
- **Never half-saved.** If the file can't be read, is replaced (the trim does that), or is
  rewritten while being read, even with the same length, nothing is saved. The old read then runs
  as it always did. A re-read with a fingerprint check catches the same-length rewrite.
- **One read at a time.** If several requests arrive together, they all wait for the same read. A
  request whose conversations are already in memory never waits at all.
- **Unread stays on the safe side.** When the server is in doubt, a message counts as unread: a
  reply shown unread when it was read is harmless, one hidden as read is not. A phone seen before the
  server has finished syncing read positions with its other machines keeps the time it arrived, so
  replies after that time still show as unread. That time is only used to show more messages as unread, never saved as a read position, and only conversations with something newer than it are looked at.
- **Still in step with the rest of the server.** A conversation closed while the read runs is not
  put back, and a phone whose access to a conversation was removed while it waited is refused, just
  as the old code would have refused it.
- **Trims and half-written lines.** If the history file is trimmed or replaced while being read,
  the server keeps nothing from that read and uses the old read instead. If the file's last line is
  only half written, the old read handles it straight away. No request waits more than 3.5 seconds
  or for more than one read; after that the old read answers.
- **An off switch.** One setting turns the new read off without a restart or a release, and
  everything goes back to the old way.

## What it costs

A cold list or cold chat waits a fraction of a second for the read, once. On Echo's real history the
longest pause of the whole server went from about 20 seconds to under half a second. Memory use is
the same as the old code's, because the same memory is filled.

## Limits worth knowing

If another of the agent's machines asks this one for its list while this one is doing its first
read, and that read took more than 5 seconds, the other machine would show the list without this
machine's conversations that one time. The next list includes them. On today's history the read
takes well under a second, so this is not expected.

## One known limit

About once every 25,000 messages the server trims the oldest lines from the history file. After a log trim, a Telegram conversation whose every message lay in the trimmed part shows no messages in the app, exactly as the old code does after any restart; Option C adds no blank the old code would not show, and the scan never records such a conversation as empty. Those Telegram messages remain in the conversation memory database and search (every message is written there when sent or received, independently of the log; verified on the live Studio data: all of the last 400 log rows are present in memory), and the approved follow-up CMT-2127 can surface them in the app. Native app conversations are stored separately and are not touched by the Telegram log trim.

## What the reader needs to decide

Nothing beyond the Chief of Staff's choice of this design over the memory-copy design (pull request
3602, which stays a draft). Turning it off, if ever needed, is one setting.
