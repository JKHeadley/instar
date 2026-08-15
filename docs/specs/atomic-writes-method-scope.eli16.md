# ELI16 — the safety check that could not fail on its own subject

## What it protects

When the agent saves state — your sessions, your relationships, your quota counters — it must not
write straight over the existing file. If the process dies halfway through, you are left with half a
file, and half a JSON file is worse than no file: it parses as garbage or not at all.

The safe pattern is to write to a temporary file first and then rename it into place. Renaming is
atomic on every filesystem we run on: either the old file is there or the new one is, never a
half-written mixture.

There is a test whose entire job is to prove the modules that save state actually do that.

## What was wrong

It could not detect the thing it exists to detect.

I did not argue this from reading the code — I measured it. I inserted a genuinely unsafe write of
real session state into `saveSession`, which is one of the exact methods the test names, in one of
the exact files it names. **All twenty-one of its assertions passed.**

Three separate causes, each of which would have been enough on its own:

**1. It was looking at almost none of the file.** The test tried to track "am I inside a save method
right now" with a flag that got switched ON when a method's name appeared on a line — and never got
switched off. Its two findings (did I see a write? did I see a rename?) were reset every time a name
appeared. So by the time it checked its answer at the end, the answer only described the stretch of
file after the *last* mention of any method name. In the biggest file that is 125 lines out of 617 —
**twenty percent** — leaving three of its four named methods completely unexamined.

**2. Two of its checks were "does this word appear anywhere in the file".** One `renameSync` anywhere
satisfied it, no matter how many unsafe writes sat elsewhere. The same for the `.tmp` check — and
neither excluded comments, so a comment mentioning the safe pattern satisfied a check about whether
the code performed it.

**3. A method that no longer existed produced silence.** If a declared method had been renamed, its
name simply never appeared, the flag never flipped, and nothing was checked — with no complaint. A
missing *file* was skipped outright with a green tick.

## What that third one immediately turned up

Switching "missing means failure" on found two stale declarations straight away: **`saveState` has
zero occurrences in either `StateManager` or `QuotaTracker`.** Both were renamed at some point. So
two of the ten declared method entries have been pointing at nothing, quietly, for however long.

QuotaTracker's real writer is `updateState`, and it does the safe thing correctly. It had simply
never been verified by this test.

## The part that made the fix harder than it looks

The obvious fix — "check each method's own body for a write and a rename" — would have **failed on
the best-written module in the set.**

`StateManager` doesn't write files in its save methods at all. It sends every write through one
private helper that does the temp-then-rename properly, in one place. That is exactly the pattern
this codebase argues for everywhere else. Under a naive per-method rule its methods contain no write
at all, so they would pass for the wrong reason — or, if I demanded a rename in each body, fail for
being well written.

So the check now follows one step of that delegation: if a method hands off to a helper in the same
file, the *helper* is what gets verified. Which means `StateManager`'s writes are now genuinely
checked, where before nothing checked them.

## How you know it works

Both directions, against the same code, in the same checkout — not one run in one place and another
run somewhere else:

| the check | against an unsafe write inserted into a declared method |
|---|---|
| the old one | **21 of 21 passed** |
| the new one | **fails**, naming the file, the method, the deciding body and the line |

The source file was restored byte-for-byte afterwards, verified by checksum.

Eighteen more tests pin the parts. Six describe writes the old version could not see. Six are
controls that pass under *both* versions — a correct delegation to a real helper, a proper
temp-then-rename, a method that legitimately writes nothing, a commented-out write, a *call* to a
method rather than its declaration, and a duplicate declaration where the unsafe one must win rather
than the tidy one. Those six matter more than the six that fail: a rule that flagged good code would
fail builds on exemplary work, which costs more than the gap it closes.

## What it still does not cover, stated plainly

**The list of modules is hand-written and has seven entries.** Hundreds of files under the source
tree write files, and this test says nothing whatsoever about any of them. Widening that list is real
work with real risk of flagging correct code, and it is deliberately **not** done here.

Delegation is followed one step, within one file. A helper that calls another helper, or one imported
from elsewhere, is not resolved — that needs real symbol analysis rather than reading text.

And to be clear about what this is and is not: **the actual code is safe.** Every module the check
now examines does the right thing, including through the helper. This fixes a weak instrument, not a
live corruption bug, and I would rather say so than let a good headline stand.
