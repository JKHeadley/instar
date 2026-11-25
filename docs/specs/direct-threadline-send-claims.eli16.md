# One record for a requested send

When you directly request a Threadline message, this prototype can reserve one attempt for that exact request. If the server restarts or loses the response, it can refer to the original delivery instead of starting another. The prototype has no live send entry point. Connecting it will require verified owner evidence and a durable record that the next serving machine can recover.

For example, suppose you ask your agent to send a specific status update to a paired agent. The record binds that request to the exact wording, recipient, conversation and delivery identifier. Changing any of those details requires new authorization. Once an attempt is reserved, opening the same request again can look up that attempt, even after the request has expired. If the first result is uncertain, the prototype preserves that uncertainty so a retry cannot create a duplicate.

Testing uses a disposable database. Two connections try to reserve work against the same record, then the test opens the database again to check that the original reservation survived. Another check confirms that an uncommitted outer transaction cannot authorize a send.
