---
title: Propose a Work Board approval slip
requires: telegram
---
On a board with an enrolled slip writer, a verified owner Telegram request can be turned into one approval proposal. The recorded message must contain exactly `Approve Work Board cards: ` followed by the explicit card IDs in order, separated by a comma and space.

Call `POST /work-board/slips` on the agent server with the existing agent API authentication and JSON `{"sourceRef":"telegram:<topicId>:<messageId>"}`. The server checks the recorded owner and message, derives disclosure from current cards, and returns the slip ID, disclosure digest and expiry. The proposal does not authorize any card. The paired owner phone must still review and sign it. If the server refuses issuance, report the refusal without substituting other cards or changing the source.
