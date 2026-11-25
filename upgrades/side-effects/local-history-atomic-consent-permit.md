# Side effects of the dormant consent and permit transaction

An optional recorder stores a consumed approval digest in the same SQLite transaction as the existing first permit and transition to applying. It requires the exact operation, preview, apply request, and a trusted current approval check inside the caller's writer transaction.

- The recorder refuses missing and mismatched approval, a duplicate digest or operation, an unexpected schema, and capacity exhaustion. A failed write rolls back both records and the phase through the savepoint.
- This is persistence at the existing first-permit boundary. A production caller must hold the writer lease and disk reservation, verify current owner presence, source ownership, card and target, and supply a strong digest of that exact proof.
- The machine-local private jobs database stores bounded IDs and digests. No presence signature, challenge, owner name or conversation contents are persisted here.
- Existing recovery still uses the permit record. A new receipt proves recorded consumption only. It confers no delivery authority or independent approval.
- The production server and disposable pilot do not call this recorder or initialize its table. Reverting leaves any private receipt rows intact without a migration.

Independent review concurred with savepoint rollback, replay refusal and the dormant caller boundary.
