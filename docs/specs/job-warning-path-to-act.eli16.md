# Job warnings that say why and link to the fix — plain-English overview

Instar watches its scheduled jobs. When a job seems to have stopped running, it sends the operator a warning. On 2026-11-11 Justin got two of these on his phone from Luna, the Sage Mind agent. They read "Scheduled job ... is not running as expected ... Check its gate, machine scope and last successful run." There was no link, and the text asked him to investigate machine internals himself. His rule, repeated many times: any notice that says something is wrong must carry a direct path to fix it.

Looking closer, the warning was also wrong. The job "Notes to Luna on the admin Tasks tab" checks every five minutes whether anyone left Luna a note, and starts work only when there is one. Most checks find nothing, and the job's start check says so by answering "no". Instar counted three "no" answers in a row as the job being broken, and warned about once a day. A job working as designed was reported as failing.

What changes:
- A start check that answers "nothing to do" now counts as a healthy check. Only a start check that crashes, times out or returns an unexpected answer still counts as a problem.
- When a warning is real, it says why in plain words (for example, "the check that decides whether it should run has failed 3 times in a row") and links straight to that job's page in the dashboard. That page shows the job's recent runs, its skips and a Run now button.
- If the dashboard's public link is not up yet, the warning waits a few minutes for it rather than going out with no link.

A second fix came from the same screenshot. Justin tapped "ask the agent" about a security warning in the app, and the message failed with "This agent has no Telegram owner to speak as." Luna was set up without the setting that names its owner, though Instar already knows exactly one verified operator for it: Justin. The app now uses that verified operator, the same check Instar already uses for owner-only buttons, so his message goes through. An agent with no verified operator still refuses, as before.

What the operator needs to do: nothing. Fewer false warnings arrive, and each real one comes with a link.
