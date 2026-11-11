# Side-Effects Review — one reviewer-request path for PR links

**Version / slug:** `pr-link-reviewer-dedupe`
**Date:** `2026-11-11`
**Author:** `echo`
**Second-pass reviewer:** `not required (removal of a duplicate path; no new decision logic)`

## Summary of the change

Two merged PRs did the same job: asking GitHub to add the reviewer before a pull-request link goes out. PR 3061 added `src/core/PrLinkReviewerCheck.ts`, run after every outbound check in `src/server/routes.ts` (`checkPrLinkReviewers`), dev-gated (on for a development agent like Echo, off on the fleet). PR 3063 added `src/messaging/prLinkReviewRequest.ts`, middleware on the reply routes, on by default. On a development agent both ran, so one link could trigger two reviewer requests, and 3061 could hold a reply that 3063 would have sent with a note. This change keeps 3063 and removes 3061's send-time path: the class and its tests, the route hook (the evaluator rename is undone), the `prLinkReviewer` config type, the dev-gate entry and the feature ladder. `scripts/pr-reviewer-request.mjs` keeps only the helpers `scripts/safe-merge.mjs` uses at merge time. A new guard test fails if any other file in `src/` or `scripts/` POSTs `requested_reviewers`. Tier 1, 13 files, mostly deletions; 1 commit attempt planned.

## Decision-point inventory

- `checkPrLinkReviewers` (routes.ts, outbound evaluator) — **remove** — the 3061 hold on a failed reviewer request.
- `prLinkReviewMiddleware` (3063) — pass-through — unchanged; the one remaining path.

## 1. Over-block

Removal lowers blocking: replies are no longer held (422 `pr-link-reviewer`) when a reviewer request fails. 3063 sends them with a line saying the request could not be confirmed, as the brief asks. No new over-block.

## 2. Under-block

3061's extra options are gone: per-repo reviewers, the Telegram-id to GitHub-login team map, the repo allow-list, and the "already approved at head" skip. 3063 requests the configured `prLinkReviewRequest.reviewer`, else the repo owner when that owner is a person, only on the agent's own open PRs. Others' PR links are logged, not requested. That is the behaviour the operator asked to keep. Nobody set the 3061 options (it shipped dark on the fleet a day ago).

## 3. Level-of-abstraction fit

The kept path sits on the reply routes, where a sent link is known. A second hook in the shared evaluator was the wrong shape. It ran for every channel and duplicated the work.

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
