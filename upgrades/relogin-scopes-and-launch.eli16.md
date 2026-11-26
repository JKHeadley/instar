# Two fixes from real repairs on the Laptop and Mini — plain-English version

When a sign-in repair reaches Claude's "Authorize" page, it checks what Claude is asking permission for and only approves what it's allowed to. That allowed list was empty unless someone set it up by hand. I had set it on the Studio earlier, so the Studio worked, but the Laptop and Mini (and every other agent) had nothing. The first real repair on the Laptop stopped at Authorize for exactly that reason.

The fix: when no list is set, the repair allows exactly what our own Claude sign-in command asked for in the link it printed. That is the same thing a person approves when they sign in by hand. If the page ever asks for more than that, the repair still stops and asks a person.

The second fix is about the Mac Mini, where Chrome didn't come up within 10 seconds on any of three tries. Chrome now gets at least 30 seconds, and when it still doesn't come up the repair records which step failed: Chrome never started at all, Chrome started but didn't answer, or Chrome answered but the page never loaded. Each points to a different fix.

Nothing needs deciding.
