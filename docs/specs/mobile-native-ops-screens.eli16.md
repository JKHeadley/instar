# Schedule, Promises and Machines on the phone, natively — the plain version

## What this is

Justin asked for the Instar iPhone app to do everything itself instead of opening web pages. Right now, if he wants to know "did my scheduled jobs run?", "what have I been promised?", or "are all my machines up?", the app has to open the web dashboard and ask for a PIN. This change adds three native phone screens for those three questions, and the small amount of server work they need.

## What already exists

A paired phone proves who it is on every request with a key that never leaves the phone. The agent's server keeps a short list of the things a phone is allowed to ask for (the "allowlist"). Health is on that list already. The full job list, the full promise list and the machine list are not, because those answers contain things a phone has no reason to hold: the exact instructions each job runs, file paths, computer hostnames and internal settings.

## What is new

Three new read-only questions the phone can ask: "show me the schedule", "show me the promises" and "show me the machines". Each one answers with a cut-down summary built for the phone: job names, their schedules in plain words ("Every 5 minutes"), when each last ran and whether it worked, when it runs next, and whether it is late or failing; each promise's text, whether it is still open, when it is due and whether it is waiting on Justin; each machine's name, a plain status line ("unreachable, last heard 20 minutes ago"), how busy it is and which Instar version it runs. The health half reuses the health answer the phone can already read.

Late or failing jobs are listed first. Open promises are listed first, overdue ones at the top. Machines that are not answering are listed first.

## The safeguards, plainly

- **Only the owner's phone.** A phone paired for a helper (the "MSP" role) is told no. So is a phone that was revoked, a request that was not signed, or one that was changed after signing.
- **Nothing the console doesn't already show.** Each answer is built from a fixed list of fields. Job instructions, scripts, file paths, hostnames, tokens and settings are never included. Free text (job descriptions, promise wording) also goes through the agent's standard secret scrubber, and is shortened.
- **Look, don't touch.** Nothing on these screens can run, pause, close or rename anything. Those can come later, each with its own safety design.
- **No new background load.** The screens refresh when Justin pulls down, not on a timer, and the phone shares its existing request allowance.
- **Old servers fail plainly.** If the agent has not been updated yet, the screen says "Update the agent to see this here" instead of an error.

## What it covers across machines

The schedule merges every machine that answers (and names any machine that did not), promises include the ones other machines hold, and the machine list is the same one the console shows.

## What you need to decide

Nothing. This follows Justin's request directly, shows only what the console already shows the owner, and changes nothing if undone: reverting removes the three questions and the phone goes back to saying "update the agent".
