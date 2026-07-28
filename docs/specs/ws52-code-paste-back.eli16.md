# Plain-English overview — pasting your sign-in code on the card (not through chat)

## What this is

When one machine borrows another's subscription, signing in has two steps: you open a link and log in, then the website hands you a **code** you have to paste back to finish. Right now the dashboard card only does step one — it shows the "Sign in" link but gives you nowhere to put the code. In the real run, Justin signed in, got a code, and had no idea what to do with it; he ended up sending it to me over chat and I pasted it into the machine by hand. That's a bad experience and a bit unsafe (a sign-in code shouldn't sit in a chat log).

## What this change does

Adds a "paste your code here" box right on the card, with a short instruction. After you sign in, you paste the code into that box and tap Submit. The code goes straight from your dashboard to the machine that's doing the login (the Mac Mini), over the same secure connection everything else uses — never through chat. The machine types it into its waiting login, finishes signing in, and the card updates to "Done — adriana is set up on Mac Mini."

## What already exists vs. what's new

Already working: the approval, the cross-machine delivery, the machine starting its own login, and the (now-fixed) full sign-in link showing on your dashboard. New: the code box on the card, a route on the target machine that types your code into its waiting login, and a relay so your single dashboard can hand the code to whichever machine is doing the login.

## Safety

- The code travels over the same authenticated connection as the rest of the dashboard — never through chat or any messaging.
- It's single-use and short-lived; it's typed into the login and never stored or written to logs.
- No password or token is ever copied between machines (unchanged — each machine still does its own login).
- If the login isn't actually waiting for a code (already done or expired), you get a plain message to re-tap Approve, not a confusing error.

## What you need to decide

Nothing structural — it's the missing last step of a flow you already approved. The only judgment call (made here) is that the code rides the existing secure API, never chat.
