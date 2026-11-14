# Team settings for the whole agent, in plain words

## What this is

An Instar agent can run on several computers at once: say a Mac Mini, a laptop, a Windows PC and a MacBook Pro. Before the owner can add teammates in the Instar app, two settings have to be on: memory privacy (so one person's private memory never leaks into a shared conversation) and app conversations (so the app can talk to that computer at all). Each computer keeps its own copy of those settings.

Until now the app's People page showed one warning per computer: "Mac Mini has memory privacy turned off", "Laptop has memory privacy turned off", "Mama PC has app conversations turned off", and so on, each with a button to "mark it gone" even though every computer was fine. The owner, Justin, called this overwhelming and said it should be one single thing for the whole agent. He is right: the agent is one agent, and the owner should never have to think about which computer holds which setting.

## What already existed

- Each computer already tells the others what it has on, every minute, as part of how they share the team access record.
- The owner already had a Face ID button for memory privacy, but it only changed the one computer the phone was talking to.
- The computers already have a signed, private way to call each other, used for sharing the access record.

## What is new

- The People page data now has one line per setting, listing every computer it is off on, with one action: "turn on everywhere" (or "update" for a computer on an old version).
- One Face ID tap turns that setting on for every computer. The computer the phone is talking to sends a signed request to each of the others; each one switches the setting on in its own settings file and restarts itself in a planned way. The phone gets back a list saying what happened on each computer.
- A computer that is asleep or has no address right now is listed as not reached, and the request is kept and tried again every few minutes (waiting longer each time) for up to a week. Nothing is quietly skipped.
- The old memory privacy button now does the same thing, so the app version already on the phone benefits too.
- The message that blocked inviting someone no longer tells the owner to mark a working computer as gone. "Gone" is only for a computer that stopped answering.

## The safeguards, plainly

- Only the owner's own phone, with Face ID, can do this, and the Face ID signature names the exact setting, so it cannot be reused to turn on something else.
- The request between computers can only turn one of two named settings on. It can never turn anything off and never touch any other setting, so even a misbehaving computer of the agent could only make another computer more private.
- If the computer the phone is talking to cannot apply it, the owner is told it failed. A computer that is just asleep is not a failure, because it will get the request when it wakes.

## What the reader needs to decide

Nothing beyond the owner's request: this makes the People page match how the agent actually works (one agent, many computers). The app side already calls the new route on its own branch.
