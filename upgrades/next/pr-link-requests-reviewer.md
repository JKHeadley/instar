## What Changed
- **Pull-request links arrive with their reviewer already asked.** Before a reply to a person is sent (Telegram, Slack, the Instar app, WhatsApp, iMessage), every open GitHub pull request it links gets its reviewer requested on GitHub, unless they are already requested or already approved the latest version. The reviewer is the person the message goes to when the owner has mapped their GitHub login in `prLinkReviewer.githubLogins`, else a configured `prLinkReviewer.reviewer` / `repoReviewers` login, else the repo owner; never the author. Merged or closed pull requests, links the agent cannot see, and repos it cannot write to pass untouched. If GitHub refuses or does not answer within the time budget (5 s default), a conversational reply is held with a plain reason ("Not sent yet: this message links pull request ...") so the agent can retry; automated sends and health alerts are still delivered. The merge helper and this check now share one reviewer implementation (`scripts/pr-reviewer-request.mjs`). Live on development agents, dark on the fleet (`prLinkReviewer.enabled`, read live).

## What to Tell Your User
Nothing changes for you yet unless you run a development agent. On a development agent, when I send you a link to a pull request, you will already be asked to review it on GitHub, so the link opens straight onto a review waiting for you.

## Summary of New Capabilities
- Send-time reviewer request for pull-request links in outbound messages (`prLinkReviewer`, dev-gated).
- Team mapping from a person's Telegram id to their GitHub login so the recipient is the reviewer.

## Evidence
- `tests/unit/PrLinkReviewerCheck.test.ts`: request, already-requested, approved-at-head, stale approval re-request, merged/closed/unseen/read-only/org/self-authored pass, 422/unconfirmed/auth/5xx/network/no-token fail, bounded timeout, repeat-send cache.
- `tests/unit/pr-link-reviewer-route.test.ts`: through `/telegram/reply`, request then send, hold with plain reason and no send, automated delivered, dark on fleet, explicit off, team mapping, default reviewer, relaying standby makes no call.
- `tests/unit/pr-reviewer-request.test.ts` plus the existing safe-merge suites: the shared logic and safe-merge unchanged in behavior.
