## What Changed

The check that proves only one file can talk to Telegram had already admitted, in its own header, that renaming the network call would defeat it. That gap is now closed.

- **Assigning the network call to a variable and calling the variable** was not recognised. The check's own documentation said so plainly and scoped its stated claim to match — honest, and still a hole in a door that carries the credential for the whole messaging channel.
- **It is now recognised**, followed through chains of assignment to a fixed point.
- **Done on the parsed structure of the file, not by matching text.** The file is already parsed, and a declaration whose value *is* the network call is unambiguous — searching for the text would also match a property with that name on an unrelated object.
- **The header's statement of limits is corrected.** It named this gap as open; three narrower ones are named in its place. Leaving the old wording would have left a false statement in the one place a reader looks to learn what the check is worth.
- **Nothing new is forbidden**, and the codebase passes cleanly before and after.

## What to Tell Your User

Everything sent to Telegram has to go through one file, which looks at the message before it goes out. A check proves nothing else can reach the network on a Telegram address.

It recognised that call written several ways, but not the simplest disguise: put it in a variable first. The check said so about itself, which is better than pretending otherwise, but it was still a way around a door that holds the messaging credential. It is closed now, and the three narrower ways still open are written down where the next reader will find them.

## Summary of New Capabilities

None. This widens what an existing check can see and corrects its written description of its own limits. No new command, route, setting, or rule.

## Evidence

The gap was not discovered by anyone — the check declared it, in two separate places, and both are corrected here rather than left stating something now false. Proven in both directions: with the resolution removed, three tests fail and six pass, and those six are exactly the four deliberate opposite-direction controls plus two tests that pin the remaining gaps as still open. Those controls matter more than usual because this check blocks work: an unrelated assignment is not absorbed, a property whose name merely differs is not absorbed, a file with no reference yields nothing, and the word itself as a piece of text is not a binding. The real codebase passes cleanly before and after, source restored byte-identical after the check, and the module is now safe to import — it previously had four exit paths and no guard, so importing it in a test would have stopped the test run the moment the codebase had a violation.
