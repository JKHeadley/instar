# Trust approvals show text rebuilt from the change itself

<!-- bump: patch -->

## What Changed

SEC-141. A trust-raise request stores both the change and a `summary` written once by `summarize(change)`. The approval list (`deviceListing`), the phone approval (`onPresenceApproval`) and the chat approval showed or confirmed that stored text, and the replicated store accepted it as-is, so a forged request could pair a harmless summary with a dangerous change and a matching hash. `AccountPathService` now rebuilds the text from the change wherever a person reads it (`verified`): the chat card, including a deferred card re-sent from the stored record, the app listing, the agent-facing `GET /trust/requests`, and the "Done" replies. A request whose change does not hash to its recorded `proposalHash`, or that has no change (records from before changes were stored), is treated as altered: not listed, no card, not approvable (`request-altered`). `TrustJourneyStore` now fixes a request's change and hash by the first record seen for it; a later record may only add the card ids, and only under the same hash, so it cannot swap what a card the owner already saw would approve.

## What to Tell Your User

- **Approvals match the change**: "When I ask you to approve more freedom, the description you see is now always rebuilt from the actual change, so it can't say one thing while the change does another."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Trust approval text derived from the change; altered requests refused | Automatic |

## Evidence

- `tests/unit/trust-journey-device-approval.test.ts` (2 new): a forged request (harmless summary and hash, dangerous change) is neither listed nor approved; a request whose stored summary differs from its change shows and confirms the derived text.
- `tests/unit/trust-journey-account-path-service.test.ts` (2 new): a deferred chat card is built from the change, not the stored summary; a later record naming the real card cannot replace the request's change (the original change is applied). All four fail on main.
