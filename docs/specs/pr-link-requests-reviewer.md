---
title: PR links request their reviewer
slug: pr-link-requests-reviewer
eli16-overview: pr-link-requests-reviewer.eli16.md
status: tier-1
author: echo
created: 2026-11-10
tier: 1
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
---

# PR links request their reviewer

- **ladder:** prLinkReviewer

## Why this exists

Operator directive (Justin, 2026-11-10): "every time you send me a link [to a pull request], I actually am a requested reviewer."

Evidence: none of the last 15 `JKHeadley/instar` pull requests had a requested reviewer. CODEOWNERS only auto-requests the owner on `docs/STANDARDS-REGISTRY.md` and `.github/CODEOWNERS`, and a dismissed review (any push after an approval, under `require_last_push_approval`) clears the request. The operator opens the link, finds no review waiting for him, and has to ask for one or hunt for the Files tab.

## What already exists

- `scripts/safe-merge.mjs` `resolveReviewers()` / `requestReviewers()`: default reviewer is the repo owner, never the PR author; `POST repos/{repo}/pulls/{n}/requested_reviewers`. It runs only when a merge is refused for a missing approval, which is after the agent has usually already sent the link.
- `scripts/local-verify-floor.mjs` `approvedAtHead()`: the shared "did this login approve the current head" judge, used by safe-merge, the green-PR auto-merger and the feedback factory's review gate.
- `src/core/githubRuntime.ts`: the server's explicit GitHub identity (`GITHUB_TOKEN`, then the agent vault); never the machine's `gh` keychain seat.
- `evaluateOutbound` in `src/server/routes.ts`: the single outbound evaluator. Every person-facing send path reaches it: `/telegram/reply` (through `checkOutboundMessage`), `/slack/reply`, the app conversation reply, WhatsApp, iMessage, the Telegram origin boundary's send policy, and the Agent Updates publisher. A pool standby with no Telegram token skips its local gate and relays to the lease holder, whose `/telegram/reply` receive path re-enters the evaluator.

## Design

### Shared logic

`scripts/pr-reviewer-request.mjs` (pure, with `.d.mts` types, the established `scripts/*.mjs` + `src` import pattern):

- `extractPullRequestLinks(text)` — distinct `github.com/{owner}/{repo}/pull/{n}` links, sub-pages and anchors folded into their PR, at most 5 per message. Issue links, bare `#123` and other hosts are not PR links.
- `resolveReviewerLogins({ explicit, repoOwner, author })` — explicit logins, else the repo owner; never the author (case-insensitive); invalid logins dropped.
- `requestedReviewerLogins`, `confirmedRequested`, `toReviewLike` — response parsing.

`safe-merge.mjs` now uses `resolveReviewerLogins` and `confirmedRequested` instead of its inline copies. Its behavior is unchanged apart from case-insensitive author and confirmation matching.

### The send-time check

`src/core/PrLinkReviewerCheck.ts`, called from a thin wrapper: `evaluateOutbound` = the existing evaluator (renamed `evaluateOutboundCore`) and, only when that approves, `checkPrLinkReviewers`. Running last means a message held for any other reason never causes a GitHub call.

Per PR link, with ONE time budget shared by every GitHub call of the message (default 5 s, clamped 1-8 s; kept well under the 15 s standby-to-holder relay timeout, which the holder's tone gate also spends):

1. Outside the optional `repos` allowlist → pass.
2. `GET /repos/{o}/{r}/pulls/{n}`. 404 → pass (this agent cannot see it, so it is not its PR to act on). 401/403 → fail `github-auth`. Other non-2xx, or a 2xx whose body cannot be read as a PR → fail `github-unreachable` (never read as "not open").
3. Not open (closed or merged) → pass.
4. `base.repo.permissions` present with none of admin/maintain/push/triage → pass (not a repo this agent works in; it could not request a reviewer there anyway).
5. Reviewer = the first of [recipient's mapped login, per-repo login, default login] that is not the PR author, else the repo owner when the owner is a user (an organisation cannot be a reviewer) and not the author. Nobody left → pass.
6. Already in `requested_reviewers` → pass. Else `GET .../reviews`; the reviewer's latest non-comment review is APPROVED at the current head sha (`approvedAtHead`) → pass.
7. `POST .../requested_reviewers {reviewers:[login]}`. 2xx and the login is listed → pass. 2xx but not listed → fail `request-not-confirmed`. 404 → pass (the token cannot write here; same as step 4). 422 → fail `request-rejected` (with GitHub's message). 401/403 → `github-auth`. Network error → `github-unreachable` (error class name only, never the message). Budget exceeded, including while a response body is still being read → `github-timeout`. No token → `no-github-token`.

A satisfied (PR, reviewer, head sha) triple is remembered for 60 s so a quick re-send skips the reviews read and the POST.

### Hold or deliver

A failure holds the message only when the sender can react: `liveArtefactSignals === true` (the caller carries the acknowledge path), not a sentinel redrive (`noReactionPossible`), not an availability-first channel (`failClosedOnBudgetTimeout: false`, which `/telegram/post-update` sets for ship and restart notices), and kind `reply`. The hold is `422 { blockedBy: 'pr-link-reviewer', notSent: true, pr, reviewer, failReason, retryable, error: <plain English> }`. `retryable` is false for failures that recur until a person fixes something (`no-github-token`, `github-auth`, `request-rejected`), and the plain reason then says retrying will not help and to send without the link; otherwise it is true and the reason says to retry in a minute. The plain reason reads: "Not sent yet: this message links pull request JKHeadley/instar#3050, and I could not make JKHeadley a requested reviewer on it (GitHub did not answer in time). Every pull-request link sent to a person must arrive with them already asked to review. Retry in a minute, or send the message without the link."

Automated sends, health alerts, `/telegram/reply` redrives, `/telegram/post-update` notices and the growth-digest publisher are delivered even when the request fails, and the failure is recorded: a GitHub outage must never silence a health alert or a "back up" notice. One accepted exception, mirroring the tone gate: the Telegram origin boundary's send policy passes session records as reactable replies with no redrive marker, so an outbox replay of a session record after a restart can be held; it is held there with the same reason the tone gate's verdicts already use. Proxy and system-template sends on `/telegram/reply` skip the outbound evaluator by design and are not checked. A defect (throw) inside the check is recorded and the message is delivered: only a failed GitHub request holds.

### Where it runs

On the machine that executes the send. A tokenless standby relays without evaluating (existing `willRelay` behavior), and the lease holder's receive path runs the full evaluator, including this check, with the holder's GitHub identity. The Telegram origin boundary's send policy calls the same evaluator on the executing machine.

## Team and privacy

- **Who is asked:** the person the message goes to, when the owner has mapped that person's Telegram user id to a GitHub login in `prLinkReviewer.githubLogins` and the topic has a verified operator (`topicOperatorStore.asVerifiedOperator`). Otherwise the configured per-repo or default login, otherwise the repo owner. A member or guest with no mapping never causes a request in their own name, and a request is never made on behalf of the PR author.
- **Who can change it:** the mapping lives in the agent's own config, which only the owner edits. No new route, no new team permission, nothing shareable is created.
- **What is revealed:** nothing new. The request is visible on GitHub to whoever can see the PR already. Messages are not stored by this check; evidence rows carry the PR id, reviewer login and channel only.

## Config

Top-level `prLinkReviewer` (top level because `messaging` is an array of adapters), read live:

| key | default | meaning |
|---|---|---|
| `enabled` | omitted | dev-gated: live on a development agent, dark on the fleet; explicit wins |
| `reviewer` | repo owner | default reviewer login |
| `repoReviewers` | — | `{ "owner/repo": "login" }` |
| `githubLogins` | — | `{ "<telegram user id>": "login" }` team mapping |
| `repos` | all writable | only check these repos |
| `timeoutMs` | 5000 | per-message budget, 1000-8000 |

Registered in `DEV_GATED_FEATURES` and the maturation ladder (`prLinkReviewer`: evidence `fired` = review requested, `held`, `error`).

## Decision points touched

- `evaluateOutbound` (modify): adds one deterministic step after every existing check. It holds only on an objective, external fact (GitHub did not accept or confirm a request the operator mandated), not a judgment about content.

## Multi-machine posture

Machine-local by design, executed where the send executes. No durable state (the 60 s satisfied cache is per process and only skips repeat calls). Requests are idempotent at GitHub, so two machines evaluating the same message (a relay settling locally after the hop) at worst ask twice for the same reviewer. No notices, no URLs generated.

## Tests

- `tests/unit/pr-reviewer-request.test.ts` — link extraction, reviewer resolution, response parsing.
- `tests/unit/PrLinkReviewerCheck.test.ts` — every pass, fail and budget path against a fake GitHub.
- `tests/unit/pr-link-reviewer-route.test.ts` — `/telegram/reply`: request then send; hold with plain reason (non-retryable on 422, retryable on 502); automated delivered; `/telegram/post-update` delivered on failure; dark on fleet; explicit off; team mapping; default reviewer; relaying standby makes no call; no-link message untouched.
- Existing: safe-merge suites, dev-gated wiring, ladder coverage.

## Rollback

`prLinkReviewer.enabled: false` turns it off at the next send (read live). Code revert removes it; no persistent state, no migration. A review request already made stays on GitHub, which is the desired end state anyway.

## Fleet rung precondition

Before the fleet flip, the agent-facing CLAUDE.md note (the agent no longer needs to request reviews by hand before sending a link) ships with the flip, recorded in the ladder entry's plan.
