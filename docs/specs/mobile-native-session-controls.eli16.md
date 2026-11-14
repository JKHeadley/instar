# The app's session screen gets the dashboard's controls: plain overview

The iPhone app can open the session behind a chat, show what it's doing and let you type to it. The web dashboard can do more, and Justin asked for all of it on the phone: change the door or model, move the session to another machine, upload files, and anything else the dashboard has. This change adds those.

The new controls in the app are a menu on the session screen showing the current machine, door and model, a row of keys beside the send box (Enter, y, n, Esc, arrows, and Stop), a paperclip for photos and files, Live and History tabs, Close, and a "+" on the sessions list to start a new session. It also opens sessions on your other machines, which until now only told you to go there.

The server doesn't get a second copy of how any of this works. When the phone asks to switch a door, the server calls the same route the dashboard calls, so the same rules apply and the same refusals come back, in plain words. The one thing the phone adds is a check before asking: it refuses a door or model that the dashboard's own menu wouldn't offer.

Different actions need different proof. Pressing a key, or attaching a file to a session you're already in, counts as using the conversation, like typing, so it only needs your phone's own key and the usual recent unlock. Anything that ends, moves or starts a session needs Face ID every time, tied to that exact action: switching a door or model, moving, closing, starting a new one, and changing the default for new topics. A recorded request can't be replayed or changed, because the signed line names everything that matters.

Sessions on other machines go through the machine your phone reached, which has already checked your phone. The machine running the session still has the last word about typing: if it has typing from other machines switched off, the phone says so and offers to move the session here. An older machine that hasn't updated gets a plain "needs the update" and nothing happens there.

Files go up to 8 MB, the dashboard's limit, and land on the machine running the session, in a private folder, and the session is told where to read them. History removes the agent's token and PIN if a conversation ever quoted them.

What you need to decide: nothing. Face ID actions sit behind the existing switch for phone changes: on for development agents, off for others until that switch moves up. Reverting puts things back, and turning off that switch stops those actions immediately.
