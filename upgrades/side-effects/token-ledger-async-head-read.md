# Legacy TokenLedger fingerprint reads

The Laptop profile attributed about 1.518 seconds in a 24.042-second sample to the scheduled legacy TokenLedger fingerprint path. This is a separate path from the newer Studio Usage Ledger scanner.

The scheduled scan now opens, stats, fingerprints, and releases a transcript asynchronously. The content scan uses the same open descriptor and retains its existing synchronous payload transaction, byte budget, and offset rules. A partial fingerprint or an unavailable file leaves its checkpoint in place so a later tick can retry. Shutdown checks the ledger state before any SQLite mutation after a pending disk read.

This is a local usage observation, consistent with `docs/signal-vs-authority.md`. The file-selection age rule, request deduplication, public token routes and reporting authority are preserved. The synchronous administrative entry remains available. Payload parsing and synchronous SQLite writes can still take time. There is one existing poll cadence and the normal scan shares its existing cursor. Machine-local file reads and checkpoint storage stay on the machine that owns the transcript. Existing usage consumers and machine attribution are unchanged. Backing out the change restores the previous fingerprint reader and uses the same stored offsets.
