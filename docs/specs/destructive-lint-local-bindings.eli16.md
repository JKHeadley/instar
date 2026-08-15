# ELI16 — the delete-guard you could switch off by shortening a name

## What it protects

Deleting files is the one thing the agent cannot undo. So every destructive
filesystem or git operation has to go through a single pair of modules that
record what was deleted and why. That record is the whole point: if something
disappears, there is a trail.

A build check enforces it. Call a delete directly instead of going through the
funnel and the build fails.

## What was wrong

**One line of ordinary tidying switched it off for a whole file.**

```ts
const fsp = fs.promises;
await fsp.rm(p, { recursive: true, force: true });   // build passed
```

Written out in full — `fs.promises.rm(p, …)` — that same delete is caught.
Giving the thing a shorter name made it invisible. Nobody writing that is trying
to get around anything; aliasing a namespace is one of the most ordinary things
in JavaScript. That is exactly what makes it worth fixing: the gap does not need
an attacker, only a tidy afternoon.

Three more plain forms did the same: pulling the delete function itself into a
name, destructuring it out with a rename, and reaching it through a type
assertion — which is erased before the code ever runs, so it changes nothing
except whether the check can see it.

I measured all of these against the shipped check before changing anything, with
a plain unaliased delete running in the same pass as a control. Without that
control, "nothing was flagged" and "the check did not run" look identical — a
distinction that mattered more than I expected, as the next section shows.

## Why it was surprising

This check is one of the better-built ones in the codebase. It parses the code
properly rather than pattern-matching text, and that already buys it real
resolution — it catches an import that has been renamed on the way in, which the
text-matching checks cannot do.

The gap was narrower than "it doesn't understand names". It understood names
arriving from *imports* and nothing about names created *locally*. So the fix
feeds the existing rules better information rather than adding new rules beside
them.

## The second thing, which I found by accident

Halfway through, I ran the check in a fresh copy of the repo that had not had its
dependencies installed. Every single file failed to parse — and the check
reported **clean** and exited successfully, because a parse failure was treated
as a soft warning. The only sign was some text on the error stream that a build
log buries.

That soft-warning behaviour is deliberate and mostly right: one file the parser
dislikes should not fail everybody's build. But there is a difference between
*one* file failing and *every* file failing. The second one means nothing was
inspected at all, and "no problems found" is then a statement about a search that
never happened.

So: if a run scans files and not one of them parses, it now refuses to report
success and says why.

**And I got the first version of that wrong, which CI caught.** I made it report
failure using the same signal as "I found a problem" — and three tests went red,
because one of them copies the build machinery into a bare temporary folder with
no dependencies installed and runs it there. My reasoning had been "no real
checkout can hit this", and a test fixture is not a real checkout. The machinery
already knew the difference between a check that *failed to run* and a check that
*found something*; I was sending one down the other's channel. It now reports
"could not look" distinctly, and the surrounding machinery treats that as a
warning rather than a blocked push.

## Why it won't start failing builds it shouldn't

This check blocks commits, so wrongly flagging good code costs more than the gap
it closes — a noisy check gets switched off, and then it protects nothing. Five
things are deliberate, each with a test that passes under *both* the old and new
versions:

1. **A non-destructive call is fine.** Reading a file is not deleting one.
2. **A shortened name used for something harmless is fine** — the shortcut is not
   the problem, the delete is.
3. **Creating a directory through that same shortcut is fine.** Creating is not
   deleting.
4. **An unrelated object that happens to use the same words is fine.** Resolution
   is anchored to the real filesystem module, never to a method name.
5. **A name that is never actually called is fine.** Holding a reference is not
   performing an operation.

Against the real codebase the check reports clean both before and after this
change, so nothing that exists today is newly blocked.

## The bit I liked

My own test needed to delete its temporary directory when it finished — which is
exactly the thing this check forbids. Rather than adding the file to the
exemption list, I routed that cleanup through the funnel like everything else.
The test that argues for the rule now follows it, and costs one audit entry per
run.

## How you know it works

The tests were written first and run against the old behaviour: **seven of the
sixteen fail** without this change. The other nine pass either way — three
confirming the forms it already caught still fire, five holding the line against
flagging good code, and one proving the new refusal fires on "nothing parsed"
rather than on "a file was scanned".

## What it still can't see

Names that cross a file boundary, or are assembled while the program runs, still
need real whole-program analysis rather than reading one file at a time. Guessing
at those would flag correct code, which is the expensive direction.
