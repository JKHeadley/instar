## What Changed

The check that stops any code but the funnel from creating Telegram topics was matching on a *phrase*, so ordinary renaming walked past it. Topic creation is the chokepoint the notification-flood ceiling depends on, so a defeated check there means an unbounded flood of new topics.

- **Eleven disguises were run against the shipped check first. Ten evaded it** — putting the call in a variable, splitting the method name across a `+`, hoisting it into a constant, putting the argument on its own line (the check read one line at a time), importing the call under another name, and five more.
- **The question moved.** Instead of "is this written the way I expect?", the check now asks "does this file name the raw Telegram method at all?" — resolved through constants, concatenations and template literals back to where the value came from. The spelling of the thing you send it through stops mattering, because the method's name has to appear for the call to reach Telegram.
- **The eleventh disguise was already caught** and is claimed as nothing; it is kept as a regression test.
- **One piece of correct code was newly flagged, and is recorded rather than smoothed over:** another lint keeps a list of watched words that includes this method name. It is a word list, not a callsite, in a file with no network reach — it is on the exceptions list now with that reason written beside it. The exceptions list grew by one entry, which is the honest price of the broader question.
- **The check now flags fewer comments, not more.** The old rules failed the build on a comment that merely mentioned the pattern; that is fixed, and both halves are pinned by tests.
- **The codebase passes cleanly before and after.**

## What to Tell Your User

Instar can create Telegram topics, and three separate times a feature created them in a loop and buried the operator. The fix was a ceiling: one function is allowed to make topics, it counts them, and it refuses past a budget. A check proves nothing reaches around it.

That check was looking for a particular phrase — which really means it was asking "did you write it the way I expect?" Ten easy ways of writing the same call walked past it. It now asks a question that has no spellings, so the disguises collapse into one case.

Nothing new is forbidden for correct code. Calling the funnel, listing the method name in a lookup table, or mentioning it in a comment are all still fine — thirteen tests exist specifically to keep it that way, because a check that blocks commits does more damage by flagging good work than by missing something.

## Summary of New Capabilities

None. This widens what an existing check can see and adds one justified exception. No new command, route, setting, or rule.

## Evidence

All eleven disguises were executed against the real, shipped check before anything was written — ten returned "clean", which is the whole problem. The evasion is proven inside the test suite rather than asserted in a comment: the three old rules are reproduced verbatim in the test file, and every disguise asserts that the old rules missed it *and* the new one catches it, so the "before" is visible without checking out the old version. 47 tests pass, 13 of them deliberately pushing the other way, plus 4 that pin the remaining gaps as still open — the funnel call, a re-bound funnel, a property-key lookup table, a string-literal type, comments, three other Telegram methods, prose mentioning the name, and a file with no reference at all. The real codebase lints clean before and after, and the module is now safe to import: it previously had no import guard, so pulling it into a test would have stopped the run the moment the codebase had a violation.

A negative control corrected the write-up rather than confirming it: strip out the part that follows a name back through constants and concatenations, and 8 of the 10 disguises are *still* caught while every control stays clean. So the fix is the change of question, not the machinery — the machinery earns its place on two specific disguises (a name split across a `+`, and a URL whose base is a variable) and on pointing at the right line for the rest. Claiming otherwise would have been the more flattering story.

What is still open is written into the check's own header: a method name assembled while the program runs, a name imported from another file, computed access on the name (deliberately allowed, because the funnel shares that name and flagging it would break correct code), and shell variables assembled across lines.
