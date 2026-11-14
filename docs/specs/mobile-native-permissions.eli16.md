# Permission slips and feature switches on the phone — the plain version

## What this is

The Instar iPhone app already shows most of the console without opening a web page: chats, the schedule, promises, machines, accounts, plans, phones and more. All of those are read-only. This change adds the first two screens where you can **change** something from the phone:

- **Permission slips.** When an agent asks for permission to do something risky ("Let Sam deploy to production for 1 hour"), the request waits for you. You can now approve it or decline it (with a reason) from the phone. The phone also lists the slips that are active right now.
- **What I'm allowed to do.** The agent's feature switches. You can now turn a switch on or off from the phone.

## What already exists

- In the console, approving or declining needs your dashboard PIN in that one request. Turning a switch needs a recent PIN unlock. The PIN is how the server knows a person, not the agent, made the choice: the agent holds the ordinary access token, so the token alone can never approve anything.
- Last week the app learned to open the console without the PIN. It did that with a second key on the phone, kept in the phone's secure chip, that only signs after Face ID, Touch ID or your passcode. The server checks that signature, so "the owner was there" is proven by the phone's hardware, not by the app's word.

## What's new

- Two read-only lists for the owner's phone: waiting requests and active slips, and the feature switches with their state.
- Four write calls the phone signs. Each Approve, Decline or switch first shows a confirmation naming the exact action. Then iOS shows its own Face ID (or passcode) prompt. The phone signs a one-time code from the server together with the exact action: which request and approve or decline (and the decline reason), or which feature and on or off. The code works once, for one minute, for that one action on that one phone.
- The server then runs exactly the same code the console runs, and writes the same records, plus which phone did it.

## The safeguards, in plain terms

- Only the owner's phone, while it is still paired and not removed, can do this. Other people's phones only see the lists, or nothing.
- The agent can never use these calls: its token is refused on every write.
- A replayed, expired or swapped signature is refused. A signature meant for opening the console can't be used here, and the other way round.
- The phone can't do more than the console with the PIN. If no PIN is set up, the console can't approve anything, so neither can the phone. Revoking slips, granting extra people and writing slips by hand stay in the console.
- What you approve is exactly what you saw: if the request's details change between the screen and your Face ID, the approval is refused.
- It starts on the development agent only, dark everywhere else, until it has been proven there. There is a switch to turn the phone writes off at once without an update.

## What you need to decide

Nothing new: Justin asked for this, and the phone gets exactly the authority the PIN-confirmed console has for these two actions, with a fresher and more tightly bound proof. If that comparison ever turned out wrong, the off switch stops the phone writes immediately.
