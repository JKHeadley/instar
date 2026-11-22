# A change feed for Telegram and Slack chats — the plain version

## What this is

When you have a Telegram or Slack conversation open in the web chat, the page asks the agent every
five seconds for "the newest 50 messages". Usually nothing has changed. The agent still looks up
those 50 messages, checks who sent each one, attaches any files, packs them up and sends them. The
page then downloads all 50 and redraws them. That is wasted work on both ends. It's part of why long
chats can feel slow, and it's the speed priority on the Telegram parity list.

Chats started in the Instar app don't have this problem. For those, the page can ask "what happened
since this point?" and get back only the new things. This change gives Telegram and Slack chats the
same kind of question.

## What already exists

- The two "give me messages" addresses for Telegram and Slack chats, with a way to scroll back
  ("messages before this time").
- A full read every 30 seconds that asks every machine the agent runs on. It stays exactly as it is.
- The page already ignores duplicates: if a message arrives twice, it shows once.

## What is new

1. Both addresses accept "messages after this time". The page passes the time of the newest message
   it already has, and the agent sends back only messages from that time on, plus the two minutes
   before it.
2. The two-minute overlap is deliberate. Message times aren't perfectly in order: two machines, or
   Telegram and the agent, can stamp times a little differently. Sending a small overlap means a
   message stamped slightly "too early" still arrives. Because the page ignores duplicates, the
   overlap costs almost nothing.
3. The web chat's five-second check uses the new question. The 30-second full read across machines
   does not change. It's the safety net that catches anything the overlap could miss, such as a
   Slack message edited after it was sent.

## Safeguards

- Nothing about who may read what changes. The same permission checks run first. The new question
  only trims a list the reader was already allowed to see.
- Older agents simply ignore "after" and send the newest page as before, so nothing breaks while
  machines update at different times.
- Undoing it is one revert. The page then gets full pages again, which it already handles.

## What isn't in this change

- The iPhone, Mac, Windows, Android and Linux apps can start using the same question on their own
  schedule. Each app's own parity card tracks that.
- Edits and deletions don't become their own events. Neither Telegram's log nor Slack's history
  records them that way today, and the 30-second full read already shows the current text.

## What you need to decide

Nothing. This is a small change that only adds a new option, and a revert fully undoes it.
