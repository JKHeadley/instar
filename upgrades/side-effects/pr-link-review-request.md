# Side-Effects Review — PR links request the reviewer on GitHub before the reply goes out

**Version / slug:** `pr-link-review-request`
**Date:** `2026-11-10`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

New `src/messaging/prLinkReviewRequest.ts`: an Express middleware mounted at the top of `createRoutes` (before `mountTelegramOriginRoutes`, so the origin send policy binds the final text) on `/telegram/reply/:topicId`, `/slack/reply/:channelId`, `/slack/session-reply` and `/app/session-reply`. For each github.com pull-request link in `req.body.text` (max 5), it reads the PR with the agent's authenticated gh (`createAuthenticatedGhExec`), and for an OPEN PR authored by the agent's own login it requests the reviewer (config `prLinkReviewRequest.reviewer`, else the repo owner when type User) unless already requested or already approved at the head, then reads `GET /pulls/N/requested_reviewers` back. If unconfirmed on a PR known to be the agent's own, one plain note line is appended (only when it fits the route's length limit). A PR that cannot be read is `unreadable`: logged, no note — CI found the first version annotating a link to someone else's PR when GitHub was unreachable (`tests/integration/slack-mrkdwn-reply-route.test.ts`). Config type in `src/core/types.ts`; CLAUDE.md section in `src/scaffold/templates.ts` + `migrateClaudeMd` in `src/core/PostUpdateMigrator.ts`. Tier 1: small, reversible by revert, no stored state. Size: ~230 LOC source + tests, 1 review round, 1 commit attempt.

## Decision-point inventory

- PR-link reviewer check — add — decides whether to POST a review request on GitHub and whether to append a note. Never decides whether a message is sent.
- Outbound reply routes — pass-through — the text may gain one appended line; every existing gate (stand-down, invisible payload, length, tone gate, origin send policy) runs after and sees the final text.

---

## 1. Over-block

No block/allow surface — the middleware never refuses a request and calls `next()` on every path, including thrown errors. A GitHub outage costs at most 10 s of latency (kept well under the 35 s client timeout in slack-reply.sh / app-reply.sh, which must also cover the tone gate) on a reply that contains a PR link.

---

## 2. Under-block

- A PR referenced only as "#3046" without a URL is not checked (no repo is known). Links are what the operator taps; this matches his statement ("every time you send me a link").
- Replies sent through routes other than the four listed (e.g. `/telegram/post-update`, direct `sendToTopic` system notices) are not checked; those are not approval asks.
- If the operator's review is dismissed AFTER the link was sent, nothing re-requests it until the next link. GitHub owns that state.

---

## 3. Level-of-abstraction fit

The outbound reply routes are the single funnel every operator-facing message from a session passes through, so it covers hand-written replies, skills and scripts alike. Putting it in `safe-merge` alone (where a request already existed) is exactly what left the gap. The GitHub calls reuse the existing authenticated gh runtime (`githubRuntime.ts`) rather than a new auth path.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

It performs an idempotent GitHub action and may append a factual note; it never holds, drops or rewrites the agent's words.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The rules (open, agent-authored, not requested, not approved at head) are enumerable facts read from GitHub.

---

## 5. Interactions

- **Shadowing:** runs before the origin send-policy middleware and the route handlers; the appended note then goes through the tone gate like any text. Dedup: a retried reply re-checks and finds "already-requested" (no second POST); delivery-id dedup is header-keyed and unaffected (see second-pass note on the app route's text-repeat check).
- **Double-fire:** `safe-merge` may also request the same reviewer; GitHub treats a repeat request as a no-op, and this module skips when already requested.
- **Races:** none — no shared state except a per-process cached agent login.
- **Feedback loops:** none.
- **System templates / proxy messages:** skipped (`X-Instar-System: true` or `metadata.isProxy`) so template matching is never disturbed.

---

## 6. External surfaces

- GitHub: POST `requested_reviewers` on the agent's own open PRs — notifies the reviewer, which is the intent. Never on others' PRs, closed PRs, or an approved head.
- Telegram/Slack/app: a reply may carry one extra line when the request cannot be confirmed.
- Other agents: on by default fleet-wide; for an agent whose PRs live in a user-owned repo it requests that owner (same default as `safe-merge`). Off with `prLinkReviewRequest.enabled: false`.
- Operator surface: no new operator actions.

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: the check runs on whichever machine sends the reply, against GitHub (the shared source of truth), so every machine reaches the same answer; no state, no notices of its own, no URLs generated. No status surfaces added.

---

## 8. Rollback cost

Pure code change — set `prLinkReviewRequest.enabled: false` (read per request) or revert and ship a patch. No persistent state. The CLAUDE.md section would remain on migrated agents and describe a disabled feature until removed by a later migration.

---

## Conclusion

Clear to ship. Design choice made in review: never block a reply on GitHub (the relay is mandatory); an unconfirmed request is reported in the message instead. The approved-at-head skip was added so a re-sent link does not re-ping a reviewer who already approved.

---

## Second-pass review (if required)

**Reviewer:** independent second-pass subagent
**Independent read of the artifact: concur** (no blocking defects; the middleware calls `next()` exactly once on every path, cannot throw past it, is bounded at 20 s, only appends to `text` so the slack/app body-key and length checks still pass, and is mounted before the origin send-policy so the policy binds the final text). Minor notes, none blocking:
- §5 "its text is identical, so delivery dedup still matches" is not always true: if the first attempt appended the note and a retry confirms the request, the retry's text differs. Delivery-id dedup is header-keyed so Telegram/Slack are unaffected; only the app route's exact-repeat suppression could miss.
- The check runs before each route's own refusals (stand-down 409, bind-token 403, not-owner 409), so a reply that is then refused can still have requested the reviewer on GitHub. Harmless (it is the intended request), but "before the reply goes out" is not "only if it goes out".
- The 20 s budget shares `slack-reply.sh`/`app-reply.sh`'s 35 s client `--max-time` with the tone gate; a slow GitHub plus a slow tone gate could push a Slack/app reply into a client-side timeout.

**Author response:** budget lowered to 10 s (`PR_LINK_BUDGET_MS`) for the third note. The first two are accepted as described: delivery-id dedup is header-keyed, and a request made for a reply that is then refused is the intended request.

---

## Evidence pointers

- `tests/unit/prLinkReviewRequest.test.ts` (12), `tests/integration/pr-link-review-request-route.test.ts` (3), `tests/unit/PostUpdateMigrator-prLinkReviewAwareness.test.ts` (1) — all green locally.
- Live: agent's real gh runtime against #3046 → already-requested; #3052 → skipped-not-open.
