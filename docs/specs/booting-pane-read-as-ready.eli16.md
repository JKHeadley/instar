# A startup banner — and a startup question — were read as "ready" — Plain-English Overview

> The one-line version: a check that decides whether I am awake enough to be
> handed a message was fooled by an advert printed while I was still waking up —
> so your message was typed into a screen that could not yet hear it, and the
> delivery was recorded as a success. Fixing it turned up a second, sharper case:
> the same check also mistook a question waiting for an answer for a place to type,
> where an arriving message could have picked the answer itself.

## What you saw

You messaged me at 10:44 this morning. A session started — you watched it appear —
and then it sat there on its startup screen doing nothing. Your message never
arrived in it. Your second message, five minutes later, landed fine.

## What actually happened

When a message arrives and no session is running, one is started for it. Because
your message came with a large amount of conversation history attached, it was
written to a file and only a short pointer was typed into the new session.

Before typing anything, the system waits for the session to be ready. Waiting is
the right idea; the problem was how "ready" was decided.

It looked at the last few lines on the screen and said *ready* if it found any of:
the input box symbol, a permissions indicator, or a mention of one of the commands
`/effort`, `/model`, `/fast`.

That last one is the fault. It matched a **mention**, anywhere, in any context.

While starting up, the tool prints a banner. That morning the banner included a
promotional line: *"Fable 5 draws down usage faster than Opus 4.8. Run **/model**
and select Fable to use it."*

There is the phrase. The check found `/model` in an advertisement, concluded the
session was accepting input, and typed your message in. Fifteen seconds later the
session actually finished starting. The text had gone into a screen that was still
drawing itself, and it was gone.

And here is the part that made it invisible: the system then wrote in its log that
it had **injected the initial message successfully**. It had typed the characters.
It had no way of knowing nobody caught them.

## Why this is worse than a normal bug

The banner is proof that the tool is **not** ready — it is the thing printed
*instead of* the input box. The check read the strongest available evidence of
not-ready as evidence of ready. It is the same shape as several other faults found
this week: something that measures a system got fooled by the thing it was
measuring, and reported the opposite of the truth confidently.

Your message survived only because of an unrelated backstop that re-reads recent
conversation whenever a session starts. That is what surfaced it to me. If that
backstop had not existed, your message would simply have been lost, with a success
line in the log saying otherwise.

## What changed

**Two things, because the operator found a second one while I was fixing the first.**

**One — the command-name check is gone, not narrowed.** My first attempt kept it and
demanded the command appear the way a status bar draws it. An independent review
took that apart: the startup banner uses that same layout. Two lines in my own test
file were banner text in exactly the shape I claimed only status bars use. The only
thing keeping them out was that those particular words weren't on my list — so it
was still a word list, dressed up as structure. And a plausible banner line
advertising the very same command still slipped through.

I also claimed I had removed the dependency on Anthropic's wording. I hadn't. The
screen is a fixed width; in the incident that phrase sat fourteen characters from
the end of a line. An edit shifting the wrap by fourteen characters would put it at
the start of the next line, where the check matched again.

So the check no longer looks at command names at all. It looks for the input box,
or for the footer strings that only exist once the app is running — and it now
recognises all of those footers, where before it knew only one of three.

**Two — a question on screen is not somewhere to type.** The operator noticed that
sessions sometimes start by asking something. The marker the tool paints beside the
*selected answer* is the same character it paints for the *input box*. So a session
waiting on a question read as ready.

That is worse than the banner. At a banner, typing goes nowhere and is lost. At a
question, typing is not lost — pressing Enter **picks an answer**. A message
arriving at that moment could answer a permission question on the operator's
behalf.

## Why the answer is no longer just yes or no

The review found something I had missed entirely: three different parts of the
system ask this check, and one of them **kills the session** when the answer is no.

That changes everything about a stricter check. I had written that the worst case
was waiting, which is harmless. For that third caller it isn't — a stricter check
could destroy a live conversation for being slow.

And "not ready because it is still starting" and "not ready because it is asking a
question" want opposite responses. The first is worth killing if it never resolves.
The second is a session politely waiting, and killing it would be absurd.

So the check now says *which* of the three states it sees, and each caller decides.
The one that kills leaves a question alone, waits a bounded moment for it to be
answered, and only then treats the session as stuck.

## Proving it is a real check

The test carries the actual screen text from this morning's incident, copied
exactly, banner and all — plus the three startup questions the operator's finding
was about. If someone later loosens the check back toward matching prose, or drops
the question case, those tests fail and name what did it.

I put each broken version back deliberately and ran the tests. Restoring the old
command-name matching fails six assertions; removing the question handling fails
three. Both include the one whose only job is to confirm the check still tells its
three answers apart. A test that cannot fail is not a test, so I checked that these
can.

I also pinned the other side of each boundary, which is the part that is easy to
skip: ordinary output listing "1." and "2." above the input box must **not** be
mistaken for a question, or a perfectly healthy session would sit there unanswered.

## What this does not fix

**It does not verify that typed text arrived.** Waiting correctly makes early
typing much less likely, but the system still reports success on the basis of
having typed, not on the basis of anything appearing. A slow moment could still
lose a message and still log a success. Making delivery confirm itself is a
separate, larger change, recorded and deliberately not bundled in here.

**It does not address why startup is so slow.** My standing instructions file is
about 260,000 characters — well past the 150,000 the tool itself warns about — plus
a large start-up script. That is what stretched the gap to fifteen seconds. A
tighter check tolerates a slow start; it does not make it fast.

**And one honest note about scope:** this fixes one probe on one path. It does not
establish that no other check in the system is matching prose where it means to
match structure. That instinct — asking whether a matcher can be fooled by its own
subject — has now found four separate faults this week, which suggests looking is
worth more than fixing.
