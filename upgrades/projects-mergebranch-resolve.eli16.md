# Projects "merged" check now works on dev-agent homes too

Tonight's #866 fix wired the GitHub-PR verification into the projects pipeline's "building → merged" step — and it works: it resolves the PR, confirms it merged, gets the merge commit. But the very next check then failed on a dev-agent machine: the validator confirms the merge commit is actually on the main branch by checking "origin/main". On a normal install that's right. On a developer agent's home checkout, though, "origin" points at the agent's personal FORK, while the real merges land on the UPSTREAM repo under a differently-named remote. So origin/main never contains the commit, and every attempt to record a step as merged failed with "commit not reachable from origin/main" — even though the PR genuinely merged.

This is a sibling of the same class as #866: code that assumed the common-case environment and broke on the dev-agent's fork-origin layout. I hit it the moment #866's fix let me get that far — trying to mark this very initiative's own rounds merged.

The fix: instead of hardcoding "origin/main", the route now asks GitHub which repo it's actually talking to (the same repo the PR-view reads), finds the LOCAL remote whose URL points at that repo, and checks "<that-remote>/main". On a normal install that resolves right back to origin/main (unchanged behavior); on a fork-origin agent home it correctly resolves to the upstream remote where the merges live. Both lookups are read-only (a GitHub repo-view and a git remote listing).

With this, the projects pipeline can finally record merged steps on the machines we actually develop on — which is the whole point of being able to track an initiative through to "merged."
