# Accept all projects: say what is happening, and never sit greyed out (plain overview)

**What happened.** On the dashboard, Conversations has a "Review suggestions" page with an "Accept all 21 projects" button on top and one card per suggestion below. On 2026-11-16 at 16:23 Justin tapped Accept all. The button went grey and stayed grey. Nothing near it said anything, and the list did not change. His words: "Either this is frozen or we have really bad UX for this process."

**Why.** Accept all works through the projects one at a time. Each project takes several steps (create the effort, name it, move its conversation in, make that conversation the front door), and each step waits until the change is saved on every machine. The only progress words were written inside the card of the project being worked on. The project cards sit below eight other suggestions, so from the top of the page there was nothing to see. On that day the first project's "move" step also could not finish (a separate server fault, fixed separately), so the page waited a full minute in silence. And when one project could not finish, Accept all stopped there and never tried the other twenty.

**What changes.**
- A line right under the button says what is running: "Accepting 3 of 21: Project: Instar App. Moving conversation 1 of 1…".
- When a step takes more than a few seconds, the line says what it is waiting for and for how long: "Saved here. Waiting for Mac M5 Pro to confirm. (15 s)".
- One project that cannot finish no longer holds up the rest. Accept all goes on to the next project and reports at the end: "19 of 21 projects accepted. 2 did not finish; their cards say why. Tap Continue to try again."
- If two projects in a row are still waiting on the machines, it stops and says so, because going on would only wait again: "Stopped at 2 of 21: changes are not being confirmed right now. 0 of 21 accepted. Tap Continue to try again; nothing is lost."
- Whatever happens (a wait, a refusal, the unlock running out, an error in the page itself), the button comes back as "Continue accepting projects" with a plain line. It can no longer stay grey without words.
- A single card's Accept shows the same waiting words, and says "Starting…" at once.

**What stays the same.** The steps, their order, and the rule that each waits to be saved everywhere. Progress is still kept, so Continue picks up where it stopped and never creates a project twice.

**What is not in this change.** The server fault that kept the first project's move from finishing has its own fix (`graph-certified-delivery-resume`).

**Decision needed.** None: a dashboard-only change that a revert fully undoes.
