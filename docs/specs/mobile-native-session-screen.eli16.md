# Native session screen: the plain-English version

## What this is

Each chat with the agent is answered by a "session": a program running on one of your machines. The iPhone app has a button that shows that session. Today the button opens the web dashboard in Safari, which asks for the dashboard PIN and then shows the session's live screen. Justin asked for the app to show the session itself, natively, with no browser and no PIN.

## What already exists

- The phone, once paired, signs every request with a key that never leaves it. The server lets a signed phone call only a fixed list of routes.
- The server already has two routes that read a session's screen and type into it. Only the agent's own password (the "Bearer token") can reach them today. The PIN-unlocked dashboard uses the same kind of access.
- The app can already ask "which session answers this chat?"

## What is new

- The fixed list grows by two routes: read a session's screen, and type into it. Only the owner's phone may use them. A phone paired for another person (an MSP), a phone that was revoked or never confirmed, and any unsigned request are refused before anything runs.
- Typing has its own speed limit (12 a minute) and screen reading has its own (90 a minute), so they never use up the allowance the chat list needs.
- Only sessions the agent knows about on that machine can be read or typed into. If the session runs on another of your machines, the answer says so in plain words, naming the machine. Nothing is forwarded to the other machine.
- In the app: a session screen that shows the session's name, machine and start time, the live text (refreshed every 1.5 seconds while you look at it, paused when the app is in the background), and a box to type into. There is also a list of all the agent's sessions on the agent's page; tapping one opens the same screen.
- If the agent's server is too old to have the new routes, the screen offers a small "Open in dashboard" link instead.

## Safeguards

- It grants nothing the owner's PIN does not already grant: the dashboard already shows these screens and lets you type.
- No special keys (Esc, Ctrl-C), no closing or starting sessions, no files.
- Every request is signed over its exact address, time and body, so it cannot be replayed or edited.
- Undo is a plain revert; nothing is stored and no settings change.

## What you need to decide

Nothing. Justin asked for it (topic 134088, 2026-11-03), and the access stays within what his PIN already gives him.
