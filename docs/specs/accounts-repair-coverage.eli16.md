# Accounts keeps slow machines visible

When you open Accounts to turn on automatic sign-in repair, the dashboard asks each machine for its settings. A slow machine can miss the first deadline. Before this change, a machine omitted from the pooled results could be missing from the review, even when the dashboard knew it was part of your group. The button could still offer to turn repair on for the machines that answered.

The Accounts page now gives a timed-out machine one more chance to answer, with a longer deadline. If it still cannot confirm the settings, the machine stays visible with a Still checking message and a Retry button. Retry checks the settings again and keeps the machines you already ticked. The turn-on button stays disabled until Accounts has checked every machine. A machine that answers successfully and has no accounts still counts as checked.

No setting changes when Accounts checks or retries. Once the checks finish, turning repair on still uses the existing PIN approval and checks that each selected machine's settings have stayed current. Switching repair back to asking first keeps its existing behavior.
