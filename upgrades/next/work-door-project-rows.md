# Project rows that say something

<!-- bump: patch -->

## What Changed

Each project on the Work door now says what the Chief of Staff knows: its latest report on the project, why it is waiting on you, when it is next checked, why it stopped retrying, and each done item in words ("Passes", "Waiting for you to check", "Checked by you"). The phone gets four actions on a project: Ask for an update (the Chief of Staff checks it now, or on its next round), Pause and Resume, Mark checked on an item only you can judge, and Finish. The last three need Face ID on the owner's phone; the agent cannot do them for you.

Routes: `POST /work/projects/check` (bearer) and `POST /mobile/work/projects/check` (owner phone); `POST /mobile/work/projects/pause`, `/done-item` and `/finish` (owner phone, Face ID, challenge actions `project-pause`, `project-item-check`, `project-finish`). The read's new fields are additive.

## What to Tell Your User

- **Projects tell you what is happening**: "Each project on the Work page now shows my latest report, what it needs from you, and when I'll check it next."
- **You can act from your phone**: "You can ask me to check a project right now, pause it, tick off the items only you can judge, and finish it, each with one tap and Face ID."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Ask for an update on a project | `POST /work/projects/check {key}`, or the button on the project's row in the app |
| Pause / Resume, Mark checked, Finish from the phone | Buttons on the project's row in the Instar app (Face ID) |
