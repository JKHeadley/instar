# ELI16 — Why a fix could merge but never actually ship

## The everyday version

When we change the code and want it to go out to all the agents, the release
robot looks for a little "release note" file describing what changed. If it finds
one, it publishes a new version. If it finds NO release note, it shrugs and does
nothing — quietly. No error, no warning, just… nothing ships.

That's mostly fine: if you didn't change any real code, there's nothing to
release, so doing nothing is correct.

The problem: what if you DID change real code but forgot to write the release
note? The robot still shrugs and skips. Your fix gets merged into the main
codebase, looks done, everyone moves on — but it never actually reaches the
agents. It just sits there, unreleased, silently. We got bitten by exactly this:
a real fix sat unpublished because its pull request had no release note, and
nobody noticed until much later.

## The check we already had (and the gap)

Before you push code, a "gate" runs and checks a few things — like "you changed
code but added no tests" (it warns you). But it had no check for "you changed
code but wrote no release note." So the silent-skip walked right past it.

## The fix

Add one more check to that same gate, built exactly like the no-tests one: if you
changed real code (`src/`) and there's no release-note file in your changes, the
gate stops you with a clear message — "this would silently skip the release; add
a release note." It only triggers on real code changes, so the routine
"cut the release" housekeeping commit (which touches release files but not code)
never sets it off. And if you're genuinely mid-work and not ready, the same
existing escape hatch lets you push anyway.

## Why it matters

It turns an invisible failure — a fix that merges but never ships — into a loud,
fix-it-now message at the moment you'd otherwise create the problem. Cheap guard,
real failure class closed. (And this very change dogfoods it: it ships with its
own release-note fragment.)
