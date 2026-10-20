# ELI16: Telling the agent what day it is for *you*

## The one-sentence version

The agent already gets a time stamp on each message, but the stamp doesn't name the
weekday and it's in the computer's time zone, not yours. So the agent can still get
"today" wrong. This change stamps your day and time on every turn, and adds a check
that catches day mistakes like "today" or "Tuesday" before a message goes out.

## What went wrong

On 2026-10-20, Justin's agent kept saying "before 2:50pm today" for eleven hours,
long after 2:50pm had passed. On Monday night it also called a Tuesday deadline
"today", because it was doing its date math in UTC, the world clock that is seven
hours ahead of California. Justin asked for every Instar agent to either see the
current time or check it before every message it sends.

Two things let it happen:

1. **The stamp makes the agent work out the day.** Right now the agent sees
   something like `2026-10-20 21:40:12 -0700 (PDT)`. It has to work out for itself
   that this is Monday, and that's exactly the step it got wrong. The stamp is also
   in the computer's time zone, which is only your time zone if the computer
   happens to sit where you are.
2. **Nothing checks day words.** There is already a check that catches the agent
   misreporting *how long* a session has run. Nothing catches "today", "tomorrow",
   "Tuesday" or "before 2:50pm".

## What changes

**1. The stamp says your day, in your zone, every time.** It reads like
`Tue 2026-10-20 13:25 PDT (operator: same as machine)`. If you live somewhere other
than where the computer is, it shows your time first and the computer's second. If
the agent doesn't know your zone, it says so plainly: "machine zone, operator zone
unknown". It never passes off the computer's time as yours.

**2. Your zone comes from one place.** The agent already knows who you are for each
conversation, from your verified Telegram account. Your user record already has a
time-zone field. The stamp uses that, and nothing else. When we checked the eight
agents on Justin's computer, none had a time zone recorded for him, and four had no
user record linked to his Telegram account at all. So the spec gives a simple way to
record your zone, and until you do, it falls back honestly. When an agent runs on
several computers in different time zones, they all have to agree on *your* time. A
computer that doesn't know your zone says "unknown" rather than guessing.

**3. One piece of code formats times.** The time formatter that already exists gets
a "which zone" option. No second formatter, so the two can never disagree.

**4. A new check catches day mistakes before a message is sent.** Called DAY_CLAIM,
it looks for:
- "today", "tomorrow", "tonight" and similar words that clash with a date or
  weekday named in the same sentence ("the Tuesday deadline is today", sent on a
  Monday);
- a weekday stated as today when it isn't;
- a clock time that has already passed, talked about as still coming up
  ("before 2:50pm today", sent at 9:40pm). This one is kept narrow because it is
  easier to get wrong.

It skips quotes and code, other people's time zones ("their deadline is tomorrow in
Berlin"), and things in the past tense. When it fires, the message is held with a
note showing your actual local time, so the fix is right there. The agent can
correct the message and resend, or send it unchanged. It never blocks anything for
good.

This is the first check that runs on *every* normal chat reply, so a false alarm
would be annoying. That's why it starts in a silent trial mode: it only writes down
what it *would* have flagged. It writes one log line for **every** check, not just
the ones that fire, so a quiet log proves the check actually ran. The log never
stores the message text. It only switches on for real after two weeks and at least
30 flags that turned out to be right at least 90% of the time. After that it tracks
how often the agent overrules it, and goes back to silent mode if that happens too
often.

**5. Tests cover the tricky edges.** Both sides of midnight (11:30pm and 12:30am),
the evening hours when UTC has already moved to tomorrow, right and wrong weekdays,
a past time described as coming up versus described in the past tense, two
computers in different time zones, the trial-mode log, and a check that existing
agents get the new stamp when they update.

## Why it matters

Saying "today" about the wrong day sounds small. But a deadline, a promise or a
"talk tomorrow" built on the wrong date is how trust erodes. The agent shouldn't
have to remember to convert time zones. The day should already be written down for
it, and its messages should be checked against that.

---

*Constitutional anchor: **"Structure beats Willpower"**. The agent never has to
work out the day; the system tells it, and checks what it says.*
