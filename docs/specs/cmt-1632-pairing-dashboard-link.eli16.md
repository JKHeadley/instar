# A pairing line that sends you to the dashboard now carries the link — Plain-English Overview

> The one-line version: when an agent cannot take a pairing invite in Telegram and tells its owner to use the dashboard instead, the message now includes a direct link to the right dashboard page, so the owner taps once instead of hunting for the page.

## The problem in one breath

Justin pasted a pairing invite into Telegram for his agent Cora. Cora could not accept it there, because nobody had told Cora who her owner is, so she replied: "Open the Threadline tab on the dashboard to do this with your PIN. Paste the invite there." There was no link. Justin had to find the dashboard address and the right page himself. The standing rule is that any message sending the operator to a page carries a direct link. This reply is a fixed sentence written into the code, so the review step that checks agent-written messages for missing links never sees it.

## What already exists

- **The pairing helper for Telegram.** It handles invites pasted into Telegram and the Approve, Decline and Finish buttons. When Telegram cannot be used for a step, it tells the owner to use the dashboard instead, in four places: an invite it cannot take, a button tap it refuses, an expired button, and a finish prompt sent while buttons are off.
- **A shared way to build operator links.** The server already knows the public address of the dashboard (the tunnel), and already avoids sending a `localhost` link while the tunnel is starting.
- **The dashboard page.** Pairing by hand lives on the Other agents page (under People). It has "Connect another agent" with an "I was sent one" box for pasting an invite.

## What's new

1. **The four lines carry a direct link** to the Other agents page whenever the address is known. The invite paste line also says exactly what to tap there: Connect another agent, then paste under "I was sent one".
2. **No address, no made-up link.** If the tunnel is still starting, or the address cannot be read, the line names the page in plain words instead.
3. **The invite is never put in the link.** An invite contains a one-time secret, and links end up in logs and browser history, so the page opens empty and the owner pastes the invite there.
4. **Not shown to strangers.** If someone who is known not to be the owner pastes an invite or taps a button, the refusal does not include the dashboard address.
5. **Short answers stay short.** Telegram refuses a button-tap answer longer than 200 characters, which would leave the owner with nothing. The tap answers use a shorter wording, or plain words, when the link would not fit.
6. **The Telegram connection's own backup line** (used when pairing is not wired or fails) gets the same link.

## What you need to decide

Nothing. This is a wording-and-link fix to existing messages. No setting changes, nothing new to approve.
