# Side effects of private owner-consent card association storage

The staging coordinator can store one card revision for one exact owned preview in its existing private jobs database. It checks the live owner, prepared phase and saved preview hash inside the existing transaction. Exact replay is idempotent. A different card, revision or preview cannot replace that association. The card is unique across operations and the table has a bounded row count.

The table is created only through the unmounted internal writer and contains identifiers and digests. It stores no owner names, history text, confirmation secrets or presence signatures. It persists across restart for audit and recovery. A new boot still cannot use an old preview as live authority.

No route, UI, credential proof or permit issuance is added. The future caller must supply the trusted server-created Work Board association and verify live card and source ownership. Reverting the helper leaves its private records intact. Real-history copying remains held.

Independent rereview concurred. Reads check the declared columns, operation primary key, unique card index and row ceiling. The fixture attempts to bind the same card across two independently prepared previews and verifies refusal.
