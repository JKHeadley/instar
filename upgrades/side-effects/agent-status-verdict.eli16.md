# An agent that answers says how it's doing, not "can't tell" — plain-English overview

**What this is.** The Instar app's Fleet screen showed most of Justin's agents as "Can't tell" on 2026-11-07. Echo, for example, answered its health check in a fraction of a second. The cause: when an agent had even one problem it hadn't sorted into "affects you" or "internal", it reported its overall state as "unsure", and the app showed "unsure" as a grey "Can't tell". A healthy, answering agent looked unknown.

**What changes on the agent.**
- Unsorted problems are now notes. The agent says it is running and how many notes it has ("Running, with 2 notes I haven't sorted yet."), and the dot stays green.
- Only a problem that actually affects the person turns it to "degraded", as before.
- "Unsure" is now kept for the one honest case: the agent answered but couldn't read its own health, for example because the reading timed out. Then it says why.
- The dashboard's Health page shows the same thing, and treats an older agent's "unsure" with nothing affecting you as running.

**What changes in the app (a separate app change).**
- Grey "Can't tell" now only appears when the app got no answer at all. It then says since when and why ("Not answering since 1:13 PM: its machine didn't answer.") and offers Retry.
- Every row says when the app last heard from that agent, so an old reading never looks live.
- An agent on an older server that still says "unsure" for unsorted notes shows as "Running · 2 notes".

**Safeguards.** Nothing is hidden. Notes are still listed and counted, an agent with notes is never shown as "Healthy", and anything that affects you still raises the dot.

**What you need to decide.** Nothing. It is a small, reversible change to how status is labelled.
