# Pre-push fixture guard: stale main refs — plain English

When a developer pushes a branch, Instar checks the branch's new commits for signs that a test accidentally wrote into the real repository. This is a safety net for a past incident in which test-created commits reached the main branch and changed the project README.

The guard needs a starting point: it compares the branch with a local copy of main. A workstation can have two copies, `upstream/main` and `origin/main`. Before this fix, a branch with no tracking setting used the first copy it found. If `upstream/main` was a day old while `origin/main` was current, the guard could inspect commits that were already on main. One such commit had a test author, so the guard refused a clean branch and suggested removing commits that did not belong to the branch.

Now the guard excludes commits found on either available copy of main, plus the branch's tracking ref if it has one. It then checks only the commits still unique to the branch. A clean branch passes even with one stale main ref, while a new fixture commit on the branch still fails. The tests create temporary Git repositories to prove both outcomes, including a case where the two main refs have diverged.

The guard does not contact the server during a push. If both local copies of main are stale, it may still have an incomplete view. Its message now tells the developer to refresh those copies before changing branch history. Because the two copies can disagree, a fixture commit present on only one copy can also be excluded; this is a documented limit of the local-ref approach.
