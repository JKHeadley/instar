# The guard I shipped this morning was blind to renaming

> The one-line version: a check written to catch a missing argument matched the class by its *name*, so two places that import it under a different name were invisible to it — including one feeding the component that decides where work runs.

## The problem in one breath

Earlier today a check was added that reads the source and fails if any construction of a particular class forgets a required argument. It passed. It was also wrong.

It looked for the class by the literal text of its name. Two places in the codebase import that class and immediately rename it locally — a perfectly ordinary thing to do — and construct it under the new name. The check never saw them. Both omit the argument.

So the guard reported "every construction supplies it" while two did not. A check that matches a name as text is blind to renaming, which is the same shape of fault it was written to catch.

## What already exists

- **The class** answers "does this conversation have a live session right now?" via an optional helper. When the helper is absent the answer defaults to "no" for everything, and an omitted argument is indistinguishable from a genuinely quiet system.
- **Two constructions were fixed today** — one supplied a broken helper, the other supplied none.
- **The check** added alongside the second fix, to stop a third place forgetting.

## What this adds

**The check now resolves every local name the class is bound to**, then looks for constructions under each. Renaming it on import no longer hides a construction site.

**The two hidden sites are wired.** One matters immediately: it feeds a read named "active conversations on this machine" into the component that decides where work should run — so that component could never see an active conversation. The other reads only a conversation's focus today and does not consume the live flag, but it is wired anyway, because leaving it unwired means a future reader of that field silently inherits a wrong answer.

## How this was found

Not by me. A peer agent was given a bounded audit — find optional dependencies whose default is indistinguishable from a real answer — with a hard requirement to prove its search could actually find a known example before reporting any result. It resolved the class through the type system rather than matching its name as text, and found four construction sites where my check found two.

That method is better than mine, and the fix adopts the lesson rather than patching around it.

## The safeguards

**A test that would have failed before this change.** It constructs the class under a renamed import and asserts the check finds it. Run against yesterday's version of the check, it fails.

**The existing controls stay.** One proves the search finds constructions at all, one proves it detects a missing argument, one proves its scanner survives nested brackets and inline functions. A structural check that silently matched nothing would pass forever and prove nothing — which is precisely how the blind version passed.

**Failure stays safe.** Both newly-wired lookups fall back to "not running" if they throw, which is the same value the missing argument produced. A hint about where work is running must never break the thing reading it.
