# The spawn-funnel guard could be walked past by renaming its target

> The one-line version: the check that keeps every background subprocess going through one door only knew the door's name — so anyone who put a second nameplate on it walked straight past.

## The problem in one breath

Every headless subprocess this agent spawns is supposed to go through a single function. That funnel is where the resource and control decisions live — including the one that keeps those spawns off a metered credit pot that fails hard when it drains.

A check enforces it, by refusing any file outside a short closed list to mention the builder's name.

Mentioning the name is not the only way to reach it. A file on the list could hand the same function out under a different name, and any file could then call *that* — no forbidden name anywhere, and a real non-funnel spawn path.

This was not a theory. Adding one line to a listed file and calling the new name from another left a working bypass in the real codebase while the check printed **clean**.

## What already exists

- **One funnel**, where the spawn decision is made.
- **A closed list** of four files allowed to name the builder — the definition, the funnel, one deliberately-isolated path, and the check itself.
- **A rule** that treats even importing the name as a violation, because there is no legitimate consumer outside the funnel.

## What this adds

**The check now follows the function, not just its name.**

Two halves. *Inside a file*, a name that has been passed along — imported under a new label, pulled out of a bundle, copied to another variable, reached through a bracket with the text split in half — is followed until nothing new turns up. *Across files*, the short closed list is read to find any name it hands out that leads back to the builder, and those names are then guarded wherever they are imported.

That second half is what makes it work: the list is closed and small, so reading it is cheap, and a name can only be minted there.

## The safeguard that mattered more than the fix

This check refuses commits. A version that flagged correct code would be switched off within a day, which is worse than the hole.

So the widening is deliberately narrow. Only a plain re-labelling or a one-line pass-through counts as handing the function out. A listed file that does *real work* around the builder is not — because that is exactly what the funnel itself looks like, and counting it would flag every ordinary spawn in the codebase.

Ten tests push the other way: a comment is not a call, a similar-looking name is not the same name, an unrelated copy is not absorbed, a locally-written function that happens to share a name is not the funnel's, the same name from an unrelated file is not either, and the real funnel is not mistaken for a handout.

## How it was checked

Proven in both directions, and one direction corrected the other. Removing the cross-file half fails exactly the cross-file tests. Deliberately widening the handout rule to "anything that touches the builder" fails exactly the control that guards against the flood.

Removing the text-splitting defence failed **nothing** — the first attempt at that test used a form that a different rule already caught, so it proved nothing about the line it was meant to cover. Rewritten to three forms with nothing else to catch them, it fails properly. A test that passes for the wrong reason is indistinguishable from coverage until something depends on it.

Four remaining gaps are named in the check's own header and pinned by tests asserting they are still open, so they read as decisions rather than oversights.

The real codebase passes cleanly before and after.
