# Review suggestions: stop the reload that cancelled Accept (plain overview)

**What happened.** On the dashboard, Conversations has a "Review suggestions" page. It lists groupings the agent suggests, such as one project per Chief of Staff effort, with an Accept button on each and an "Accept all projects" button on top. Justin tapped "Accept all 21 projects" from his phone. Two things went wrong: the list seemed to reload about every minute, and after the tap he still saw the same 21 suggestions.

**Why.** The dashboard redraws every page every 30 seconds so status pages stay fresh. Pages that manage their own updates can opt out, and pages hold the redraw while a form or sheet is open. The Conversations page never opted out. Each redraw started the page over, and starting over cancels whatever the previous drawing was doing. An Accept takes several steps (create the effort, name it, move each conversation, make it the project's front door), each waiting for the change to be saved, so it easily runs longer than 30 seconds. The redraw cancelled it quietly and showed the server's list again, which still held every suggestion.

**What changes.** The suggestions view now opts out of the 30-second redraw; it already has its own Refresh button. And while any Accept is running, its card tells the dashboard "hold the redraw" until it ends. The other Conversations views keep refreshing as before.

**What stays the same.** Accept still does the same owner steps in the same order. If the unlock (PIN) lapses, the page still hides private content at once and asks to unlock; progress is kept and Continue picks it up. If another machine has not confirmed a step, the card says which machine and offers Continue.

**What is not fixed here.** On 2026-11-16 the Studio could not get its conversation records confirmed by the mac-lan machine (filed separately as fb-a720de02-a00). Until that is fixed, Accept may pause with "Waiting for mac-lan to confirm"; the difference is that it now says so instead of vanishing.

**Decision needed.** None: a small dashboard fix that a revert fully undoes.
