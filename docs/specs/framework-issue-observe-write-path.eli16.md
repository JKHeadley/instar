# Explain it like I'm 16: the framework-issue write path

## The setup

Instar is learning to run on AI coding tools other than Claude — first "Codex," later
others like Cursor or Gemini. Every time we plug a new tool in, we hit little
incompatibilities (Instar assumed Claude did something a certain way, and the new tool
doesn't). Those discoveries are gold: if we write them down, onboarding the NEXT tool is
way faster because we already know the traps.

So Instar has a notebook for this called the "framework issue ledger." Each entry gets a
tag: is this a limit of the tool itself, a gap in how Instar integrated it, or just a
mistake the AI made? Two of those tags ("tool limit" and "Instar gap") are the ones that
generalize, so they get fed into a "playbook" that the next tool's onboarding reads.

## The problem

The notebook only had one way to get written in: an automated checker that watches a live
mentoring session and jots down what it trips over. That's useful, but it misses the big
stuff. When a human engineer (me, Echo) goes digging through the code, finds a real
incompatibility, and fixes it — that discovery never made it into the notebook. So the
notebook was full of small notes about the checker's own hiccups, and empty of the deep
lessons that actually matter for the next tool. We literally checked: the "tool limit"
tag had zero entries, even though we'd fixed a bunch of real tool-limit problems.

## The fix

We added a simple "write a note" button: a web request you send to the agent that says
"here's an issue I found — here's its tag, how bad it is, a title, and a stable id so we
don't write it twice." If the issue is already fixed, you can say so in the same note. The
agent checks the tag is one of the allowed ones (and says "no" politely if not), then files
it. Because each note has a stable id, you can run the same import twice and it just updates
instead of making duplicates. We also wrote a tiny script that reads a list of issues from a
file and files them all at once — that's how we backfill everything we found this session.

## Why it's safe

The notebook is read-only in spirit — it never blocks or stops anything, it's just a record.
Adding a way to write to it doesn't change that. The "write a note" button reuses the exact
same filing logic the automated checker already used, so there's no new way for bad data to
sneak in: worst case, a malformed note gets a polite error. And it's locked behind the same
password every other Instar web request uses.
