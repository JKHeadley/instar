# Checking the original Telegram request

If you want your agent to send one exact message through Threadline, the first test version looks for a specific request format. The test request starts with a line naming the recipient by its unique fingerprint. The lines that follow are the text to send, including their spacing and line breaks.

The program needs evidence from Telegram that the original author is the current owner. It also needs to know whether the message was forwarded, quoted, sent as a reply or accompanied by media. The test refuses sources with any missing evidence. It also refuses examples that only contain the request format inside a longer explanation.

This is a parser checkpoint. Nothing listens for or sends these requests in production. Before enabling the feature, the server needs to capture authenticated evidence when the message arrives. It also needs to confirm the pairing and record one attempted delivery so retries cannot send a second copy.

The polling fixture now checks the original Telegram forum message before the adapter changes its topic number. It requires a known numeric bot account, the current owner as sender, and an explicit forum topic. If the message carries additional fields, the fixture leaves it in the ordinary approval flow. The next step is to store the evidence from authenticated polling so the send path can verify it later.

The test storage keeps a reference and a digest for each eligible original message. If Telegram presents the same evidence again, the record stays as it was. If a second copy disagrees under the same reference, the record becomes unusable for direct approval. The test store keeps no message text. Live wiring will need to check and reserve the send in one operation so a conflicting copy cannot slip in between those steps.

The test version now checks stored evidence and reserves the exact delivery in the same database transaction. If a conflicting copy was recorded first, the request is refused. The server also rechecks that the proposed recipient and message match the original Telegram update. If a send was already reserved before a conflict arrived, the later record cannot undo that attempt. It can prevent another reservation.

The storage test now covers an edit arriving before the original message. In either order, an edit makes the reference unusable. A late copy of the original cannot restore it. The production poller still needs to authenticate edit updates before it can invalidate a record.

An edit can change the request into ordinary chat or replace its text with media. The test helper uses the original chat, topic and message coordinates to find the approval record even in those cases. If an authenticated edit has too little information to locate its record, live integration must handle that uncertainty before accepting another direct approval.

The polling test now calls the same helper intended for future integration. That helper returns only after it has recorded a qualifying request or applied an edit. If it cannot apply an edit, the poller must stop and leave the update unacknowledged. The test retries the update and verifies the original request stays unusable afterward.

The real adapter now has a test-only connection point for the evidence recorder. The test calls the adapter with a simulated Telegram response. When the recorder refuses an edit, the next poll requests the same update. After the recorder accepts it, the next poll advances. No live Telegram account is part of this test.

The catch-up test now gives each poll a unique generation. An empty result can open only the current generation at the cursor it used. A later poll or explicit closure makes older results unusable. The test exercises this against SQLite. Live integration must bind the generation to the authenticated poller and check it together with the send reservation.
