# Open-PR overlap shown at every commit — plain-English overview

## What happened

On 11 November two Echo sessions, one on the M5 and one on the Mama PC, spent the day changing the same reply-delivery code. Neither knew about the other. Justin found it by asking. Instar already had a command that checks whether another open pull request touches the same files (`instar dev:claim-check`), but a session only gets that answer if it remembers to run the command. The M5 session never ran it.

## What this change does

The instar repo's commit hook runs on every commit, on every machine, for every session. It now does that check itself. Before its other checks, it takes the files being committed and compares them with the files of every other open pull request on GitHub. If another pull request changes any of the same files, the hook prints a boxed notice listing those pull requests, their branches, and the shared files. The notice asks the session to read them and agree an order with the other session.

GitHub's list of open pull requests is the one shared list every machine already writes to, so this needs no new shared state. It sees work on other machines from the first commit after the other session opens its pull request.

## Keeping it useful, not noisy

- Pull requests that haven't been updated in 14 days are skipped. They are not active work.
- Some files, like the server wiring file, are changed by many pull requests at once. A file changed by six or more active pull requests counts as a busy wiring file. Matches on those files alone get one line naming the pull requests instead of a full listing, so they are never hidden.
- Release bookkeeping (package.json, release notes, the trace records) never counts.
- The session's own pull request is never listed.

Replayed on the real case, PR 3082's files are flagged against three open pull requests that change the same reply-delivery files.

## What it does not do

It never blocks a commit. Two pull requests can share a file without conflicting, so a file match is a signal, not proof. The session decides what to do. If GitHub can't be reached, the hook prints one line saying overlap is unknown for this commit and carries on. It is skipped in CI, in test copies of the repo, and when `INSTAR_PR_OVERLAP_CHECK=off` is set.

## What is left for later

This is the first, smallest step. The rest of the report (a pool-wide list of active efforts with machine and topic, a gate before a plan and before a build, an hourly cross-machine collision job, sessions starting with the live machine list, the M5 being unable to post into Echo Bugs, and messages to the Mama PC having no address) is filed separately in the feedback queue: fb-c474f83a-5ad (shared efforts list and gate), fb-8390730a-16f (hourly job), fb-51fa3dca-dcf (session start), fb-43860e3f-1ce (M5 and Echo Bugs), fb-4c703763-559 (Mama PC address).
