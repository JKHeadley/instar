# A check that failed and was then fixed stayed failed forever, and blocked recording the work

## What this actually is

When our project tracker records a piece of work as finished, it verifies the pull request itself —
including asking "were all the checks green?"

It could never answer yes for a pull request whose checks had ever been red, even after they were
fixed.

## The concrete case

Earlier tonight a pull request of mine failed one check: a gate requiring the description to carry a
plain-English summary under a specific heading. I had written the summary and omitted the heading.
I fixed the description, a fresh run of that check passed, and the pull request merged normally —
because the merge gate looks at the *current* state of each check.

The tracker does not. It asks the platform for the list of check runs and refuses if any of them
failed. And the platform returns **every** run, including the superseded ones. So that pull request
carries both entries, permanently:

```
eli16  FAILURE  01:43:52
eli16  SUCCESS  01:45:32
```

Four different checks on that one pull request had two entries each. The tracker saw the older
failure and refused to record work that had legitimately merged twenty minutes earlier.

## Why this is the same bug as the others

A superseded check run is a **stale symbol**. The check's actual current state is its latest run —
which is precisely what the platform's own merge gate uses, and precisely what we were not using.

So the recording path now has three separate instances of the same shape found in one evening:

1. it could not find the tool it needed, and reported that as a fact about the merge;
2. a safety guard refused a read, and that refusal was written down as "not on the main branch";
3. an old check run was read as the check's present condition.

Three independent defects, one code path, one underlying error each time: **reading a symbol instead
of the state it stands for.** None of the three was visible from outside — they all presented
identically, as a flat refusal.

## What changes

Before judging greenness, collapse the list to the **latest run of each check**, then evaluate those.

## The two ways this must not become a loophole

Deduplicating is dangerous if done carelessly — "keep the latest" could be used to launder a real
failure. So:

- **The latest run is authoritative in both directions.** A success followed by a later failure is
  *not* green. If it were, this fix would be a way to hide a red by re-running until the ordering
  suited you.
- **Runs that cannot be ordered fail closed.** If two runs of the same check have equal or missing
  timestamps, we cannot know which came last, so **the failing one wins.** An undatable success must
  never mask a red.
- **Unnamed entries are never merged together.** Some checks arrive as bare status entries with no
  name at all; those are kept individually, so a failing one cannot be silently replaced by a
  passing one.

All three are tested, along with the case that was previously broken and the existing behaviour for
a check still in flight.

## How this was found

Not by the failure happening again. I was about to tell the operator "the recording step will work
once the server updates" — and instead of asserting it, I ran the check's own logic against the two
real pull requests to see what it *would* say. It said no, twice, for two different reasons.

That cost about two minutes and saved discovering both blockers later, one at a time, each looking
like a fresh mystery. The habit worth keeping: **before claiming something will work after a
dependency lands, run its logic now and watch what it actually returns.**
