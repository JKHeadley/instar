# Thirty source files were invisible to search — Plain-English Overview

> The one-line version: a single invisible byte in a file makes the search tool
> skip that entire file and say nothing at all — so "I couldn't look here" came
> back looking exactly like "I looked, and there's nothing wrong."

## The problem in one breath

Programmers routinely search the codebase with a tool called `grep` — "show me
every place we do X." It is the workhorse instrument for auditing.

`grep` has a rule: if a file contains a particular invisible byte (called NUL,
the byte whose value is zero), it decides the file isn't text — it's data, like
an image — and refuses to search it.

Here is the dangerous part. It doesn't *warn* you. It doesn't say "skipped 30
files." It prints **nothing**. Not a match, not a zero, not an error. A search
that skipped a third of the safety-critical modules looks byte-for-byte
identical to a search that examined everything and found nothing.

## How the byte got there

Nobody corrupted anything. The byte was put there deliberately, for a good
reason, and written down slightly wrong.

When you need a single lookup key from two pieces of text — say a model name and
a framework name — you glue them together with a separator. You want a separator
that can never appear inside either piece, or "a" + "b:c" and "a:b" + "c" would
collide. The NUL byte is the classic choice precisely because it never occurs in
ordinary text.

So the code says: *model, then NUL, then framework.* Correct thinking.

The mistake was writing the byte itself into the file instead of writing its
**name**. Programming languages let you type a six-character spelling that means
"the NUL byte here." Both produce the identical result when the program runs.
Only one of them leaves the file readable by your tools.

## What it actually cost

Thirty files, twenty-two of them live source code. Among them:

- the module that decides whether a blocker is genuinely unresolvable,
- the one that prevents the same conversation running on two machines,
- the automatic pull-request merger,
- the safety floor that answers approval prompts so a session can't freeze,
- and — the one that stings — **the module that audits whether our standards
  have real enforcement behind them.** The auditor of guarantees was itself
  invisible to the standard instrument.

Eleven of the thirty were worse still. Git uses the same rule but only checks
the first chunk of a file, so for those eleven git *also* gave up: when someone
opened a pull request touching them, the review showed "binary file changed,
5407 bytes" instead of the actual lines. **Safety-critical code was being
reviewed without the reviewer being shown what changed.**

## How it was found

By accident, and only because the accident was checked.

I was investigating something unrelated and ran a search that returned almost
nothing. I nearly wrote that emptiness up as a finding — "no such mechanism
exists in the codebase." Before doing so I re-ran the same search a second way,
and the two disagreed. One instrument could see the files; the other had been
silently skipping them all along.

The finding I was about to publish was **produced by the very defect it would
have been reported alongside.** That is worth stating plainly: the search
returned nothing, and I read nothing as absence.

## What changed

Every one of those thirty files now spells the byte instead of embedding it.
The programs behave identically — this is the same character either way, and the
test suite proves it — but the files are text again, so every tool can read them.

Then, so this cannot come back: a new automatic check scans the codebase and
**fails the build** if any text file ever contains that byte again. It names the
offending files and explains the consequence rather than just failing.

## Why the check has a check of its own

A test that has never objected to anything looks exactly like a test that
*cannot* object to anything — the same trap, one level up. So the check
deliberately proves itself on every run: it creates one file containing the raw
byte and one containing the spelled version, and asserts it flags the first and
clears the second. If the detector ever goes dead, that self-test goes red
before the real scan can lull anyone.

It also asserts it examined more than five hundred files, so a scan that quietly
looked nowhere can't pass by finding nothing.

## What this does not fix

A few files still contain other invisible control characters (escape, bell)
inside deliberate tests for hostile input. Those were checked and they do **not**
cause this problem — the search tool reads those files fine. They are left alone
on purpose: a check should enforce exactly the failure it is named for, and
widening it to look tidy would have added noise without adding safety.

And more broadly: this fixes one way an instrument can fail silently. It does not
establish that no others remain. The general lesson stands on its own —
**an empty result is only evidence if the instrument can tell you when it
couldn't look.**
