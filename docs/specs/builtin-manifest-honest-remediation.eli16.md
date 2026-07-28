# A test that told you to do an impossible thing — Plain-English Overview

> The one-line version: when a build file went out of date, the check that caught it told you to
> "commit the result" — but that file is deliberately never committed. The advice could not be
> followed by anyone who tried.

## What was wrong

There is a generated index of everything the toolkit installs. It is rebuilt automatically and is
deliberately excluded from version control, because it is an output, not a source.

A test compares the copy sitting on your disk against a freshly generated one. That is a genuinely
useful check: if your local copy is left over from an older build, the two differ and the test goes
red. Good.

The problem was what it said when it went red. It reported the file as *stale* and told you to
regenerate it **and commit the result**. You cannot commit that file. It is excluded from version
control on purpose. So the one instruction the failure gave you was impossible, and the only correct
action — rebuild — was never mentioned.

A second copy of the same wrong advice lived in the generator itself, warning that a named test
"will fail if you commit this". That test had since been renamed, so the warning pointed at something
that no longer existed and repeated the same impossible suggestion.

## What this changes

The failure now says what it means: your local build artifact is older than your source, so rebuild
it, and explicitly that it is not something to commit. The generator's warning is corrected the same
way. Nothing about what the test *detects* has changed — only what it tells you to do about it.

There is also a new small check asserting that the file really is excluded from version control. That
sounds redundant, but it is the fact the corrected advice depends on. If someone later starts tracking
the file, that check goes red and tells you the wording needs revisiting — and at that point a
genuinely better check becomes possible, because there would finally be a committed version to
compare against.

## The part where I was wrong, twice

I want this on the record because the corrections are the useful bit.

I first concluded the whole check was meaningless — that it compared a freshly generated file against
another freshly generated file and could never fail. I rewrote it on that basis, renaming it to
something else entirely.

Then I ran it, and it failed. Not for the reason I had invented, but for the real one: my own copy on
disk was genuinely out of date, from a build several versions earlier. The check was doing exactly the
job I had just claimed it could not do.

So I put the name back and corrected only what was actually broken — the advice. My rewrite would have
removed a working safeguard and replaced it with a weaker one, on the strength of an argument I had not
tested.

There is one grain of truth in the wrong version, and it is now written down rather than acted on: on a
completely fresh checkout, the file is created by the test run itself, so the comparison is trivially
satisfied. The check has teeth only when an older copy already exists. Green means "no stale local
build was found", which on a clean machine mostly means there was none to find.

## What it does not do

**It does not change what is detected.** Same comparison, same coverage. Only the remediation text and
one new assertion about the file's status.

**It does not add a real check against committed source**, because there is nothing committed to check
against. That would require tracking the artifact, which is a deliberate choice made elsewhere and not
one to reverse for a test's convenience.
