# Job sessions load a short instruction file — ELI16 overview

The agent runs lots of small scheduled jobs. One checks for new commitments every 15 minutes, and others run hourly or daily. Each job starts a fresh AI session, and before that session does anything it reads the agent's full instruction file and its memory index. The instruction file is long, about 105 thousand characters. It's written for conversations with a person: how to reply on Telegram, how to word messages, a long list of traps to avoid, and a catalogue of every feature. A job that just checks for commitments needs almost none of that, but it pays for all of it every run.

We measured it. A tiny job run reads about 80 thousand tokens before doing any work. Telling the session to skip the long instruction files and the memory index, and giving it a short job file instead, cuts that to about 30 thousand. That's roughly 60 percent less on every job run.

This change gives jobs their own short set of instructions, about 6 thousand characters, created fresh each time a job starts. It covers the basics a job needs: how to call the agent's own server, never to run commands that wait for typing, how to report problems, how to message the person if the job is supposed to, and where the full instructions are if a job ever needs them. Job sessions load this short file instead of the long one. Conversations with a person don't change at all.

Only jobs shipped with Instar, whose instructions have been checked, switch over by default. A custom job keeps everything until someone opts it in, and any job can be switched back with one setting. After the first run the agent also checks what the session actually loaded, and goes back to the full instructions if the skip didn't work. If the short version ever fails to build, the job falls back to the full instructions and the agent reports it, so a job never runs without its rules. The safety guards that block dangerous commands are separate from the instruction file and keep running either way.

## What changed after review (2026-11-22)

The independent review of the finished code asked for several extra safeguards, and all are now in. The check that
proves transcripts really show which files loaded now also counts tokens: if the long files had secretly loaded, the
session would have read thousands more tokens, and the check refuses to trust it. That check was run for real on this
machine's Claude Code and passed. A job that cannot be started, whose version cannot be read, or whose check keeps
coming back unclear goes back to its full instructions rather than staying on the short ones. Moving a job between
folders keeps exactly the instruction choice it had before. And agents are now told to compare a job both ways, full
and short, before switching it, because the short version turns off auto-memory and only messages the person when the
job prompt says to.
