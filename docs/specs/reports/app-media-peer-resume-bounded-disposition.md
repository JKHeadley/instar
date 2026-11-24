# Peer attachment resume bounded review disposition

The review covered the exact design at ac61faee2745e5a037b3e26a07bb3d4fd832e420. The Chief of Staff authorized one additional round restricted to post-failure file sync and rollback custody, unsupported identities, and handling of invalid or unsigned replies. Both internal reviewers concurred. The actual Codex CLI review found two material issues.

- An old runtime can rearm a pull without changing the persisted generation. A stale retirement marker cannot prove that a later downgrade followed the same controlled handoff. The integration must either enforce the per-handoff transition or narrow the assurance scope and prove a second rollback after a fresh checkpoint.
- On a relay that returns plain HTTP JSON, an unsigned success can be the result of proof removal. Deleting a prior checkpoint immediately can discard already verified bytes. The design must decide how to protect the committed prefix while preserving offset-zero fallback for old sources, including the additional disk cost if a verified replacement is staged.

The review also calls for literal canonical byte and signature fixtures generated independently of the production encoder, with mismatched source and recipient tests. No functionality or limits changed. This card is parked under the designated review disposition. The checkpoint is a draft, without a convergence or approval claim.
