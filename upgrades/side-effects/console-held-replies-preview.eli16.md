# Calmer Home, no failing PIN box, and a dashboard preview — in plain words

**What this changes.** Three things the operator hit on the new dashboard on 31 October 2026.

First, Home used to put "replies are held" in front of him. A held reply is a message the agent wrote that has not reached Telegram yet. Getting it delivered is the agent's job, not his, so Home no longer shows it and it never changes the big headline. The Messages page still lists delivery records for anyone who wants to look.

Second, the big headline used to be a count like "3 things need you." Now it is the first thing itself, and tapping it opens that item. If there are more, a short line says how many more are below. Urgent items come first.

Third, the PIN box. On a machine with remote desktop switched on, the server only accepts the PIN over a secure link or from the machine itself. The page used to show the box anyway and then fail. Now the page asks the server first. If the PIN would be refused, it explains why and offers a button to the secure address instead of a box.

**What is new.** A fixed preview address on the dashboard. It shows dashboard pages from a folder that belongs to the agent, not to the installed program, so an update can never overwrite it again (which is how the operator lost a preview that morning). The agent publishes work in progress there in seconds, without merging, and every preview screen carries a banner saying which work it is and when it was published. If nothing is published, the address says so plainly.

**Safeguards.** The PIN rule itself did not change; the page now just asks about it before showing a box. The preview only serves page files and uses the operator's own login like the normal dashboard. It is per machine.

**What to decide.** Nothing beyond the usual review. If any part is wrong, reverting the change undoes it.
