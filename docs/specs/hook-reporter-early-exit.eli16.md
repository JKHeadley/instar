# Stop waiting after every action — plain-English overview

## What this change is

Every time an Instar agent's Claude Code session uses a tool (runs a command, edits a file, reads something), a small script called the hook event reporter runs afterwards. It tells the agent's own server what just happened, which is how the agent can later resume that exact conversation and keep a few activity records. Claude Code waits for this script to finish before moving on.

The script sent its message and then always waited 50 thousandths of a second before quitting, even though the server usually replies in about 7. That wait happened after every single action an agent takes.

Now the script quits as soon as the server has replied. If the server is slow, it still quits after at most the same 50 thousandths of a second as before, so nothing can get slower.

## What it saves

Up to about 40 thousandths of a second per action. That's small for one action, but agents take thousands of actions a day.

## Safeguards

- The server still receives exactly the same information; the script only quits once the server has answered.
- New agents get the change when they're set up, and existing agents get it on their next update, because these built-in scripts are rewritten on every update. Tests check both paths.
- Undoing it is a one-commit revert.

## What a reader needs to decide

Nothing; this is a small efficiency fix to an internal script.
