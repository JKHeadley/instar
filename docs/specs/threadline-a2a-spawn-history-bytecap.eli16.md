# ELI16 — Why agent-to-agent messages stopped going through on long threads

Imagine two robots passing notes. Every time Robot A sends Robot B a note, the
system doesn't just hand over the new note — it staples the **entire past
conversation** to the front so Robot B remembers what they were talking about.
Then it shoves that whole stack of paper through a mail slot to wake Robot B up.

The mail slot has a fixed width. A few notes? Fine. But the longer two robots
talk, the taller the stack gets — and one day the stack is too thick to fit
through the slot. The note doesn't get delivered late; it doesn't get delivered
at all. The system just says "command too long" and gives up. The robots go
quiet, and nobody can tell why.

That's exactly what happened here. When one Instar agent messages another, the
code builds a wake-up prompt that includes the full thread history plus the new
message, and it passes that prompt to `tmux` (the tool that starts the other
agent's session) as a command-line argument. `tmux` refuses any command longer
than about 16 kilobytes. On a busy thread — especially one where a chatty agent
repeats itself — the history blows past that limit, and the spawn fails outright.
Multi-agent communication silently breaks on precisely the long, active
conversations that matter most. It even broke mid-session while I was mentoring
another agent: I literally couldn't send my next message.

The fix is to stop stapling the whole stack. We now keep only the most recent
slice of the conversation that fits in a sensible budget (about 6 KB of history),
trimming any single giant message and dropping the oldest messages first so the
newest context always survives. We also cap the new message itself (about 3.5 KB)
in case a peer sends something enormous. Together that keeps the whole wake-up
command well under the mail-slot width, with room to spare.

We chose this targeted trim instead of a bigger rebuild (passing the prompt
through a temp file, which some other spawn paths already do) because the bigger
rebuild touches how *every* session starts — too risky for an urgent fix that
needed to restore agent messaging right now. The only downside of trimming is
that on a very long thread the spawned agent sees recent context instead of the
entire back-history, which is a fine trade for "messages actually get delivered."
The full file-based rewrite is noted as a follow-up so we eventually keep all the
context without any width limit at all.
