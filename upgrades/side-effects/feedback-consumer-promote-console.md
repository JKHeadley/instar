# Side-Effects Review — Feedback promotion in Development

**Tier:** 1
**Author:** Echo
**Second-pass reviewer:** Not required for this console-only change.

## Summary of the change

Development counts the server's pending promotion as a single approval. The review sheet shows all items in the bounded proposal and sends its hash, bound, decision reference and PIN through the existing promotion route.

## Decision-point inventory

Proposal display follows the server’s pending state. The existing PIN, restore, ownership, evidence, promotion and checkpoint decisions remain with the server. This console fragment ships with the server proposal implementation.

## 1. Over-block

Malformed proposals, missing evidence, and invalid bounds produce no control. A valid proposal from one to fifty items is available for review. Existing authority approvals still take their original paths.

## 2. Under-block

The client cannot approve a proposal through a separate action. It passes through the approved snapshot and relies on the server's current-state check for changes during review.

## 3. Level-of-abstraction fit

The page presents the status from the owning feedback service and uses the shared PIN sheet and request helper. The console's validation handles unreadable data before display.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

The server owns mutation admission. [Signal vs Authority](../../docs/signal-vs-authority.md)

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The console needs an explicit server proposal and can only display or submit that proposal.

## 5. Interactions

Approval or stale conflict refreshes the existing page. The review explains that approved items go first and a held item can pause the consumer. A previous approval requiring renewal is displayed as such. A missing proposal route keeps the control absent on older servers. PIN entry remains scoped to the single request and is cleared after entry.

## 6. External surfaces

The Development page reads the authenticated proposal endpoint. The PIN and selected bound are sent to the same machine through the existing authenticated promotion endpoint.

## 6b. Operator-surface quality

The card leads with Promote and states the effect in everyday language. The review lists item titles first and keeps report counts and identifiers in secondary text. The page adds no destructive action. Chromium checked the card and review at 390 and 1280 pixels.

## 7. Multi-machine posture

The control belongs to the serving drain. Other machines render the server’s status and cannot send a PIN through a relay. There is no new state on the client.

## 8. Rollback cost

Revert the console commit. Existing server-side promotion records and their established approval and revoke workflow remain usable.

## Evidence

Passing console model and DOM tests exercise the full PIN lifecycle and result refresh. Chromium checks verify a pending proposal, configured simulation, stale rejection and the snapshot sent with the PIN.
