# Always available, part 1: the agent never runs twice (ELI16)

## What was wrong

"Always available" lets an agent start when the Mac starts, even before anyone logs in. To do that, the Instar app installs a small system service that runs the agent. But Instar already has several helpers that start the agent at login, restart it if it looks stopped, or reinstall its start item after an update. If any of them did their usual job while the system service was running, two copies of the same agent would fight over the same files.

## What changed

When the system service runs an agent, the Mac app leaves a note in a protected system folder. Now every one of those helpers reads that note first. While it says the system service is in charge, they leave the agent's usual start item alone. Updates still refresh the agent's start-up file, which the system service uses too. If the note is damaged or can't be read, the helpers assume the system service is in charge, because two copies is the worse mistake.

## What comes next

The commands for the Claude sign-in that a before-login agent needs, and the Mac app's switch and helper.
