# Side effects: trust approvals show text rebuilt from the change (SEC-141)

In plain words: the description a person approves is rebuilt from the change itself each time, and a request that does not match its own change is refused.

Tier 1. Size: 3 source files (`AccountPathService.ts`, `TrustJourneyStore.ts`, `src/server/routes.ts` `GET /trust/requests`), 2 test files extended.

## What changes
- New private `verified(req)`: requires a change, recomputes `proposalHashOf(proofSubject(change))` and compares it with the record's `proposalHash`, then returns `summarize(change)`. Any failure (no change, mismatch, summarize throwing) is logged as `trust-request-altered` and treated as altered.
- `deviceListing`: altered requests are left out; every listed row's `summary` is the derived text.
- `onPresenceApproval`: after the existing proposal-hash check, an altered request is refused with `request-altered` ("This request does not match the change it would make, so nothing was approved. The agent can send a fresh one."). The "Done" message names the derived text.
- Chat approval: the same check before consumption, with the same words as a threaded reply; the "Done" reply names the derived text.
- `sendCard`: the card text is the derived summary; an altered request gets no card ("undelivered", nothing approvable). This covers the deferred card re-sent when the owner accepts.
- `GET /trust/requests` (agent-facing): rows carry the derived summary; altered requests are left out (`derivedSummary`, public).
- `TrustJourneyStore` fold: a request's change and proposal hash are fixed by the first record seen for its id. A later record may add `cardMessageId`/`cardChatId` only when its `proposalHash` equals the first; any other later record is ignored. Honest card records always carry the same hash, so nothing honest changes.
- Records with no `change` (written before changes were stored) are hidden and refused; any such request was already past its 7-day card life.
- The "This would widen:" lines come from `raisesOf`, which reads current trust state, so they can differ slightly between the card, the listing and "Done"; the "Change:" line depends only on the change and is always the same. Accepted: the text describes the change as it is when shown.
- Not changed: the hash check at apply time (`proofCovers`), the record format. No app change: the app shows what the listing returns.
- For honest records nothing a person sees changes: the stored summary was written by the same `summarize(change)`.

## Signal vs authority
The refusal is a consistency check on the server's own record, not a new authority.

## Rollback
Revert the commit. No state change.

## Tests
- `trust-journey-device-approval` (+2), `trust-journey-account-path-service` (+2), `mobile-trust-approval-routes`: 60 pass. Also pass: `trust-journey-account-path`, `-corrupt-state`, `-governed-effects`, `-proof-check`, `-store`, `-review-c`.

## Second-pass review

**Reviewer:** independent Claude reviewer subagent, two rounds. Round 1 was blocking: a deferred chat card was still rendered from the stored summary (a forger who writes the true hash of their own dangerous change passes a hash check), a later request record could replace a request's change while naming the real card, and the agent-facing route returned stored text. All three are fixed here with tests. Round 2 verdict: concur.

Left as noted: no unit test drives a chat approval into an altered request that already has a card (the store rule now makes it hard to reach); a dropped later record with a different hash is not logged yet.
