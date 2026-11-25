# Side effects of binding owner consent to the saved preview

The staging method resolves one owned prepared preview from the exact sealed ledger bytes. It verifies the stored preview digest against those bytes and returns the ordered artifact bindings, current destination identity, owner, and expiry. The result excludes challenge secrets and history contents.

A missing, expired, unowned or corrupted preview refuses. The method reads metadata and does not stage or reread the normalized bodies. It cannot establish the capture machine or source owner's authority. A later consent endpoint must obtain that provenance and the current Work Board revision independently, and the worker must still revalidate every artifact before permit issuance.

The method is unmounted and grants no authority. Existing receipt replay and copy staging retain their existing protocol. Reverting the helper changes no persisted schema or state.

Independent review concurred that the projected digest identifies the verified allocation bytes and that the live owner is rechecked before returning. The test corrupts one stored byte at fixed length and confirms the same owner can no longer obtain a consent projection from it.
