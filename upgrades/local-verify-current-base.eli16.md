# Local-verify tests against today's main — the plain-English version

When the local checker tests a pull request, it builds the code that would exist after the merge: the pull request's changes combined with the main branch. To do that it needs to know which version of the main branch to combine with.

It was asking GitHub, and GitHub answered with the version of main from the last time the pull request itself was updated. For a pull request that has sat for a few days, that is a main branch that is several days and many merges old. So a "pass" could mean "this would have been fine last Tuesday", not "this is fine now". I noticed it while lining up older pull requests for the ten measured checks: four of them all pointed at old versions of main.

Now the checker asks for the main branch's current version at the moment the check is requested, and tests against that. If GitHub can't answer, the check is refused and can simply be asked for again, rather than quietly using the old version.

This doesn't change anything for users, and the checker is still in watch-only mode. It matters because the whole point of a local check is that a pass means the merge is safe today.
