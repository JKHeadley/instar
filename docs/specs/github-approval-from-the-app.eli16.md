# Approving a protected pull request from your phone — Plain-English Overview

> The one-line version: when a change to a protected file is waiting for the owner's approval on GitHub, the owner sees what it is, can open it on GitHub with one tap, and can approve it with Face ID in the Instar app; the agent then records that approval on GitHub and checks GitHub to prove it landed on exactly the version the owner saw.

## The problem in one breath

A few files in the Instar code (the constitution, and the file that says who owns it) can only change with the owner's approval on GitHub. When such a change is ready, the agent's "Needs you" list says "Pull request #N needs your approval on GitHub". Today that row is a dead end: the phone says to approve on the phone but has nothing to tap, the dashboard page has no link (it tried to get the repository name from a slow statistics read that had failed), and nothing says what the change is.

## What already exists

- **The merge watcher** — a background check that looks at the agent's open pull requests every ten minutes and knows which ones wait for the owner. It already knows the repository name, each pull request's title and which protected files it changes.
- **The Needs-you list** — one list that the dashboard, the iPhone app and the Mac app all read.
- **Face ID taps in the app** — the owner already approves things like account sign-ins with Face ID. The phone signs the exact action with a key only it holds, and the server checks it.
- **A hand-run approval habit** — when the owner said "yes" in chat, the agent opened the owner's own signed-in GitHub browser profile, clicked Approve, and checked GitHub afterwards. It worked, but a chat "yes" is not proof a person decided, and it ran from a scratch script.

## What this adds

The row now carries the pull request's title, which protected files it changes, a direct GitHub link to the changes, and the exact version (the commit) it is at. The dashboard gets its GitHub links from the merge watcher, so a failed statistics read no longer hides them.

The owner can approve with Face ID in the app. The agent then records the approval in the owner's GitHub browser profile and asks GitHub whether a new approval by the owner exists at exactly that version. Only GitHub's answer counts as success.

## The new pieces

- **The approval service** — checks everything before anything happens: the feature is switched on, the owner's GitHub profile and its passwords exist on this machine, the pull request is one the watcher says waits for the owner, it is still open, and it is still at the version the owner saw. Then it runs the approval and asks GitHub what was recorded.
- **The approval script** — opens the owner's GitHub profile out of sight, signs in if needed (computing the one-time code itself), checks it is signed in as the owner, checks the version once more right before clicking, and approves. It never shows or saves a password or code.
- **Two phone routes** — one to approve (it answers within 25 seconds, or says "still running"), one to read the result.

## The safeguards

- **Only the owner's phone with Face ID.** There is no dashboard-PIN way to approve, because a program on the machine can read the PIN; that would let the agent approve a constitution change in the owner's name.
- **Only what was shown.** If the pull request moved to a newer version, the approval is refused. If an approval ever lands on a newer version anyway, the agent immediately puts a hold on the pull request so nothing merges it, and tells the owner.
- **GitHub is the judge.** The script saying "done" counts for nothing; only a new approval visible on GitHub does.
- **Only pull requests waiting for the owner.** The phone cannot be used to approve any other pull request.
- **Secrets stay hidden.** Passwords go to the script privately and never appear in logs, command lines or answers.
- **Off by default.** The feature is switched off everywhere until turned on, and it is turned on for this agent only after a live test on a throwaway pull request.

## What you need to decide

Nothing new. This replaces a habit the owner already accepted (the agent approving on the owner's yes) with a stronger yes: a Face ID tap bound to the exact pull request and version.
