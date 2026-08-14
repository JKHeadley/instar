## What Changed

After hardening the runaway-process guard against renamed imports this morning, a second agent was asked to break it — and got past it twice more.

- **Assigning the class to a variable and building from the variable** slipped through. That is probably the simplest bypass anyone could write, and it was not anticipated.
- **Reaching the class out of a module with bracket notation** instead of a dot also slipped through.
- **Both are now recognised.** Variable assignments are followed to a fixed point, so passing the class along several times cannot walk out of the set.
- **The written statement of what the guard still misses has been corrected.** It named one kind of gap; there were three. Two of them were inside the ground the earlier fix implied was covered, so leaving that statement unchanged would have left a claim on record narrower than the truth.
- **No new work.** The same constructions are forbidden as before, the codebase passes cleanly before and after.

## What to Tell Your User

This morning's fix made the guard understand renamed imports. It was then attacked on purpose, and two more ways past turned up — both of them ordinary code, both inside a single file, which is exactly what that fix claimed to have handled.

Those are closed. Three ways past remain, all involving a class passed onward through several modules; closing those needs the check to follow symbols across files, which it does not do. That limit is now written down and pinned by a test, so nobody later mistakes it for an oversight.

Worth noting how this was found: not by re-reading the fix, but by asking someone else to break it and telling them plainly that finding a hole would be more useful than a clean report. A review that can only confirm is not a review.

## Summary of New Capabilities

None. This widens what an existing check can see and corrects a written claim about its limits. No new command, route, setting, or rule.

## Evidence

The two bypasses are the reviewer's own snippets, reproduced verbatim as tests. Proven in both directions: reverting both additions fails four tests while thirteen still pass — those thirteen including all six deliberate opposite-direction controls and a test that pins the remaining cross-module gap as still open. Among the controls is a new one specifically for this change: assigning an unrelated symbol to a variable and building from it is not flagged, because a rule that treated every variable as suspicious would pass every bypass test and fail on ordinary code. The real codebase passes cleanly before and after; source restored byte-identical after the check.
