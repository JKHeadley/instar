# PR links request their reviewer — Plain-English Overview

> **Superseded 2026-11-11:** this check was removed because it duplicated the PR-link reviewer request in `src/messaging/prLinkReviewRequest.ts`. That one is the only send-time path now.

> The one-line version: before the agent sends a person a link to a pull request, it makes sure that person (or the repo owner) is already asked to review it on GitHub, so the link always lands on a review that is waiting for them.

## The problem in one breath

Justin asked on 2026-11-10: "every time you send me a link [to a pull request], I actually am a requested reviewer." Today that is almost never true. None of the last 15 instar pull requests had anyone asked to review. GitHub only asks him automatically for two special files, and any new push after he approves clears his request. So he opens the link, sees nothing waiting for him, and has to ask for it himself.

## What already exists

- **The merge helper already knows how to ask.** When a merge is refused because it needs an approval, it asks the repo owner to review, never the person who wrote the change. But that happens at merge time, usually after the link was already sent.
- **One place every outgoing message passes through.** Telegram, Slack, the Instar app, WhatsApp and iMessage replies all go through one shared check before they are sent. When a second machine has no Telegram connection of its own, it hands the message to the main machine, which runs that same check.

## What this adds

One more step at the end of that shared check. If a message contains a GitHub pull-request link, and the pull request is still open, the agent checks whether the reviewer is already asked or has already approved the latest version. If not, it asks GitHub to request them, and confirms GitHub lists them.

Merged or closed pull requests, links the agent cannot see, repos the agent cannot write to, and ordinary links are left alone. If the person who would review is the one who wrote the pull request, there is nobody to ask, so the link passes.

## Who is the reviewer

The person the message goes to, if the owner has written down their GitHub name in the agent's settings. Otherwise a reviewer the owner set for that repo or for all repos. Otherwise the repo owner. Never the author.

## The safeguards in plain terms

- **If asking fails, the reply waits.** A normal reply is held with a plain reason, for example "Not sent yet: this message links pull request JKHeadley/instar#3050, and I could not make JKHeadley a requested reviewer on it (GitHub did not answer in time)." The agent can retry or send the message without the link.
- **Alerts are never held.** Automatic messages, health alerts and the "shipped" or "I'm back up" notices still go out if GitHub is down; the failure is only recorded.
- **It says when retrying won't help.** If GitHub refuses for a lasting reason (the reviewer has no access to the repo, or the agent's token is not allowed), the reason says so instead of "retry in a minute".
- **It cannot hang.** All GitHub calls for one message share one time limit, 5 seconds by default, 8 at most.
- **It is off for everyone except development agents** until it has proven itself, and one setting turns it off instantly with no restart.

## What the reader needs to decide

Nothing to approve for the development agent: it is on there by default. Turning it on for every agent is a later, separate decision after a two-week trial with few held messages.
