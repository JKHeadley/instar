# Closeout activeness bypass on a confirmed move — Plain-English Overview

> The one-line version: when a conversation is proven to be running on another machine, this machine may finally close its leftover copy **even though that copy is busy** — because being busy is exactly what makes it wrong.

## The problem in one breath

The same conversation was running on two machines at once, answering the same message twice. The system noticed correctly and named the right winner. Then it tried to close the wrong copy — and refused, because that copy was busy. A wrong copy is busy *precisely because* it is duplicating work. So the guard meant to protect work-in-progress was protecting the mistake instead, and only a person killing the session by hand ever ended it. That happened twice in one day.

## What already exists

- **The owner record** — every conversation has one machine that owns it, and the operator can pin one deliberately. That was in place and correct throughout this incident.
- **The duplicate detector** — spots the same conversation live on two machines and works out which copy should win. It ran three times that day and named the right machine every time.
- **The closeout** — the janitor that closes the leftover copy on the losing machine. It fired with the right target and the right reason.
- **The reasons never to end a session** — a fixed, ordered list: it's protected, a recovery is under way, a message is waiting to be delivered, the user just spoke to it, there's an open promise, it has helper agents running, a long build is going, and — last — *something is running inside it*.
- **A narrow exemption already exists** — an earlier fix let the closeout ignore exactly one of those ("the user spoke to it recently") when a move is confirmed genuine, because a message that arrived just before the move still looks recent. This change follows that pattern.

## What this adds

One more narrow exemption, under exactly the conditions that already govern the existing one: when the conversation is owned by another machine, that machine has been checked and genuinely holds a live copy, and the user has not typed to the local copy since that check — then the closeout may also ignore the "something is running inside it" reasons.

## Three things worth reading twice

**The obvious version of this fix does nothing.** There isn't one "it's busy" reason — there are three in a row: a child process is running, the main process is working, and can't-tell. Lifting only the first means the second refuses instead. The wall moves and the duplicate survives. That version would have passed its tests and shipped looking like a fix. There is now a test that specifically fails against it.

**"Can't tell" is not "busy".** The third reason fires when the system could not inspect the process at all. Uncertainty is not evidence of activity, so it is deliberately left out and keeps its veto — an uninspectable duplicate still won't close itself, and still goes to a person. Failing toward not killing.

**I was wrong about the safety check, and review caught it.** An earlier version had the request carry two machine names and checked they differed. That proves nothing — both names came from whoever was asking, so anyone could satisfy it. The check now compares against the machine's own identity, and refuses outright if the machine can't identify itself. The claim that this made a bad case "impossible" was withdrawn and rewritten.

## The safeguards

**It cannot fire on a guess.** Every path where the system is unsure the other machine really holds the conversation already stops before reaching the kill. Only a positively confirmed reading gets this far, and nothing about that changes here.

**It cannot take the session you're talking to.** If you typed to the local copy more recently than the moment the other machine was confirmed alive, no exemption is granted and the ordinary rules refuse the close.

**The request carries its evidence, and the evidence is checked.** The kill request states which machine it thinks owns the conversation, which machine it thinks it is, what proof of the other machine it used, when you last spoke, how many confirmations it waited for, and when the request goes stale. Wrong machine, stale request, or an inconsistent story — refused, with the reason recorded. That record is also what makes it possible to tell later whether the feature ever misfired.

**It cannot become a general licence.** Requesting this exemption is only possible through a private internal channel established when the system starts; ordinary code paths cannot ask for it at all. Every other protection is re-checked as normal.

**It deliberately stops short.** A duplicate running helper agents or a long build still refuses to close, still gets recorded, and still ends up in front of a person.

## What it honestly does not fix

**Work in progress can still be lost.** A session ended mid-action can leave something half-done — a partial file write, an interrupted push, an outside call that was sent but never recorded. Git and file operations leave a trail; a shell command, a cloud tool, a webhook or a database write do not. An earlier draft implied the trails covered this generally. They don't, and that's now stated plainly.

**It stops a duplicate being permanent, not being created.** Why the other machine started a copy of a conversation it knew it didn't own is still open — the record that would settle it was too large to read off that machine. That's tracked as its own item, not a guess.

**There's a better design, and it's queued.** Rather than ending the duplicate, tell it to stop talking and let it finish quietly. That would remove most of the lost-work risk. It needs something that doesn't exist yet, so it's tracked separately with its own criteria so it can't quietly disappear once the cleanup starts working.

## What you'd be approving

A change to when the system is allowed to end a session that is doing work. Today it can't do that on a duplicate at all, which is why you got two answers. The trade is: duplicates become cleanable automatically, and in exchange there is a narrow case where in-flight work on a duplicate can be interrupted and partially lost. Rolling it back is a plain revert with nothing stored to repair, and two existing switches turn the behaviour off without a deploy.
