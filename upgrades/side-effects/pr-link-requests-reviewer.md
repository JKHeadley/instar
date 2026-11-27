# Side-Effects Review — PR links request their reviewer

**Version / slug:** `pr-link-requests-reviewer`
**Date:** `2026-11-10`
**Author:** `echo`
**Second-pass reviewer:** `independent review subagent (see Second-pass review)`

## Summary of the change

Operator directive (Justin, 2026-11-10): "every time you send me a link [to a pull request], I actually am a requested reviewer." The shared outbound evaluator in `src/server/routes.ts` (`evaluateOutbound`, the funnel behind `/telegram/reply`, `/slack/reply`, the app reply, WhatsApp, iMessage, the Telegram origin send policy and the Agent Updates publisher) now ends with one step: for every open GitHub pull request linked in the message, make sure the reviewer is requested (or approved the current head), requesting them through GitHub's REST API with the agent's explicit server identity. New `src/core/PrLinkReviewerCheck.ts`; new shared pure module `scripts/pr-reviewer-request.mjs` (+ `.d.mts`), which `scripts/safe-merge.mjs` now uses for its reviewer resolution and confirmation; config type `prLinkReviewer` in `src/core/types.ts`; dev-gated registry entry in `src/core/devGatedFeatures.ts`; ladder entry in `src/data/feature-ladders.json`. Tier 1 declared (flag-gated, dev-gated live / fleet-dark, a revert or `enabled:false` fully undoes it); the risk floor is higher because it adds a hold on an outbound path and an external write, and that is recorded as a below-floor declaration. Size: 3 new source files, 5 modified source/data files, 3 new test files; about 400 lines of source. Effort: one design pass, one independent review round.

## Decision-point inventory

- `evaluateOutbound` (`src/server/routes.ts`) — modify — wraps the existing evaluator (renamed `evaluateOutboundCore`, behavior byte-identical) and adds `checkPrLinkReviewers` after it approves. Holds only when GitHub fails to accept or confirm a review request for an open PR and the sender can react.
- `safe-merge.mjs` `resolveReviewers` / `requestReviewers` — modify (refactor) — same decisions, now through the shared module; author and confirmation matching became case-insensitive.

---

## 1. Over-block

- **A linked PR in a repo the agent can write to but where the reviewer is not a collaborator** (e.g. a fork contributor's repo configured by mistake): GitHub returns 422, the reply is held with GitHub's message and `retryable: false`. The reason says retrying will not help until the reviewer setting or their access is fixed, and to send without the link for now. This failure recurs for every message linking that PR until a person acts; that is the operator's fail-closed choice, made visible rather than looping.
- **GitHub outage or an expired agent token on a development agent:** every reply with an open-PR link is held until GitHub answers. Bounded (5 s per message by default), reason is plain, the agent can send without the link. This is the operator's "fail closed" choice.
- **No GitHub token on a development agent:** every open-PR link the agent can see is held with "this agent has no GitHub token to ask with". Dev agents are expected to have one; the plain reason makes the missing setup obvious.
- **Third-party PRs** (linking an upstream project's PR for reference): GET succeeds, but the repo is not writable (`permissions` all false) or the owner is an organisation with no configured reviewer, so the link passes. A public repo read with a token whose `permissions` field is absent and whose owner is a user would attempt a request and could be held on the 422. Mitigation available live: `prLinkReviewer.repos` allowlist.
- **Automated sends, health alerts, `/telegram/reply` redrives, `/telegram/post-update` notices (availability-first, `failClosedOnBudgetTimeout: false`), growth digest:** never held (recorded only).
- **Telegram origin outbox replay of a session record** (after a restart, or a remote-origin forward): the origin send policy passes session records as reactable replies with no redrive marker, so such a replay can be held. This mirrors how the tone gate's verdicts already treat the same path; accepted, not new behavior class.

## 2. Under-block

- More than 5 distinct PR links in one message: only the first 5 are checked.
- A PR referenced without a URL (`#3050`, "PR 3050") is not a link the reader can click and is not checked.
- A PR whose reviews exceed 100 entries: an approval past the first page is missed and the reviewer is re-requested (harmless).
- A 404 on the PR view passes, which includes a private repo the token cannot see. That PR's reviewer is not requested; the agent could not have requested it anyway.
- A push after the send dismisses the approval and clears the request again; the next message that links the PR re-requests. Messages that do not link the PR do not.
- Proxy and system-template sends on `/telegram/reply` skip `evaluateOutbound` by design, so a presence-proxy text that quoted a PR link would not be checked. These are fixed templates and proxy status lines, not the agent sending a person a link.

---

## 3. Level-of-abstraction fit

Right layer: the single outbound funnel is where "every link sent to a person" is observable on every channel, and it runs on the machine that executes the send (the standby relays without evaluating; the holder evaluates on receipt). Placed after every existing check so a message held for other reasons makes no GitHub call. GitHub I/O lives in its own class with an injectable fetch; reviewer logic is shared with safe-merge instead of duplicated; "approved at head" reuses `local-verify-floor.mjs`'s `approvedAtHead`, the judge safe-merge and the auto-merger already use. Auth reuses `githubRuntime`'s explicit identity resolver.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [x] Yes, deterministic — and the hold is on an objective external fact, not a judgment of content.

The check does not judge what the message means. It holds only when a mandated side effect (GitHub listing the reviewer) objectively did not happen, the same shape as the localhost-link guard and the 4096-length check that already sit in this funnel. Its detector part (URL extraction) has no authority on its own: a matched link that turns out closed, merged, unseen, read-only or self-authored passes. The brittle-pattern risk signal-vs-authority warns about (over-matching ordinary text) cannot hold a message here, because a hold additionally requires GitHub to have answered that an open, writable PR's request failed. Automated and unreactable sends are never held, and a defect in the check fails open.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Is reviewer X requested on open PR Y at head Z" is an enumerable invariant answered by GitHub, and the operator directive makes it a floor.

---

## 5. Interactions

- **Shadowing:** runs after `evaluateOutboundCore` approves; it cannot shadow the credential wall, localhost guard, fold hold or tone gate, and is not reached when they hold. `checkOutboundMessage`'s observers and attribution recording run as before; attribution's `finish` hook records only on 2xx, so a held message is not recorded as sent.
- **Double-fire:** a relay that settles locally after the hop (`OriginForwardSettledLocallyError`) re-runs the gate locally; the request is idempotent and the 60 s cache usually skips the repeat. safe-merge may also request at merge time; idempotent at GitHub.
- **Races:** the satisfied cache is per process and keyed by head sha, so a push between two sends is re-checked.
- **Feedback loops:** none. The hold returns 422, which the recovery policy treats as terminal (no retry storm); the sending session reads the reason.
- **Content dedup:** `/telegram/reply` takes its in-flight reservation after the gate, so a held message never reserves its fingerprint and a retry is not suppressed.

---

## 6. External surfaces

- **GitHub:** new writes, `POST /repos/{o}/{r}/pulls/{n}/requested_reviewers`, only on open PRs in repos the token can write to, only for a login that is not the author. Reads: the PR view and its reviews. Bounded per message.
- **Other agents / install base:** dark on the fleet; live on development agents only.
- **Persistent state:** evidence rows in `logs/feature-evidence.jsonl` (PR id, reviewer login, channel). No message text stored.
- **Timing:** adds up to the budget (default 5 s, configurable 1-8 s, capped under the 15 s standby relay timeout that the holder's tone gate also spends) to a send that links an open PR on a development agent; zero for messages without PR links (a regex pre-filter).
- **Operator surface:** no operator-facing action added. The operator's experience is the GitHub review request itself.

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN, executed where the send executes.** A tokenless standby skips its local gate when it will relay (`willRelay`) and the lease holder's `/telegram/reply` receive path runs `evaluateOutbound`, including this check, with the holder's GitHub identity; the Telegram origin boundary calls the same evaluator on the executing machine. Slack/app/WhatsApp/iMessage evaluate on the machine whose adapter sends. No durable state (the cache is per process), no user-facing notices of its own, no generated URLs. Status surfaces: none added or changed.

---

## 8. Rollback cost

`prLinkReviewer.enabled: false` stops it at the next send (read live, no restart). A code revert removes it with no migration and no state to clean. Review requests already made stay on GitHub, which is the intended end state.

---

## Conclusion

The change satisfies the directive at the one funnel every person-facing channel shares, on the machine that executes the send, with the reviewer logic shared with safe-merge rather than duplicated. The hold is deterministic, bounded, limited to senders that can react, and tied to an objective GitHub result. Dark on the fleet; the fleet flip is gated by the ladder's soak metrics (held rate and error rate at most 5 percent) and ships with the agent-facing CLAUDE.md note. Clear to ship to development agents.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose review subagent (fresh context, given the code and the directive, not this artifact's conclusions)
**Independent read of the artifact: concur** (round 2, after the round-1 concerns below were fixed and re-verified)

Round 1 raised six concerns; each was fixed in code with a test, or the artifact was corrected:

- Agent Updates ship notices could be held (`/telegram/post-update` opts into the acknowledge path). Fixed: a hold also requires `failClosedOnBudgetTimeout !== false`; route test "an Agent Updates ship notice is delivered even when the request fails".
- Permanent failures (non-collaborator 422, 403) said "retry". Fixed: `isPermanentPrLinkFailure` sets `retryable: false` and the reason says retrying will not help. A 404 on the request now passes like a read-only repo, consistent with the 404 on the view. Tests added.
- A deadline firing during the body read returned a null body that read as "not open", letting a link pass. Fixed: abort after the read is `github-timeout`, and an unreadable 2xx view is `github-unreachable`. Tests added.
- The budget could outlast the 15 s relay. Fixed: maximum 8 s.
- Origin outbox replays can be held. Accepted, mirroring the tone gate; recorded under Over-block.
- A mapped recipient who is the PR author blocked the fallback to the configured reviewer. Fixed: candidates fall through in order, then the repo owner; test added. The proxy/system-template skip is now stated under Under-block.

The reviewer also confirmed by reading the code: no double-run on standby relay, the holder re-enters the full check, a 422 returns verbatim through `TelegramRelay`, the settled-locally fallback re-gates, no token leakage, the hold matches the localhost-link-guard shape, and the safe-merge refactor is behavior-equivalent.

---

## Evidence pointers

- `tests/unit/pr-reviewer-request.test.ts`, `tests/unit/PrLinkReviewerCheck.test.ts`, `tests/unit/pr-link-reviewer-route.test.ts`.
- Red check: with `evaluateOutbound` not calling `checkPrLinkReviewers`, 4 of the route tests fail (request, hold, team mapping, default reviewer).

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. Not a self-triggered controller: it fires only inside a send the agent already initiated, once per message, with no retry, respawn or notify of its own.
