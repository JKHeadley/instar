# Side-Effects Review — one reviewer-request path for PR links

**Version / slug:** `pr-link-reviewer-dedupe`
**Date:** `2026-11-11`
**Author:** `echo`
**Second-pass reviewer:** `not required (removal of a duplicate path; no new decision logic)`

## Summary of the change

Two merged PRs did the same job: asking GitHub to add the reviewer before a pull-request link goes out. PR 3061 added `src/core/PrLinkReviewerCheck.ts`, run after every outbound check in `src/server/routes.ts` (`checkPrLinkReviewers`), dev-gated (on for a development agent like Echo, off on the fleet). PR 3063 added `src/messaging/prLinkReviewRequest.ts`, middleware on the reply routes, on by default. On a development agent both ran, so one link could trigger two reviewer requests, and 3061 could hold a reply that 3063 would have sent with a note. This change keeps 3063 and removes 3061's send-time path: the class and its tests, the route hook (the evaluator rename is undone), the `prLinkReviewer` config type, the dev-gate entry and the feature ladder. `scripts/pr-reviewer-request.mjs` keeps only the helpers `scripts/safe-merge.mjs` uses at merge time. The removed hook also covered `/whatsapp/send/:jid` and `/telegram/post-update`, which the kept route list lacked; both are added to `PR_LINK_REPLY_ROUTES` so no direct send route loses coverage. A new guard test fails if any other file in `src/` or `scripts/` POSTs `requested_reviewers`. Tier 1, 19 files including trace and decision records, mostly deletions; 2 commits (the second answers the second-pass concern).

## Decision-point inventory

- `checkPrLinkReviewers` (routes.ts, outbound evaluator) — **remove** — the 3061 hold on a failed reviewer request.
- `prLinkReviewMiddleware` (3063) — pass-through — unchanged; the one remaining path.

## 1. Over-block

Removal lowers blocking: replies are no longer held (422 `pr-link-reviewer`) when a reviewer request fails. 3063 sends them with a line saying the request could not be confirmed, as the brief asks. No new over-block.

## 2. Under-block

3061's extra options are gone: per-repo reviewers, the Telegram-id to GitHub-login team map and the repo allow-list. (The "already approved at head" skip exists in the kept path too: `skipped-approved-at-head`.) 3063 requests the configured `prLinkReviewRequest.reviewer`, else the repo owner when that owner is a person, only on the agent's own open PRs. Others' PR links are logged, not requested. That is the behaviour the operator asked to keep. Nobody set the 3061 options (it shipped dark on the fleet a day ago; Echo's config has no `prLinkReviewer` key).

Two senders the removed hook reached on development agents stay uncovered by design: `/imessage/validate-send` (the send token is bound to the exact validated text, so appending a note would break the send) `/attention` (an attention item, not a message carrying a link to a person), and the in-process Agent Updates publisher (ship notices link merged PRs, which the kept path skips because it only requests on open PRs). Both were dark on the fleet before this change.

## 3. Level-of-abstraction fit

The kept path sits on the outbound text routes, where a sent link is known and the text can still get its one-line note. The second hook in the shared evaluator duplicated the work on the four reply routes and was the only path on WhatsApp and Agent Updates; those two routes now get the kept middleware.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface (it removes one).

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

## 5. Interactions

Removes the double request. `evaluateOutbound` is again the single function (the `evaluateOutboundCore` wrapper is gone). Every caller already called `evaluateOutbound`. safe-merge keeps its merge-time request, which is a separate moment (merge refusal), not a send.

## 6. External surfaces

Fewer GitHub calls per message on development agents. A config holding `prLinkReviewer` keys is now ignored (unknown keys are harmless). No route or template changes; the agent CLAUDE.md section from 3063 already describes the kept path.

## 7. Multi-machine posture

Unchanged. 3063's middleware runs on the machine that serves the reply route.

## 8. Rollback cost

A revert restores 3061's files. No data or migration.

## Second-pass review

**Reviewer:** independent general-purpose subagent (fresh context, given the code and this artifact, not the author's conclusion), 2026-11-11.

First pass: "Concern raised": (1) this artifact wrongly listed the approved-at-head skip as lost; (2) the removed hook was the only path on `/whatsapp/send`, `/imessage/*`, `/telegram/post-update`, `/attention` and the Agent Updates publisher, which the artifact did not disclose; (3) file count was off. Verified clean: no leftover references, kept path delivers the required behaviour, deleted tests covered only removed code, safe-merge imports still exported.

Resolution: (1) and (3) corrected above. (2) WhatsApp and `/telegram/post-update` added to `PR_LINK_REPLY_ROUTES` with a unit test; iMessage, `/attention` and the in-process Agent Updates publisher documented as uncovered by design in section 2. After these changes the reviewer's concerns are resolved: Concur with the review.
