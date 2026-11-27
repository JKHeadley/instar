# Pairing the Mac app with a QR code — the plain version

## What changes

Today, to connect the Instar Mac app to your agent you ask the agent for a pairing link and paste it into the Mac. After this change, the Mac's "Pair an agent" window shows a QR code instead. In the Instar app on your iPhone you tap + and "Scan pairing code", pick which agent, and tap Pair. The Mac asks "Pair this Mac with the agent at echo-studio…?" and you click Pair. Your phone asks you to approve the Mac with Face ID. Done: nothing to type on either side. Pasting a link still works, one click away.

## How it works

The Mac can't reach your agent yet; it doesn't know the agent's address. Your phone does. So the phone asks your agent for a fresh one-time pairing link that only works for this particular Mac, locks it so only that Mac can open it, and leaves it in a tiny mailbox on instar.sh. The Mac checks the mailbox every few seconds, unlocks the link, asks you to confirm the agent, and starts the normal pairing. Your phone then sees the Mac waiting and asks you to approve it with Face ID, the same approval you already use for adding a phone.

The QR code holds the Mac's half of a one-time lock, the name of the mailbox slot, and the Mac's own device key. Each code is good for two minutes and then replaced.

## Why it stays safe

- The mailbox only ever holds a locked blob for two minutes. It cannot read it and it cannot pair anything. If it is down or removed, pasting a link still works.
- Only your agent's owner phone can ask for one of these links (your agent can still make ordinary pairing links, as today), and the link only works for the Mac whose key was in the QR code. Someone who copies the link can't use it for their own computer.
- Your phone only approves the Mac whose key matches the code it scanned, and it tells you plainly that this gives the computer full access. Only approve a code on a Mac in front of you that you are setting up now.
- If someone sees your Mac's code and answers it first with their own agent, your Mac shows that agent's address and waits for your click, and your phone usually tells you someone else answered first. They can never reach your agent this way.
- The mailbox is best effort: if a message gets lost, your phone says so and you scan again.
- The code can only be scanned from inside the Instar app, so a link someone sends you can't start this.
- This is ordinary app pairing. It adds no new way to approve a device; it uses the one your phone already has.

## What it costs

One small change to the agent: an owner's phone may now ask for a pairing code, tied to a specific Mac's key, short-lived and limited per hour. One small mailbox on instar.sh, using storage that is already part of the website's hosting plan. New screens in the Mac and iPhone apps, and a check every six hours that the mailbox works. Android follows later with the same design.
