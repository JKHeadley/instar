# ELI16 — Measuring the thing you actually run

## What this is for

Some decisions in this system are made by asking a language model. One of them:
a process is eating a lot of CPU and its parent application has quit — is it
abandoned junk worth shutting down, or is it still doing something useful?

We'd like to know how good the models are at that. So there's a test set: a batch
of example situations, each with a known right answer, run against several models
to see who gets what.

There's also a watcher whose job is to notice when a model's real-world accuracy
drifts away from its test-set score. That watcher had been quietly reporting
"can't do my job" for this decision, because no test-set score had ever been
recorded for it. This change records one.

## Why it took the whole evening

The test set existed. It just wasn't testing the real thing.

**The questions had gone stale.** The wording the system actually sends had been
rewritten since the test was written, and not just tweaked — restructured. The
old test handed the model a process ID and a CPU percentage. The real one hands
it seven yes/no facts and deliberately withholds the ID, on the reasoning that
the model doesn't need it, and not naming a specific target is one less thing a
malicious process can exploit. So the test was scoring a different, easier
problem and reporting the result as if it were this one.

**Half the examples described situations that never come up.** The system only
consults a model about a narrow list of known process types. Four of the eight
examples were about processes outside that list — a core operating-system
service, our own server. Those never get a model asked about them at all.

**And then I broke it myself.** Rebuilding the questions, I marked all eight as
"on the known list", including the operating-system service. So the model was
told something false and asked to judge accordingly. Three different models then
failed the same examples in the same direction — which is almost never a story
about the models. It was mine.

## Two things the fixed test found

**A question with no right answer.** Two examples are supposed to differ: in one
we know the parent app has quit, in the other we *couldn't determine* whether it
quit. Different situations, different correct answers. But the wording collapses
"unknown" into "no", so both produce a character-for-character identical
question. No model can do better than a coin flip. That's a flaw in the wording,
not the models — logged separately to fix properly.

It causes no harm today, because a separate mechanical check refuses outright
when a fact is missing, so the model's answer there is never acted on. Which is
exactly why nobody would ever have noticed: the wrong answer never has
consequences, so nothing ever looks broken. You only see it by inspecting the
decisions themselves.

**Every model missed the same one.** One example states plainly that the process
is *not* a sustained CPU hog. All three, across two different vendors, recommend
shutting it down anyway. Also harmless — the mechanical check refuses on that
exact fact — but all three talking past a fact stated in plain sight is worth
knowing.

## Where I was wrong and the models were right

Two examples I wrote expected "leave it alone" for a process whose command line
showed work in progress — a code-indexer mid-index. Every model said shut it
down. They're right and I wasn't.

Getting to this point requires the parent app to have already quit. A code
indexer still working for an editor that closed is burning cores on results
nobody will ever read. "Still working" and "abandoned" point in opposite
directions here, and abandoned wins.

Those two are withdrawn rather than scored. Marking them as failures would have
published "the leading models fail to protect work in progress" — a memorable,
quotable conclusion that happens to be false. A test case whose answer is
genuinely arguable measures the answer key, not the model.

## What guards this now

The failure that cost the most was silent: I wrote the example data using a field
name that doesn't exist, so it was ignored, and nine examples collapsed into
identical copies of one. The file still listed twelve distinctly-named cases. It
looked like broad coverage and was one question asked nine times.

Nothing caught that. It surfaced from a hunch, after the scores looked strange.

So the hunch is now machinery: the generator hashes every question it produces
and refuses to write the file if two come out identical, naming the culprits.
The one genuinely-unfixable duplicate is listed explicitly as a known exception,
so it stays visible instead of being smoothed away.

## What actually changed

One data file, recording per-model scores for this decision, plus a note stating
which examples were counted and which were set aside and why. One model's score
is based on six examples rather than ten, because four of its calls errored —
recorded as six rather than quietly rounded up, since the watcher weighs a thin
sample differently from a solid one, and only if it's told the truth about it.
