# Local Verify semaphore capacity reads

Machine-load sampling and verifier capacity checks read current holder and capacity state without opening the diagnostic event ledger. The capacity-only result preserves holder, saturation and cap semantics. The diagnostic endpoint still includes the recent events and skip counts.

This reduces synchronous disk reads on the server thread. The change affects a placement signal. The existing semaphore still decides acquisition and release. Existing state files and formats remain compatible. Reverting the change restores the earlier read behavior.
