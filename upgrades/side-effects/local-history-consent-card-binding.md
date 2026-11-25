# Side effects of reading the exact Work Board card for owner consent

The unmounted consent helper reads the current folded Work Board card for a private server-owned association. It compares the recorded card revision, operation, preview digest and owner with the verified staging metadata. A changed, redacted, closed or withdrawn card refuses. The operation identifier now accompanies the existing private staging projection.

The helper returns only the card identifier and material revision. It creates no card, writes no association, and grants no copy authority. A future endpoint must load the association from its trusted private storage and verify current source ownership. Its signed proposal must still use the separately verified native owner presence proof. Real-history copying remains held.

Tests exercise an actual Work Board fold and the sealed staging projection. Reverting this unmounted helper changes no persisted format.

A consent revision includes the folded material-write lineage and Work Board restriction and reopen records. Restoring an earlier title or approving a withdrawn card does not make an earlier consent revision current. The new folded field is derived from existing records and needs no migration.

Independent rereview concurred on the full folded material lineage and restriction history. The regression injects an earlier replicated edit that preserves the final title and content hash but advances the consent revision.
