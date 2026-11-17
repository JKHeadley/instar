# Releases skip a version npm is still holding — plain overview

## What the problem is

When a change merges into Instar, a release job gives it the next version number and sends it to npm, the public package registry. Lately npm has started holding each new version in a private "staged" state before showing it to anyone: usually about 13 minutes, sometimes close to an hour. The release job asks npm "what is the newest version?" to decide the next number. While a version is staged, npm still answers with the older one.

So when a release took a long time to appear, the next release job asked npm, got the old answer, and picked the very same number again. npm refused it ("you already used that number"). Today that happened with 1.3.1873: one job timed out waiting, the next was refused, and a third was refused again once the version finally appeared. Three merged changes waited between one and two and a half hours for a release instead of the usual half hour. The same thing happened earlier with 1.3.1868, and both of those versions ended up with no release tag in the repository.

## What already exists

Both ways of releasing (the hosted GitHub job and the local release script any authorized Echo machine can run) already share one small script that decides the version number, and both already push a git tag `vX.Y.Z` — but only after the long wait for npm to show the version, which is exactly too late.

## What is new

Right after npm accepts an upload, the release now pushes a second, lightweight tag named `published/vX.Y.Z`. It means "this number is taken, even if npm isn't showing it yet". The version script now looks at those tags as well as npm, takes whichever is higher, and picks the next number. The tag lives on GitHub, so it works no matter which machine runs the next release.

## Safeguards

- It can only ever choose a higher number than before, never a lower or duplicate one. At worst a patch number gets skipped, which is harmless.
- If pushing the marker fails, the release still continues; it just loses this protection for that one version and prints a warning.
- The normal release tag, the release commit, the smoke test and every release gate are unchanged.
- No other job is started by these tags.

## What a reader needs to decide

Nothing beyond normal review. Undoing it is a plain revert; the extra tags do nothing once the code that reads them is gone.

## Review

An independent reviewer read the change cold. In round 1 it found that writing the marker could run the full set of pre-push checks in the middle of a release, and that one claim in the review notes was wrong. Both were fixed (the marker is now written without those checks, and the notes were corrected), and in round 2 the reviewer agreed.
