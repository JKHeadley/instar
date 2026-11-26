# ELI16: an invite waiting for your approval no longer vanishes when the agent restarts

> The one-line version: when the agent restarts while a pairing invite is waiting for your OK, you are now told it was cleared and when it stops working, the agent avoids restarting itself for updates while one waits, and the dashboard stops showing an old "could not reach the agent" error once the agent is back.

## The problem in one breath

To pair two agents, one person sends the other an invite. The person who receives it pastes it into their agent's dashboard, or forwards it to their agent on Telegram, and then approves it. Between the paste and the approval, the invite sits in the agent's memory only. That is on purpose: the invite contains a one-time secret, and keeping it off the disk means nothing on the machine can read it later. But it also means a restart wipes it. In a test on 2026-10-20, the invite simply disappeared after a restart, with no message. Pasting it again worked, but nothing told the person to do that. The dashboard also kept showing a red "Could not reach the agent: Failed to fetch" box after the agent was back, until the page was reloaded.

## What already exists

- **The invite engine** keeps waiting invites in memory and never writes their secret to disk. This does not change.
- **The auto-updater** already waits before restarting when someone is in the middle of a conversation with the agent. It records why it is waiting and checks again every few minutes.
- **The dashboard pairing card** checks the agent every 10 seconds and shows what is waiting at the top.

## What this adds

The main change is a small note on disk for each waiting invite. The note never holds the secret. It holds a scrambled form of the invite's id, the name the inviting agent gave itself, the name of its owner (also as given), and when the invite expires. The note is deleted when the person approves or declines, or when the invite expires. When the agent starts up and finds a note for an invite that has not expired, it knows a restart cleared that invite. It then:

- shows a notice at the top of the pairing card: the invite from that agent was cleared by a restart, paste it again before it expires;
- sends one Telegram message to the owner: "An invite from "Scout" (it says it belongs to Justin) was waiting and was cleared by a restart. Forward or paste it again before Tue, 2:00 PM PDT, about 50 min from now." The time is in the owner's own time zone when their profile has one, and in UTC (labelled) otherwise. The message is sent once.

The notice goes away when the invite is pasted again, when the person dismisses it, or when the invite expires. If the invite had already expired by the time the agent came back, there is no notice, because there is nothing left to do.

Two smaller changes:

- **The auto-updater holds its restart while an invite waits.** It uses the same waiting mechanism it uses for conversations, records the reason ("a pairing invite from "Scout" is waiting for the operator's approval, until …"), and checks again every 5 minutes or when the invite expires, whichever comes first. So the hold can never last longer than the invite does (1 hour by default, 24 hours at most). A restart the operator asks for by hand is not held.
- **The dashboard's "could not reach the agent" error now clears itself** the next time the agent answers. Other messages (like "That PIN was not accepted") stay until something replaces them.

## The safeguards

**The secret still never touches the disk.** The note holds no secret, no invite text and not even the invite id, and a test reads the note file and checks for each of them, including in other encodings.

**A restart cannot be held forever.** The expiry inside an invite is written by whoever made it, so the agent does not just trust it: an invite claiming to last more than 24 hours (plus 5 minutes for clocks that disagree) is refused when it arrives, because no real invite lasts that long. On top of that, a hold never lasts more than 24 hours from when the invite arrived, and never longer than the 4 hours the updater already allows for waiting on anything. Every hold also ends at its invite's expiry. A hold that has passed its end time is ignored even if something still reports it, and a broken hold source holds nothing.

**The Telegram message is not repeated.** It is marked as sent once delivered, and two deliveries running at the same moment cannot both send it.

## What you actually need to decide

Nothing new: this makes the waiting invite behave the way the approved invite-link spec (§8) already asks.
