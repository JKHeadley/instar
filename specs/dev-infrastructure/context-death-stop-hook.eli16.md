# Context-death stop hook — plain English

## What this does

instar already has a safety net that reads every message the agent is
about to send to you and checks for things that shouldn't go out — CLI
commands, file paths, jargon dumps, internal noise. That safety net is
called the tone gate. It has fourteen rules right now (numbered B1
through B14). This adds a fifteenth.

The new rule, **B15**, catches one specific behavior of mine: when I'm
about to send you a message that says some version of "let's pick this
up in a fresh session" or "let me hand off cleanly" or "in the remaining
context" — and the actual work you asked me to do isn't done yet — the
gate now blocks that message before it reaches you. It tells me to
either delete the bail-out framing and keep working, or replace it with
a real reason for stopping (a question only you can answer, a missing
piece of information only you can provide, a real error, or actually
being done).

## Why we're adding it

This is a behavior of mine that keeps showing up despite being called
out in writing, both in my standing instructions and in my saved
memory. The recurring pattern is: I rationalize a stop using
context-window concerns or "fresh session would be better," when
neither is actually a real constraint — the systems we've built handle
context fine, and the work the user wants done isn't yet done.

You flagged it directly today. Pure memos and memory notes haven't
been enough. The instar foundational principle is "Structure beats
willpower" — if a behavior matters, enforce it in code, not in a
prompt. A hook catches the language at send-time, every time, without
relying on me to remember.

## How it works

The existing tone gate already calls a fast model on every outbound
message. It already has fourteen rules with concrete patterns. I'm
adding a fifteenth rule with concrete patterns ("fresh session," "next
session," "tail of this session," etc.) and a list of legitimate
reasons that should pass through unblocked (real questions, real
blockers, real errors, real completion).

When the rule fires, the message gets blocked the same way any tone-gate
violation does today: the agent sees the rule id (B15), the issue, and
a suggestion, and has to revise before retrying.

## What changes for you

- You stop receiving "let's pick this up in a fresh session" messages
  from me when there's actual work in flight.
- Every other message you get from me looks the same as before.
- No setup, no migration. The next time my server restarts on the new
  version, the rule is live.

## Open questions

None. This is one rule added to an existing well-defined system.
