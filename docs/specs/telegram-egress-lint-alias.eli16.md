# The messaging-door guard closed the gap it had already admitted to

> The one-line version: the check that proves only one file can talk to Telegram said in its own header that renaming the network call would defeat it — and now it doesn't.

## The problem in one breath

All outgoing Telegram traffic must pass through a single file, which inspects what is being sent before sending it. A check proves nothing else reaches the network on a Telegram address.

It recognised the network call written several ways, but not one: assign the call to a variable first, then call the variable. Its own header said so plainly — that catching it "needs alias resolution this does not do" — and scoped its stated claim to match.

That honesty is unusual and worth keeping. It is also still a hole, in a door that carries the credential for the whole messaging channel.

## What already exists

- **One file** allowed to reach Telegram, which runs a visibility check before every send.
- **The check**, which already understood several ways of writing the call, including reaching it as a property and calling it indirectly through the standard indirection helpers.
- **A written statement of its own limits**, including this gap and two others.

## What this adds

**A network call assigned to a variable is now recognised**, followed through chains of assignment to a fixed point.

This is done on the parsed structure of the file rather than by matching text. The file is already parsed, and a declaration whose value *is* the network call is unambiguous — where searching for the text `= fetch` would also match a property with that name on some unrelated object.

**The header's statement of limits is corrected.** It said this was not covered; it now is, and three narrower things are named in its place: reassigning after declaration, receiving the call as a function argument, and importing a wrapper from another file. Leaving the old wording would have left a false statement in the one place a reader goes to learn what the check is worth.

## The safeguards

**Four tests push the other way**, and they matter more than usual because this check blocks work: an unrelated assignment is not absorbed, a property whose name merely differs is not absorbed, a file with no reference at all yields nothing, and the *word* "fetch" as a piece of text is not a binding. A resolver that absorbed every declaration would pass every test about catching the gap and flag correct code everywhere.

**Two tests pin the remaining gaps deliberately** — asserting they are *not* caught, so the boundary is documented rather than mistaken for an oversight. If someone closes them properly, those tests fail and get updated on purpose.

**Proven in both directions**: with the resolution removed, three tests fail and six pass — the six being those four controls and the two pinned gaps. The codebase passes cleanly before and after.
