# Remote Desktop permission card only when Remote Desktop is used — plain-English overview

## What this change is

Instar can let you see and control a Mac's screen from your phone or browser ("Remote Desktop"). To do that, macOS has to allow Instar's small desktop helper under Screen Recording and Accessibility. When an update changes the helper, macOS can take that permission back, and Instar used to put a card in your "Needs you" list straight away telling you to go to that Mac and switch the permission back on.

That card appeared on every Mac where the permission was missing, including Macs where nobody ever uses Remote Desktop. On 20 November 2026 the owner got one for the Mac Studio, which had not had a single Remote Desktop session in the last month, and pointed out that it asked them to fix something they do not use. Every card costs attention, and cards about unused features bury the ones that matter.

## What already exists

- Instar already keeps a private, local record each time a Remote Desktop session starts on a Mac (no screen contents or keystrokes, just "a session started at this time").
- The Machines page and the Remote Desktop page already show when a Mac's Remote Desktop is not ready, with the exact steps to fix it.
- When the permission comes back, Instar already closes the card by itself.

## What is new

Before raising the card, Instar now checks that local record. If nobody has started a Remote Desktop session on that Mac in the last 30 days, it does not raise the card. The Mac still shows as "not ready" on the Machines page, and the moment someone opens Remote Desktop on it, the page explains what needs allowing. Once Remote Desktop is used there again, the card can appear as before if the permission is missing.

## Safeguards

- Nothing is blocked or switched off; only a notification is skipped.
- Closing a card when the permission returns still works exactly as before.
- On a Mac with several agents, an agent nobody uses for Remote Desktop no longer "takes" the card, so the agent that is used can still raise it.

## What you need to decide

Nothing. This is a small, reversible change that follows the owner's direction: undoing the change restores the old behavior with no cleanup.
