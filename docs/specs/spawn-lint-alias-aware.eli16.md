# The runaway-process guard could be walked past by renaming an import

> The one-line version: the check that stops an uncapped AI process being created outside its safety limit looked for the class by name, so writing `import { X as Y }` and then using `Y` made a real violation invisible.

## The problem in one breath

In June this system spawned somewhere between 230 and 289 AI processes at once and ran the machine out of memory. The fix was a hard limit on how many can exist simultaneously, plus a check that refuses any construction of a process-spawning class outside the limited path.

That check finds its targets by matching the class name as literal text. Two entirely ordinary ways of importing a class defeat it:

- rename it on import and use the new name;
- import the whole module and reach the class through it.

Either produces a real, uncapped construction that the check cannot see. Nothing is broken today — the check reports the codebase clean, and it genuinely is — but the guard has a hole the moment someone writes ordinary code.

## What already exists

- **The limit itself**, a counter shared across every process on the machine, which makes new spawns wait and then shed rather than pile up.
- **The single approved path** for building one of these, where the limit is installed.
- **This check**, in the standard set that runs before every commit and in continuous integration, with a closed list of places allowed to bypass the approved path.

## What this adds

**The check now works out every local name the class is bound to in a file before looking for constructions**, and separately recognises the module-qualified form. Renaming on import no longer hides anything.

**The detection is now a separate, importable function**, so it can be tested directly with fixtures rather than only by running the whole check over the whole codebase.

**The command body is guarded so importing it does not run it.** Without that, importing the detector in a test would run the check — and because it stops the process when it finds a violation, a single real violation would have killed the test run rather than reporting a failure.

## The safeguards

**Four tests in the opposite direction**, and they are the point. An import on its own is not a construction. A comment mentioning the class is not a construction. A differently-named class is not flagged. A plain variable sharing the name is not flagged. Without these, a detector that flagged everything would pass every test about catching bypasses and be useless on a healthy codebase.

**Proven against the old behaviour.** Restricted back to name-only matching, five tests fail and six still pass — the six being the plain case and the four opposite-direction controls. That is what makes them guards rather than echoes of the change.

**No new rule.** The same constructions are forbidden as before; more of them are now visible. The codebase passes cleanly both before and after, so this adds no work to anyone today.

## Why this one first

A peer agent's audit found twenty-five checks with this same weakness. This one was taken first because it guards a safety limit rather than a convention, and because the failure it prevents has already happened once.
