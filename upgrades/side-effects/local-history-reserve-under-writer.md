# Side effects of holding the copy reservation under the writer lock

The private copy observation path pins existing destination directories and charges bootstrap space before registering its fixed worker. When the worker has validated the full artifact stream and holds the writer lock, staging adds the block-rounded claim costs including the forward database write, rollback write and journal. The ledger confirms the charge and disk floor before the observer receives the exact run and allocation identifiers.

This is an internal one-attempt path. It can refuse on low space, pin drift, stale confirmation or worker failure. It holds the charge through actual process close and namespace settlement. An interrupted creation or unresolved namespace remains fenced for recovery. Ordinary preview does not reserve copy space. The same machine disk floor and transaction allowance apply.

The observation only returns a discard to the worker. The allocation evidence is not a committed permit. The disposable pilot remains the only approved scope for copy execution. The change introduces no route or storage schema. Existing disk and namespace recovery applies if any residue survives a revert.

Independent rereview concurred. A focused real-child test admits bootstrap at the exact floor threshold and refuses the subsequent claim growth. It verifies observer suppression, namespace settlement and preservation of all prior charges.
