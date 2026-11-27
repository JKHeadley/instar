# Native conversation as the base: the plain-English version

For Justin. This goes with `native-conversation-base.md` (revision r6: after the sixth and last review round, plus a few sentence-level fixes made after it; each of those was checked once against the code and did not go through another full review). The design is written as two documents. This one covers replies and photos. Its sibling, `native-conversation-any-machine-access.eli16.md`, covers reading my sessions from any machine and the dashboard reply box. None of this is built yet.

## What you asked for

You asked for two things on 2026-11-11 in the effort topic. First: Instar's own chat should be the real home of every conversation, with Telegram and Slack as ways in and out, and messages that fail to go through should be sent again. Second: I should always be able to see any conversation and the session behind it, whichever machine I am on.

## The idea in one paragraph

Today each chat platform keeps its own notes on whichever machine happens to talk to it. If that machine is asleep, or the notes are on the wrong machine, I lose part of the story. The plan is one shared record of every conversation that all my machines hold. Telegram, Slack, the app and the dashboard become doors into that record. A door keeps working even if the record has a problem. Only the machine that actually sent a message is allowed to say whether it arrived.

## What gets fixed first

Five things went wrong for you that day. This document fixes the first three; the sibling fixes the other two.

1. **A reply that vanished.** I wrote you a reply and the sending machine quietly threw it away, because a newer message existed. I believe the newer message was my own "got it" note; I confirm that from the sending machine's log before building. From now on a later message never cancels a reply. If a reply is held up for more than five minutes, it arrives with a first line saying it is a late reply, written more than so many minutes ago. Nothing puts that line there today, so this is new work. In a few cases the line cannot be added (for example, the reply was already handed to the sending machine, which then stalled); the reply still arrives, and the session that wrote it is told you saw no late notice. A reply is only dropped when you already have the same text. If a reply truly could not be sent, the session that wrote it is told why (Telegram refused it, it never got out before its tries ran out, or it passed its time limit) and gets its text back to send again.
2. **"I don't know if it arrived."** My check asked the wrong machine. Now it asks the machine that did the sending and repeats that machine's answer. It says "safe to send again" only when the sender says it definitely did not go and no other machine is still holding it. If the sending machine cannot be reached, the answer is "not sure", whatever my own machine's notes say. "Not sure" and "failed" are kept apart: when I am not sure, I do not send a second copy and I do not tell you it failed.
3. **Photos stuck on another machine.** I was given a file location that only existed on a different computer. Now your message reaches me straight away and the photo follows by itself a moment later, on the machine I am running on. If it has not come after five minutes I am told it has not arrived yet, not that it failed, and it still shows up by itself if it comes later. This works where my machines already share files, which is the case for my own machines today; on a setup without that, I am told plainly that the photo is on another machine. One gap is left for later: if my session moves to another machine while a photo is still being copied, the photo does not arrive there by itself; I already hold its id and fetch it with that, and the automatic version is a tracked promise. This also closes a hole: text typed in a chat can no longer trick me into opening a file.

## Decisions I made

- The fix for vanished replies is on for every agent from release, not only on my development machines. A lost reply is the worse outcome. There is no setting that brings the old rule back; the earlier draft had one, and the review showed it would let a clock comparison cancel a reply again. Undoing the fix means going back a version. I review the results on 2026-11-25 by reading every late reply.
- **This undoes a fix from one week ago, and you should know that.** The rule I am removing was added on 2026-11-04, after a status I wrote at 6:08 PM reached you at 6:36 PM, when you had already answered it. Late replies like that made the conversation read backward, so I made a later message cancel a waiting reply. That rule also cancels replies you never got, which is worse. With it gone, a held-up reply will again arrive after the conversation has moved on. The difference is that it now says it is late in its first line, and the session that wrote it is told. The proper cure, letting the session that wrote a waiting reply withdraw it, is a tracked promise and is not built yet. I told you this in the effort topic on 2026-11-11 and asked you to object if you disagree.
- It also changes one line of an earlier spec of mine (2026-11-05, which I approved under the standing rule; you did not review it). It said cancelling by timestamp was intended.
- The five-minute mark for calling a reply late is a starting value I inherited, not one I measured. Shorter delays are counted too, and I set the value from them on 2026-11-25.
- No new separate messages to you. A late reply carries its own note, and the session that wrote it is told. The two existing "a reply had trouble" notices are reworded so that one says "did not reach you" only when that is certain, and the other says "may not have reached you".
- If a machine running an older version ends one of my replies without saying why, the reply is not treated as finished. I am told, or it shows up as one item per conversation on the dashboard.
- If the job of sending to Telegram moves to another machine while I am not sure whether a reply reached you, the new machine does not send it. It asks the old machine what happened first. If the old machine cannot answer, nothing is sent, and the session that wrote the reply is told that I am not sure and that you may already have the text.
- Two limits I accept and state plainly. First, the check that stops a second copy of the same text looks back over the whole wait on a machine with this version, but only 15 minutes on a machine still running the older version; until that machine updates, a reply held longer than that could reach you twice. Second, that same check can also drop an identical answer to a new question in the same conversation. It works that way today for every message, I am not changing it here, and the session is told when it happens.
- The session's own way of reading back a reply's text is closed to phones and team members; it answers only a caller allowed to read that conversation.
- When a reply definitely failed, the system does not send it again by itself. It has already retried, so the session that wrote it gets it back with the reason and decides. If no session is running for that conversation, the reply waits for the next one on that machine; I count how often that happens and decide on 2026-11-25 whether it needs an automatic resend. If none ever runs there, the wait ends when the machine clears its old delivery records, and a dashboard item stays as the record that the reply was never handed back.

## What is not in the first stage

The shared record itself comes in later stages, each with its own design and review: dashboard replies becoming real conversation messages, then recording every Telegram message, then delivery status, then reading from the record everywhere.

Slack is left alone for now, because two earlier decisions keep Slack conversations on one machine. While checking, I found that Slack files may already be copied to every machine, which those decisions meant to avoid. I check that on a real machine by 2026-11-13 and tell you what I find.

Everything I put off is written down as a tracked promise with a date, so none of it depends on my remembering.

## What I need from you

Nothing. Nothing in this design changes the constitution, so I approve it myself under the standing rule. You get the review report to read, including the Slack finding.
