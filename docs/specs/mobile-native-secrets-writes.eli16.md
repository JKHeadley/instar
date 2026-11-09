# Asking for a key from the phone: plain overview

The iPhone app can already show what passwords and keys the agent is waiting for. It can't yet do anything about them: asking someone for a key, or cancelling a request, still happens in the web console. This change moves those two actions into the app.

Asking for a key makes a one-time link. Whoever opens the link can type the password or key, and it goes straight to the agent, never through chat. That link is powerful, so the phone never receives it. After you ask from the app, the request shows on the screen, and the app sends you to the console to copy or share the link. That's one extra step, chosen on purpose, because it keeps the link out of the phone's stored answers.

Both actions need Face ID every time. They use exactly the same checks as approving a permission slip from the phone: only the owner's phone, over a safe connection, with a fresh one-time challenge tied to that exact action, so a recorded request can't be replayed or changed. If someone pastes what looks like a real key into the name box, the app refuses, so a key doesn't end up stored as a label. Asking twice for the same thing is refused too, so a double tap can't make two links.

A request lives on one machine, so you can only cancel requests on the machine you're connected to. Requests on other machines stay visible but read-only.

It sits behind the existing switch for phone permission changes: on for Echo, off for other agents until that switch is promoted. What you need to decide: nothing. Turning that switch off, or reverting, puts things back as they were, and any requests already made expire within the hour.
