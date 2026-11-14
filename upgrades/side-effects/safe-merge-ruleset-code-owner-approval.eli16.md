# Merge tool reads the real approval when GitHub gives no verdict

Some changes to Instar can only merge after the code owner, the person who owns the rule books, approves them. Our merge tool, safe-merge, checks that before it tries the merge, so it can hand back a review link instead of failing halfway.

It asked GitHub one question: what is the overall review decision on this pull request? On 2026-11-06 that question came back empty for pull request 2812, even though the owner had approved exactly that version. GitHub leaves the answer empty when the requirement comes from a ruleset rather than classic branch protection. The tool read empty as "not approved", refused, and asked for a review that had already been given. The merge then had to be done by hand.

Now, when GitHub gives no answer, the tool looks at the reviews themselves. It passes only if, for every file that has an owner, a named owner's latest review approves the exact version being merged. An approval on an older version does not count. Neither does an approval from anyone else, or one that was later withdrawn. A team listed as an owner does not count either, because the tool cannot match a team to one person.

If GitHub does give an answer, such as "changes requested", that answer stands. If the reviews cannot be read, the tool refuses, as it did before.

This cannot let anything through that GitHub would stop. GitHub still enforces the owner's review at merge time. The worst case for a wrong pass here is that GitHub refuses the merge. Undoing the change is a plain revert. The background watcher that merges green pull requests had the same blind spot, and it would have kept telling you a change was waiting for your review. It now uses the same check. There is nothing for you to decide: this restores the path the rules already describe.
