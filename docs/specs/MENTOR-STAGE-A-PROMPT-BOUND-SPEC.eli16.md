# In plain English: stop the mentor's message from getting too long to send

## What this is about

The mentor coaches another agent (Codey). Each cycle it does "Stage-A": it spins
up a tiny throwaway AI session to write the next coaching message. To start that
session, the code runs a `tmux` command, and it passes the ENTIRE prompt — which
includes the whole conversation history so far — as part of that command.

## What went wrong

`tmux` (the tool that manages those sessions) has a limit on how long a single
command can be — about 12 to 16 thousand characters. Early in the mentorship the
conversation was short, so the prompt fit and everything worked. But every cycle,
the conversation got longer, and the prompt grew with it. Eventually the prompt
got bigger than tmux allows, and tmux refused to start the session with the error
"command too long." That made the whole step fail — the mentee got nothing.

(We only KNEW this was the cause because the previous fix made the mentor report
its real error instead of a vague "stage-a-failed." This is that fix's payoff.)

## What's new

The code now caps how much conversation history it stuffs into the prompt. It
keeps the most-recent ~6,000 characters of the conversation (the recent back-and-
forth is what matters for "what should the mentee do next?") and replaces the
older middle with a short note saying how much was left out. The agenda and the
current task status are kept in full.

The result: the prompt now stays safely under tmux's limit, so the session always
starts — no matter how long the mentorship runs. Older history is summarized-away
on purpose, not lost by accident.

## What the reader needs to decide

Nothing to configure. This makes the mentor's Stage-A step reliable for the long
haul. A test proves that even an 80,000-character history produces a prompt under
12,000 characters that still keeps the most-recent exchange and marks what was
elided — and a cold test of tmux confirms the cap is safely below its real limit.
Combined with the previous fix (which now reports the true cause of any failure),
the mentor's Stage-A step is both reliable and debuggable.
