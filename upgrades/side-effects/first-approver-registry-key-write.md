# Conditional first-approver registry key write

The dark writer checks the exact local owner device and host binding, current transport key and prior presence-key hash. It refuses reuse of any device key by decoded key hash. It persists the new key and exact reserved operation together and flushes the replacement. Reopening can confirm the exact operation, while a later legacy replacement clears its marker.

The registry method assumes exclusive writer custody and a durable slot reservation from its caller. It is not installed on the live routes. Shared reservation wiring, predecessor exclusion during holder transfer, and recovery against the trust journal remain required.
