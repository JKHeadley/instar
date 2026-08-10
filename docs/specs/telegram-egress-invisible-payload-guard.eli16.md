# Making sure a message you can't see never gets sent — in plain terms

## What actually went wrong once

Someone's agent sent a message whose entire contents were a single invisible character — the kind that
takes up no space and shows nothing on screen. The send failed in a confusing way, retried nine times over
more than four hours, and finally told the user: *"I had a reply for you but couldn't deliver it."*

There was no reply. There never had been. The user spent that whole time believing something had been lost.

So we added a check: if a message contains nothing a person could actually see, refuse to send it and say
so plainly, rather than delivering emptiness or inventing a delivery failure.

## The part that kept going wrong

The check itself has always worked. **What kept being wrong was our belief about where it needed to be.**

Four separate times, someone put the check somewhere, wrote down "that's all of them", and was proved wrong
by the next person who looked:

1. Put it on one entry point → *"fixed at the point of sending."* Someone found a second entry point.
2. Put it on both → *"both doors."* Someone found a third.
3. Moved it to what looked like the one place everything funnels through → *"the single chokepoint every
   send passes through."* Someone ran the code and found a way straight past it.
4. Moved it to the function that actually talks to the network → *"the one function everything reaches."*
   A reviewer found a branch that skips that function entirely.

That last one was mine, today, in the very change whose job was to fix the pattern.

**The habit underneath is the same every time: saying "that's the whole set" without going and counting.**

## What this change does

**It counts, and it puts the check at every exit — not at whichever function looks central.**

Counting properly turned up **six** places in our code that can send a Telegram message, not the two
everyone had been talking about. One of them — the piece that keeps the agent reachable when it's running
as a backup on another machine — had **no check at all**, and had been missed by all four previous counts
for one simple reason: every count only looked at the main messaging file.

It also turned out one file has **two different ways out**, not one. Normally it talks to Telegram directly.
But when it's a backup machine without its own credentials, it hands the message to another machine to send
instead — and that path never touches the function everyone assumed was the bottleneck.

So the rule changed from *"guard the funnel"* to **"guard every exit."**

## Two smaller things worth knowing

**A topic's name counts as something you can see.** Chat topics have titles, and it was possible to create
one whose title was entirely invisible — it passes the "is this at least one character long?" test, because
those invisible marks *are* characters. That leaves a permanently unfindable topic sitting in the list.
Now names are checked the same way message bodies are.

**Not everything with text in it is a message.** The little grey confirmation that pops up when you tap a
button is allowed to be empty — that's how you dismiss it. Refusing those would be the check overreaching,
so they're deliberately left alone, and there's a test that fails if someone widens it later.

## The safeguard against this happening a fifth time

Rather than trusting the next person to remember, there's now an automatic check that **works out the list
of senders for itself** — anything in the code that contacts Telegram and sends words — and fails the build
if any of them is missing the guard.

An independent reviewer then tried to defeat that automatic check, and **succeeded five different ways**,
including simply commenting the guard out (the checker still reported everything fine) and hiding one
sender from the count (it cheerfully reported "all clear — 5 senders" while quietly no longer looking at
the sixth). All five holes are closed, and the checker now also refuses to accept the list getting
*shorter* without someone explicitly saying why.

## What you'd notice

Almost certainly nothing, and that's the intent. Real messages send exactly as before — including a message
that's just a full stop, which is visible and therefore fine.

The one behaviour change: something trying to send you a genuinely empty message now fails immediately and
says *why*, instead of either delivering nothing or telling you your reply got lost.

## What this does not cover, said plainly

- The automatic check confirms each sender *has* the guard; it can't prove the guard sits on the exact line
  the message travels. Tests cover that instead.
- If someone invents a completely new way to reach Telegram, it won't be in the derived list. The
  shrink-alarm makes a disappearance loud, but it can't predict a shape nobody has written yet.
- This is Telegram only. Slack and the others are untouched, and nothing here claims otherwise.

## What you're being asked to decide

Whether to approve the spec so this can be committed. The work is built, tested, and independently
reviewed — but it changes the messaging path, which requires your approval rather than mine. Approving
means: yes, refuse invisible messages at every exit, and yes, extend that to topic names.
