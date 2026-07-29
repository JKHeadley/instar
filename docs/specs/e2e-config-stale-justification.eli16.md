# A note in the code that had quietly stopped being true

## The situation

There are two ways this project runs its tests. One of them compiles the program first; the
other deliberately doesn't, because compiling takes time and it isn't needed there.

Sitting next to that second setting was a note explaining the decision. It said, roughly:
*don't add a compile step here, because it would wake up some sleeping tests — and one of
them tries to use a tool the test machine doesn't have installed.*

That was a good reason. It just isn't true any more, in two separate ways.

## What changed underneath it

**The missing tool is no longer a problem.** Earlier in the same working session, that exact
tool dependency was fixed — the test now uses whichever package manager the machine
actually has, and it finishes cleanly on a machine without the original one. So the
obstacle the note warned about has been removed.

**And the tests aren't sleeping.** The *other* test setup — the one that runs on every
change — does compile the program, and it does include those tests. They run there, and
they do real work: I ran one and watched it take about half a second per case rather than
returning instantly.

So the note was describing a world that no longer exists. Anyone reading it while deciding
whether to change that setting would have been talked out of it for reasons that had
expired.

## What this changes

Nothing that runs. This is a comment, and only a comment — the settings themselves are
untouched, byte for byte. The tests still skip in the fast setup and still run in the
thorough one, exactly as before.

What changes is that the explanation now says the reason that actually still applies —
compiling costs time and the coverage already exists elsewhere — instead of a reason that
had quietly expired.

## Why bother

Because this is a small version of the thing that cost real time to find during this
session: something that describes a state of the world, kept reporting confidently after
the world moved. A stale note is a check on human judgement whose condition stopped holding
without anyone noticing. It doesn't fail loudly — it just gives the next person a confident
wrong answer.

The person most likely to be misled by it was the next one to ask "should we compile in the
fast setup too?" — a reasonable question, which the old note answered with a hazard that no
longer exists.
