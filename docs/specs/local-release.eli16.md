# One-command local release — Plain-English Overview

> The one-line version: when GitHub's machines are too busy to release Instar, a maintainer can now run the exact same release from their own computer with one command. (The fix that lets the push check accept a release commit shipped separately, in #2222.)
>
> The standard this serves: **Friction Is a Spec — Productize the Workaround**. The first local release (v1.3.1359) was done by hand, copying the workflow's steps one at a time; this turns that workaround into a permanent command.

## The problem in one breath

Every merge to Instar's main branch is supposed to be released by a GitHub workflow, but GitHub's shared machines have been backed up for days, so finished fixes sat unreleased. Releasing by hand meant copying the workflow's steps one at a time, and then the push of the release commit was refused by our own pre-push check.

## What already exists

- **The publish workflow** — on GitHub, it gathers the release notes, picks the version, publishes to npm, tests the install, and commits "chore: release vX". It commits with the hooks turned off, so it never meets the pre-push check.
- **The pre-push check** — before any push it refuses changes that ship behavior without a release note. A while ago it started counting package.json as "ships behavior", which is right for normal changes but means a release commit (which changes the version in package.json and uses up the notes instead of adding one) is always refused.

## What this adds

A single command, `npm run release:local`, that does exactly what the workflow does, in the same order with the same scripts, and stops at the first failure. Before it publishes, a failure puts the files back. `--dry-run` rehearses everything except publishing, committing and pushing, and says which version it would publish.

- **It needs the pre-push fix in PR #2222**, which lets a pure release commit through the pre-push check. Without it, the release commit is refused at the push.
- **After publishing, it is careful about what it can't see.** It pushes the release commit and its version tag in one step, so both land or neither does. It retries only when main really moved. When a hook refuses the push, it stops at once and shows why. If npm reports a failed publish, it asks npm whether the version landed anyway. When npm can't answer, it says the state is unknown and leaves everything as it is.

## The safeguards

**It cannot release something that isn't on main.** It refuses to start unless the working copy is clean and exactly matches main on GitHub.

**It cannot release against a stale picture of main.** Before publishing, it refreshes every copy of main the pre-push check might compare against, and stops if one can't be refreshed.

**Its version tag always marks exactly what went to npm.** If someone merges code while a release is running, it will not slide the new release on top of that code and tag it. It stops, and says how to finish with the tag kept on the published version.

**It never races GitHub's own publisher.** If any of GitHub's release jobs is waiting or running, for any merge (a waiting job publishes whatever main is when it starts), it refuses and shows how to cancel that job. If it can't ask GitHub, it stops instead of guessing.

**It finds out about npm's one-time password before it starts.** If the npm account needs a one-time code to publish, it says so before building anything. You then either give it a command that produces a fresh code at publish time, or use a token that doesn't need one. It never sits waiting on a prompt halfway through.

**A failure after publishing can be finished without publishing again.** `--push-only` lands the release commit for a version that is already on npm, and checks npm first. If the failure came before the release commit was even made (the install test failed, or a commit check refused it), `--push-only` makes that commit itself, but only when the leftover changes are exactly a release and npm already has that version.

**A publish npm is still reviewing is not a failure.** npm sometimes holds a new version in an automated review ("Validating") for a long time, sometimes over 40 minutes, before anyone can download it. When that happens the tool says so, shows where the package owner can check, and says not to publish again. `--push-only` waits until npm shows the version and then finishes the release. But `--push-only` can't tell a version npm is still reviewing from one that was never published, so it also says: if the publish never happened, don't use `--push-only`; run the release again normally.

**One decision is coming.** npm says tokens that skip two-factor checks stop working for publishing in January 2027, so local releases will need a different sign-in route by then. Justin is choosing which.

**It never turns off the checks.** The release commit and push run every hook; there is no force push; a conflicting rebase stops instead of overwriting.

**What it cannot do locally:** npm provenance (a signed record that the package was built by GitHub) needs a token only GitHub's machines have, so local releases go out without it, and the script says so.

## What ships when

First the pre-push fix (#2222). Then this spec is converged and approved. Then one PR with the command, its tests and a short CONTRIBUTING.md section. The code is already written and tested, and it is waiting on this approval.
