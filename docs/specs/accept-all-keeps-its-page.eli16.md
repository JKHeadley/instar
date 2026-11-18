# Accept all keeps its page when the unlock runs out (plain overview)

**What happened.** On 2026-11-16 at 20:33 Justin tried "Accept all 21 projects" again. It felt slow, and tapping the button seemed to make the page reload: it went back to "Loading suggestions..." and the button looked new again. Nothing was accepted.

**Why.** Two things together. First, the server was slow: every Conversations read took 3 to 9 seconds (fixed separately on the server). So Accept all, which makes about 150 reads for 21 projects, takes a long time. Second, the dashboard unlock (your PIN) lasts 15 minutes, and when it runs out the page wipes itself for privacy. A long Accept all ran into that: the page went blank to "Unlock", and after the PIN it loaded the list again from the start, with the button reset. From the outside that looks exactly like "the button just reloads the page".

**What changes.**
- Before Accept all starts, if your unlock has less than 10 minutes left, a small PIN box opens on top of the page. Before each project, the same if less than 5 minutes are left. The list, the progress line and the work underneath stay where they are.
- If you close that box, the page says so plainly ("Accept all did not start: it needs your PIN.") and the button works again.
- If a project is already part-way, the button says "Continue accepting projects", not "Accept all 21 projects".
- A slow list says "Still loading suggestions. Your agent is busy; this can take up to 20 seconds." A list that fails to load has a "Try again" button.

**What stays the same.** The unlock still lasts 15 minutes and still wipes the page when it runs out; the server still checks every request.

**Decision needed.** None: a dashboard-only change that a revert fully undoes.
