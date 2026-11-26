# Side effects of the copy reserve recheck

Copy custody now rereads the exact empty reservation and checks all current outstanding allocations against the floor after child registration. The assertion operates inside the existing ledger transaction and brackets the measurement with the same identity checks as growth. A successful assertion has no durable write or authority effect.

A new disk pressure reading, replacement path, invalid charge or ledger contention can stop an inert child at registration. The existing custody lifecycle waits for actual close and attempts settlement, preserving unresolved charges. The floor reading describes the time of the check. Other volume users can still draw down space afterward.

The change adds a guard for the eventual permit boundary. The jobs transaction, permit delivery and pilot route remain separate. Real-user copy remains held. Reverting the assertion and its call together restores prior behavior with no persisted format change.

Independent review concurred. Growth retains its existing active-row, pinned-placeholder and outstanding-capacity checks. The assertion uses zero additional bytes because the held charge is already in outstanding allocations.
