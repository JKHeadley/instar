# Conversation and Effort Hierarchy — Review Round 4

**Reviewed:** `conversation-effort-hierarchy-v2.md`, 2026-11-04. **Status:** architecture and privacy review in progress. DAWN has not replied in the Threadline review thread.

## Confirmed existing behavior

The installed `MobilePeople.mayUseConversation` contract permits owner reads; MSP reads of Telegram; Slack reads only with the owner's Slack grant; the MSP's own native app conversations; and owner app conversations only with `ownerConversations`. It denies another MSP's app conversation and unknown refs. The installed `/mobile/conversations` route filters after merging rows, so its cursor may advance past hidden rows; for pool reads, it also fails closed on an MSP app row that has not replicated locally.

## Resulting spec change

Section 7.4 now requires hierarchy filtering before counts, sorting, pagination, search, digests, and cross-links. It gives a five-principal acceptance matrix and covers revocation between pages, unreplicated peer rows, hidden-only efforts, and inaccessible conflict destinations. It also requires an actual human principal for the dashboard view; an agent token does not identify the person whose permissions should apply.

## Remaining blockers

1. **P1 — Dashboard principal and grant parity:** identify the dashboard's authenticated human identity seam and prove it can call the same visibility predicate as mobile. If no such seam exists, stage owner-only dashboard hierarchy until it is added.
2. **P1 — Journal recovery and reducer:** prove no-loss replay or snapshots after gaps and converge concurrent user corrections without last-writer-wins hiding an edit.
3. **P2 — Product validation:** test deep mobile navigation, correction conflict, and screen-reader access with a prototype.
4. **P2 — DAWN and calibration:** incorporate DAWN's first-hand review and run a real-topic pilot for inference and attention thresholds.

**Verdict:** The privacy contract is materially more precise. The spec is still not converged.
