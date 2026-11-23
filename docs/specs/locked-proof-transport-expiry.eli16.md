# What a dropped connection tells us

A disconnected viewer has a grace period in which it can reconnect. The proof records when the connection drops and when the duty closes. Neither observation tells us exactly when the server expired the connection. The two cases that require expiry immediately before or after Enter now report that this timing was unmeasured. The report still flags a duty that closes too early.

For example, the viewer can disconnect before Enter and still have time to reconnect after Enter. Even if the screen is locked when the test finishes, those two observations leave several possible times for expiry. A longer delay between the disconnect and the first observation of a closed duty cannot resolve that uncertainty. The timestamp that matters belongs to the server handling the connection.

This correction changes the result printed by the developer proof. Both rows include an explicit reason for the failed expectation, even when the test supplies a plausible expiry timestamp as extra data. If the duty closed inside the grace period, the report shows that finding too. The targeted tests exercise both orderings with synthetic records, so their passing result establishes how the report handles that evidence. Measuring the timing on an actual Mac remains a separate question.
