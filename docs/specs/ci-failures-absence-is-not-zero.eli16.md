# CI failures: a check we could not read is not a check with nothing wrong

> The one-line version: the tool that tells you what broke on a red pull request could announce "these failures are probably a build or lint problem, not a test problem" after failing to read a single one of them.

## The problem in one breath

When a pull request goes red, this command asks GitHub for each failed check and prints the exact test failures inside it. For each check it fetches a list of annotations — the file, the line, the assertion that failed.

If that fetch failed, the command quietly skipped that check and moved on. If it failed for every check, the command printed a conclusion: *"The failed checks have no test-level annotations — likely a build/lint/type step."*

That sentence is a diagnosis of what went wrong, produced from information that never arrived. It tells the reader to stop looking for a failing test — which is the one thing they came here to find.

## What already exists

- **A hardened boundary.** The code that talks to GitHub was deliberately written so that empty output cannot be mistaken for an empty answer: it parses strictly and raises an error instead of quietly producing nothing.
- **Two careful callers.** The step that resolves the pull request, and the step that lists its failed checks, both report the reason plainly and stop with an error code when they cannot read.
- **A stated guarantee.** The file's own documentation said, in as many words, that there is no path on which a failed read renders as a clean one.

## What this adds

**The guarantee is now true.** It was not. The third caller — the one that fetches annotations per check — caught its errors and continued in silence, exactly the case the guarantee denied. Three things change:

- **A failed read is recorded, not swallowed.** Skipping the rest would be worse, since one hiccup should not lose every other check, so it still continues — but it now remembers which checks it could not read.
- **The incomplete listing says so**, even when some failures were found. A partial read that looks complete is the more dangerous of the two, because the reader has results and no reason to doubt them.
- **The conclusion is withheld when nothing was read.** If no check could be read at all, the command says their nature is unknown rather than guessing at it. When annotations genuinely come back empty, the original wording is unchanged.

A reply that is not a list at all — nothing, a bare word, an object — is also treated as absence rather than as zero findings.

## The safeguards

**A genuine "no annotations" still gets the original answer.** This is the important one. Plenty of real failures are build or lint steps with no test-level annotations, and that diagnosis is correct and useful for them. There is a test that fails if that message ever stops appearing for a genuinely empty result — without it, a guard that fired on every run would look identical on the broken case and be wrong on every healthy one.

**Nothing becomes an error.** This command is a diagnostic, never a gate. It still returns success in every case it did before; only what it prints has changed.

## Why it matters

This command exists for the situation where the usual tools come back empty — its own documentation recommends it for exactly that. A tool people reach for when they cannot see must never be the one that reports a confident answer it did not earn.
