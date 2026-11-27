# Keep inherited main changes out of a repaired branch's push check

When a branch merges the latest main, the push check needs to look at what that branch adds. A branch can have two local references that follow the same main branch. If one was fetched earlier, it can make the push check count changes main already contains.

That happened when a repaired branch merged the Gemini test change. The Gemini release note had already been accepted on main. A stale reference made the check pair that note with five runtime files from the repaired branch, so the correct release note on the repaired branch could not clear the check.

The gate now advances to the newer reference when both names track the same remote and Git confirms that the newer commit descends from the older one. It takes the exact commit from Git and uses that same commit for all the comparisons. The regression tests confirm that an inherited note is accepted, a branch's own internal-only note is still refused beside runtime changes, and a local branch with a similar name cannot affect the decision. If the local main is still stale, fetching main remains the remedy.
