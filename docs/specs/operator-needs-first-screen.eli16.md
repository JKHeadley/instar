# Anything that needs the operator is on the first screen, counted, and linked

**What this is, in plain English.** The operator was hunting for a button. Automatic merging had stopped and nothing on the dashboard's home page said so; the button to turn it back on sat at the bottom of another page. We already had a written rule saying the main action must be visible on arrival, but the only thing enforcing it was the author's written promise when committing code, and that did not catch this.

**What already exists.** The rule itself. A home page card called "What needs you", which counts two things: the attention queue and promises. Pages with their own headlines. A gate that reads every message an agent sends to the operator, and can nudge the agent to rewrite.

**What is new.** Four things.

First, one list of every state that needs the operator: merging stopped, pull requests waiting for approval, feedback decisions, sign-ins, other agents waiting, permission approvals, plans waiting on them, passwords requested, spending controls. Each entry is built with the same code the page uses, so the home page and the page cannot disagree.

Second, the home page count and headline include everything on that list. If it says nothing needs you, then nothing on the list does. If a read failed, it says "that I can see" rather than claiming all clear.

Third, every page puts that state first, with its button in place, and page wording never says "below". A notice that names an action either offers it or opens on a click to show it.

Fourth, when an agent sends the operator to a page, the outgoing-message gate checks for three things: a direct link, the exact words the operator will see, and the agent's confirmation that it opened that page at the operator's screen size first. The first try comes back with a nudge saying what is missing; the agent opens the page and resends, or states why it could not.

**The safeguards.** A test renders each page in each of those states and fails the build if the need is not first, has no action, or is folded away, and the same test fails on deliberately bad examples, so we know it works. It also fails if a new page says "needs you" without being on the list or on the written exempt list with a reason. The message check is a nudge the agent can override with a stated reason, never a wall, so an agent on a machine with no browser can still send.

**What you need to decide.** Only the wording in the standards document, sent to the operator as an approve-or-change question. Two reach limits are worth knowing: a dashboard opened on another machine sees merging, approvals and password requests only for that machine, as those pages do today; and the screen-size half of the check is proved by hand in a real browser, because the automated tests have no browser. One choice is worth a look: pages whose problems are the agent's to handle, such as failed scheduled jobs, stay out of the count, keeping the home page's existing rule. Promises due more than a day away also stay out, as the operator decided on 2026-11-02.
