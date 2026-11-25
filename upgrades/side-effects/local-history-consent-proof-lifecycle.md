# Side effects of the dormant history approval proof lifecycle

A successful owner presence confirmation returns an authenticated approval token inside the encrypted response. It is scoped to the exact review, apply request, authenticated device and Host, enrolled presence key, and the original approval window. The adapter keeps an ephemeral key in process memory. A restart requires a new confirmation.

- The first-permit verifier rebuilds the current review, verifies current owner, presence key and source evidence, checks the deadline and compares the token authentication code in constant time.
- A valid token yields a metadata-only proof digest for the existing atomic consent-use and first-permit transaction. The verifier does not consume approval in memory. A rolled-back transaction can retry and a committed one refuses reuse.
- The token is a private authorization credential. It belongs only in the sealed response and authenticated writer input. The durable use row stores its digest.
- This branch adds no production consent service, permit caller, native app enablement or copy permission. The HTTP integration fixture connects the dormant adapter to a private test database.
- The token is intentionally target-process local. Revert invalidates tokens without migrating data and preserves any durable records.

Independent review concurred. The runtime integration must keep the staging monotonic lifetime check alongside the existing wall-clock presence deadline.
