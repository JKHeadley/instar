# ELI16 — A stuck message is recovered, or you are told it was not

## The one-sentence version

The watcher that presses Enter when a message gets stuck unsent in a session had
been asking permission from a safety check that could never say yes, so it pressed
nothing 75,001 times in a row while reporting that it had fixed the problem — and
when recovery genuinely runs out of road, it now says so instead of going quiet.

## What actually happens when a message gets stuck

Instar hands a message to a session by pasting it into that session's input and
pressing Enter. Occasionally the Enter is eaten and the text just sits there. Two
layers watch for that: a short in-process check, and a persistent watcher that
survives a server restart. Both work by pressing Enter again.

## The first bug: a permission that could never be granted

Pressing a key on a session's behalf is fenced behind a durable record of the
message being delivered, so a key can never be replayed against a conversation
this machine no longer owns. That is a good fence. But those records are only
created for one kind of session (codex), and the fence was applied to every kind.

For an ordinary Claude session the fence could therefore never be satisfied. The
watcher asked, was refused, and asked again ten seconds later — forever. One
agent's own log held 75,001 consecutive refusals, every one at the first attempt,
across six sessions. Nothing was ever pressed. The ladder of escalating attempts
never advanced, so it never ran out, so nothing was ever escalated or raised.

Now the fence applies where its record can exist, and falls through to the plain
best-effort keypress where it cannot — the same path the original paste already
uses, so this adds no reach that the delivery itself did not already have.

## The second bug: giving up quietly

Every way this could end — attempts exhausted, escalation refused, escalation
timed out — finished by marking the record spent and writing one line to a file
nobody reads. No flag, no notice, nothing to the person waiting for a reply.

On 2026-10-20 an operator wrote to an agent twice, 28 minutes apart. Both messages
sat unsent in that agent's input. The logs said recovery had succeeded. The
operator saw delivery receipts and silence.

Now a refusal spends a budget, so the wedge reaches a real end — and that end
raises one flag and sends one message to the conversation itself saying the words
never arrived and asking for them again. One per wedge, never one per tick.

## And they stopped claiming victory early

Both watchers reported "recovered without user intervention" the moment a key was
sent — or, in the refused case, when no key had been sent at all. Both now report
what they *did*, and a new verify-only pass reads the screen after the attempts are
spent and reports what actually happened.

## What you might notice

If a message genuinely cannot be delivered into a session, you get one plain
message saying so and asking you to resend, where before you got nothing.
