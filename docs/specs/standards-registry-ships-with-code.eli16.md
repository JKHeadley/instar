# The rulebook that never reached anyone — Plain-English Overview

> The one-line version: we keep our engineering standards in one document, and a tool grades how
> well each standard is actually enforced. That tool was reading a copy of the document from May
> that had 22 rules in it. The real document has 81. Worse, there was no way for the real one to
> ever reach an installed agent — it isn't included in what we ship.

## What was wrong

There is a single authored document — the constitution — listing every standard the project holds
itself to. Several parts of the running system read it: an audit that grades whether each standard
has a real structural guard behind it, a gate that checks new design documents against it, and a
couple of places that just need the list of standard names.

Every one of those read a copy sitting in the agent's own folder. That copy is written once, when
the agent is first installed, and then never touched again.

Three separate things had to go wrong together, and all three had:

1. **The document is not in the package.** When we publish, we ship 9,834 files. The constitution
   was in none of them. So there was no fresh copy anywhere on an installed machine to update from.
2. **The updater pointed at a file that doesn't exist.** There was code whose whole job was to
   refresh that copy on each update. It read from a location that only exists in the development
   repo. On every real agent it failed instantly, the error was caught and filed into a list nobody
   reads, and the update carried on looking successful.
3. **Even given the file, it would have refused to update.** The refresh only overwrote the copy if
   it exactly matched one specific expected version. Any agent whose copy had drifted even slightly
   was labelled "customized" and skipped — permanently.

The result: an amended standard could never reach a deployed agent. We could add a rule, change a
rule, or remove one, and nothing out in the world would ever know. That is the same failure our
Migration Parity rule exists to prevent — except it was happening to the rulebook itself.

## What this changes

The constitution stops being something each agent keeps its own copy of. It becomes part of the
build, generated from the authored document and shipped inside the package alongside the compiled
code that reads it. The reader and its data now travel together and share a version number.

That has a useful consequence: "this code is running but its rulebook is missing" can no longer mean
"you have an old install." It can only mean the install is broken. So there is no old-versus-broken
guessing to get wrong, and **the reader has no fallback** — it looks in exactly one place and
reports honestly if what it finds is wrong. (Copies do exist: one in the source tree, one in the
shipped package, and now the refreshed one in your own folder. What does not exist is a chain the
reader quietly walks when the first is missing — that chain is how the original defect stayed
invisible.)

A small integrity record ships beside it, recording what the document's contents should be. The
reader checks them against each other. If the record is missing, or the two genuinely disagree
about the document's contents, it says so plainly and reports that its assessment cannot be trusted.

Worth being exact, because the looser version of this sentence was wrong: a disagreement about the
**article count** does not stop the report. It still grades everything it found and simply lowers
its confidence — the numbers are still useful, they just are not vouched for. Only a missing or
mismatched record makes the whole assessment untrustworthy.

**That check alone turned out not to be worth much, and review caught it.** The document and its
record are written on adjacent lines by one script, so they agree forever no matter how old they
are. Two things agreeing tells you nothing when the same hand wrote both.

So there are now **three** things checked, not one: the record matches the document, the article
count in the record matches what the parser reads, and the version stamp the build wrote in matches
the version actually running. And separately — in the development repo, where the original document
is present — the **audit** compares the shipped copy against that original. That last one is the
only check whose answer the build did not write, and it lives in the audit rather than the reader,
which an earlier draft of this page got wrong.

## Why the checking matters more than it sounds

The audit could already tell you it wasn't confident. It said so, in as many words: it had no way to
confirm its copy was the current constitution rather than a coherent older one, and noted that a
stale copy passes every internal check by construction. It was right, and it had been right for two
months, and nobody could act on it because the thing it was missing didn't exist.

The honest description of what this adds is narrower than my first two attempts at it, and both
attempts were caught in review.

It does not give the audit an outside witness. It removes the drift: the rulebook now ships with the
code that reads it, so "current reader, stale rulebook" stops being a state that can exist rather
than one we detect. The audit can reach a *verified* verdict where it was permanently *unverified* —
but *verified* here means one specific thing, **this rulebook came with this build**, and the report
says so in words rather than leaving a one-word verdict to be over-read on a dashboard.

## The copy in your own folder — the part I got wrong, and it was the whole point

An earlier version of this said those copies are left where they are and simply never read again.
That was wrong in the way that mattered most.

*Never read again* was true of the machinery. It was not true of **the agent** — which is the
rulebook's main reader. Every instruction the agent gets, in its own briefing and in several of its
procedures, says the rulebook is at that path. Measured on this machine while reviewing the change:
that file held **22 rules, dated May 24**, against the 81 that were written. So I would have fixed
the tooling and left the agent reading a fourteen-week-old quarter of the rules — which is the exact
problem this change exists to solve, just moved to the reader nobody was counting.

So the copy is now refreshed from the shipped one on every update, unconditionally. Two guards on
that, because writing into someone's folder deserves them:

- It **refuses** when the folder is the development repo — there, that file is the *original*, and
  overwriting it would have quietly reverted the authored rulebook. The backup is only written once,
  so a second update would have destroyed it with nothing kept. Review caught that before it shipped.
- It is unconditional on purpose. The old version only overwrote a copy matching one exact expected
  version, which meant every drifted copy — all of them — was labelled "customized" and skipped
  forever. That is the defect, not a safety feature.

## What found what

Worth recording, because the guards caught things I didn't.

I set out to fix three readers. A test I wrote found a fourth I'd missed — one that failed silently,
returning an empty list of standards and reporting no error at all, meaning anything downstream of it
had been working from zero rules on every deployed agent. Then the lint found a *fifth*, in a
different file, with the same silent-empty-list shape copied into it.

I also got the proofs wrong twice. My first attempt to show the packaging guard actually catches the
bug passed when it should have failed — my simulation didn't do what I thought. My first attempt to
show the lint catches a reintroduced path also passed, because I'd accidentally hidden the test line
inside a comment block. Both times the honest move was to distrust the green result and find a
version that genuinely bit. A guard you have never watched refuse something is not yet a guard.

## What this does not do

**It does not delete anyone's copy** — it refreshes it, and refuses to touch the original in a
development repo. Nothing is removed.

**It does not add a way to locally amend the constitution.** The supported way to change a standard
is still to change the authored document. A per-install override would add exactly the kind of quiet
divergence this change removes.

**It does not make the standards any better enforced.** It makes the measurement of that honest.
The audit will now grade all 81 rather than 22, and the enforced fraction it reports will change
accordingly — because it is finally measuring the whole subject.

**And that fraction still means less than it sounds, which is worth knowing before you read one.**
The audit decides a standard is enforced by checking whether a file with the right sort of name
exists. It does not check that the file runs, or contains any assertions, or is switched on in CI.
In this project 5 test files carry an unconditional skip and 20 more skip conditionally — 29 in total — and every one would still count. (An earlier draft said "forty", which was not a number anyone had measured.) Fixing that is
rebuilding the grader, which is a different job from delivering the rulebook — so it is not in this
change, but the report now states its own basis rather than letting the number imply more.
