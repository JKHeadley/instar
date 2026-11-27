# Reading in the dashboard clears the phone's unread count — Plain-English Overview

> The one-line version: when you read a conversation in the dashboard, the agent now counts it as read for you everywhere, so the unread number on your phone goes away too — like reading a chat in Telegram Web clears it on the Telegram phone app.

## The problem

The dashboard's Conversations page (added in #2966) shows the same conversations as the Instar iPhone app, and the unread counts that were added to the app at the same time also show up in the dashboard's list. But the dashboard could only *show* those numbers: reading a conversation there did not tell the agent anything, so the phone kept saying "1 unread" for a message you had already read on your computer. Justin asked for unread counts that stay in step, the way Telegram Web and the Telegram phone app do.

## What already exists

- **Read markers.** The agent keeps one "read up to here" position per person per conversation, shared by all of that person's devices and copied to every machine of the agent. The phone reports what it has read with `POST /mobile/conversations/read`, and every unread number is counted from these positions.
- **The browser as a device.** Since #2966, a browser is set up as its own signed device of the owner, like a second phone, and may call only the conversation routes it is allowed.

## What this changes

- The browser may now call the same read report the phone uses. It is the same rule and the same marker for the same person, with no new kind of marker.
- The Conversations page reports the newest message as read when you have the conversation open, the window is in front, and a newer message has arrived since its last report. It sends one small report per conversation, only when something new was shown.
- The dashboard list shows unread badges for the other conversations and clears a badge once you read that conversation.

## Safeguards

- A report can only move "read up to here" forward, never back. It can never mark a message read that the agent does not hold yet; the server limits it to the newest message it has.
- The report uses its own small allowance on the server, 60 a minute, so it can never use up what sending or an emergency stop needs.
- A browser still cannot call anything else it could not call before. Only this one route is added to its list.
- A hidden or background tab reports nothing.

## What you actually need to decide

Nothing new. Echo approved this as a small follow-up to #2966 on 2026-11-08: open the read report to browser devices, show badges in the dashboard list, and prove that a browser read clears the count a phone sees.
