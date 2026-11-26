# Dashboard session badges: correct icon, tooltips and a legend (ELI16)

## What this is

Each session in the dashboard's Sessions list shows a row of small badges: a yellow "interactive" (or "job") label, a purple model name, a tiny icon, a green machine name, and how long the session has been running. The operator looked at the list and could not tell what the icons meant, and one of them was wrong.

## What was wrong

The tiny icon says where the conversation lives: a paper plane for Telegram, a computer screen for "no messaging app". Sessions running on the machine you are viewing the dashboard from all showed the screen, even when they were Telegram conversations. Sessions on other machines showed correctly.

The reason: the dashboard gets this machine's sessions over a live connection (a WebSocket) and other machines' sessions from a normal web request. The web request already worked out which messaging app each session belongs to. The live connection never did, so the dashboard fell back to the screen icon.

## What changes

1. The code that works out "which messaging app is this session linked to" moves into one small shared function. Both the web request and the live connection now use it, so they cannot disagree again.
2. Every badge gets a hover tooltip in plain words.
3. A "?" button next to the + in the Sessions header opens a short legend explaining every badge. It is a tap, so it works on a phone where hover does not exist.

## Safeguards

Nothing here makes a decision or blocks anything; it only changes what the dashboard displays. If the lookup fails for some reason, the session simply shows the old screen icon, exactly as before, and the list keeps working.

## What you need to decide

Nothing. This is a display fix and a legend.
