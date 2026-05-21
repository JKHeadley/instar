# Test-environment isolation — plain English

## The story

A while back, a perfectly normal-looking pull request landed on instar's main branch. The headline said "telegram markdown formatter" — innocent infrastructure work. But hidden at the end of its commit list were three little stowaway commits authored by "Test". One of them quietly overwrote the entire README — 270 lines of carefully written documentation — with a single line that just said "# Test Project". A few weeks later, another PR did the same thing again and trimmed it down further to just "# Test". That version of the README is what shipped to npm. That's what someone landing on the package page saw. It was embarrassing, and it sat there for weeks before anyone noticed.

So how did it happen? It wasn't sabotage and it wasn't a sloppy author. It was a quiet, structural bug in how our tests talk to git.

## What's really going on

When you push code, git runs a little script called a pre-push hook. Ours runs the test suite. So far so normal.

When git starts that hook, it secretly tells it where the real project repo is by setting a few invisible environment variables — things like "GIT_DIR points here", "the working tree is over there". These variables get passed down to everything the hook starts, including the test runner, and everything it starts after that, all the way down. They override any "current folder" rules. Once they're set, every single git command in every single child process operates on the real project repo, not whatever folder it thinks it's in.

Now, our test fixtures look totally reasonable. They make a fake project in a temp folder, write a fake README that says "# Test Project" in it, then run `git init` and `git commit`. The test author obviously expects all that to stay safely inside the temp folder. But because those invisible variables are pinning git to the real project, those commit commands actually run against the real project — on whatever branch the developer happens to be pushing.

The result: every push that triggered the affected tests quietly added three extra commits to whatever branch was being pushed. One of them clobbered the README. The other two left little "file-0.txt" and "seed" droppings at the project root. We had even spotted this exact failure mode in one specific test months ago — there's a comment in that test's source file explaining it — but the fix never made it to the central setup file, so every test added since was vulnerable.

It hid for weeks because the bad commits look like noise at the end of the commit list. Reviewers look at the named changes, not "what extra commits showed up." And the README only shows as "changed" if you specifically click into its diff, which nobody does on a PR titled "telegram formatter."

## What we're doing about it

Five layers, smallest first.

The first layer is one line in the central test bootstrap file — it deletes those invisible variables before any test loads. After this, no test in the entire suite can inherit the dangerous setting, no matter how the test is written or what fixture it uses. This single line closes the actual bug. If we did nothing else, this would be enough.

The second layer is a tiny helper that exists so that any fixture that builds its own environment object (a common pattern) can just call one function to get a clean version. We use it in the three fixtures that are visibly responsible for the historical pollution. It's defense-in-depth — belt and suspenders on top of layer one.

The third layer is a script that runs at push time, before the test suite. It looks at what commits we're about to push and refuses if any of them have the signatures of the historical pollution — authored by a fixture identity, or with messages like "Initial commit" or "seed". This catches a leak from any direction, not just the test suite. There's a normal escape hatch for legitimate cases where this would be wrong.

The fourth layer is a continuous-integration check that runs whenever you open or update a pull request. It just verifies the README is at least 100 lines long and that the two stowaway files aren't sitting at the project root. It's the final safety net — if everything else got bypassed somehow, this still fails the build before the bad PR can merge.

The fifth layer is just removing the two stowaway files (`file-0.txt`, `seed`) that are sitting at the root right now. They came from the same pollution, and leaving them around would falsely make the fourth layer think things are fine on the very PR that adds it.

## What you actually need to know

The README is back. The bug class is closed. The fix is structural at every layer — there's no "remember to do X" anywhere; the tests literally cannot reintroduce this, and even if someone manages to bypass the protections locally, the CI check would catch the resulting PR before it merges.

There's no user-visible change. No release note. Nothing your agent does differently. The infrastructure just got harder to break.

The deeper takeaway: this is what "structure > willpower" actually means in practice. We knew about the bug — there was even a code comment about it — but we relied on each individual test author remembering to apply the workaround. They didn't. So we move the fix to a place where remembering isn't required, and the failure class disappears.
