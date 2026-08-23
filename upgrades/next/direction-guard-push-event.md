<!-- bump: patch -->

## What Changed

The check that verifies a constitutional change was ratified now looks for the owner's approval on a push to `main`, not only while the pull request is open.

The evidence-gathering step was gated on the `pull_request` event. On a push — the merge itself — it never ran, so the file holding the review context was never written, and the check read the resulting "file not found" as "no approval" and refused. It was demanding a ratification the operator had already given, minutes earlier, on the pull request that produced that exact commit.

That is the safe direction taken at the wrong moment, and it was not theoretical: canonical `main` went red at 05:05Z on 2026-08-23 and stayed red across three consecutive merges, every one of them a registry change the operator had approved.

The evidence is still reachable on a push; it just has to be reached through the commit. The step now runs on both events and, on a push, resolves the pull request whose merge produced this commit — matching on `merge_commit_sha` rather than taking the first associated pull request, because a commit can be associated with several and only the one GitHub actually merged carries the approval that ratified it. Its head commit and reviews then feed the same unchanged evaluator.

## Evidence

- The binding is unchanged in strictness: an `APPROVED` review, from the repository owner, on the exact head commit, submitted by someone other than the author. Only *where the inputs come from* on a push is new.
- **The bypass stays closed.** A commit with no such pull request — a direct push to `main` — resolves nothing, writes an empty context, and the check refuses exactly as before. Every failure path (API error, rate limit, no matching pull request, or more than one match) yields an empty context rather than an error, so "cannot verify" can never become "verified". One honest qualifier, unchanged by this fix: the check is per-push rather than per-article, so a push whose tip is an approved merge commit covers everything in that push. That only matters to someone who can already push to `main` directly, which the ruleset — not this check — is what prevents.
- The workflow self-wiring contract now REFUSES an `if:` on that step, and pins the two push-branch inputs. Re-gating it, or dropping either input, fails the check rather than silently returning the guard to refusing on every push. Three regression assertions pin all three routes.

## What to Tell Your User

If you approve a constitutional change on GitHub, that approval now counts both while the pull request is open and after it merges. Previously it counted only until the moment you merged, at which point the check asked for it again on the main branch — where there is no pull request to approve, so nothing could ever satisfy it and the build stayed red until someone noticed.

Nothing about what you do changes. You still approve once, in the same place.

## Summary of New Capabilities

- A constitutional change ratified by the owner's review no longer turns the main branch red the moment it merges.
- Re-introducing the event gate that caused it now fails a check instead of passing quietly.
