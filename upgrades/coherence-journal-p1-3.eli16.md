# The diaries start syncing between machines (P1.3 — the apply engine)

This is the piece that finally answers your EXO question from EITHER machine. P1.1 made each machine keep its diaries; P1.2 made them readable; P1.3 lets machines safely exchange copies — so when you ask the Laptop "where did the Mini's overnight run put its files?", the Laptop actually knows, because it holds a copy of the Mini's diary.

The hard part of syncing isn't the copying — it's not getting fooled. This is the receive-and-serve ENGINE, built with every defense the review demanded as real, tested code:

- **A machine can only hand over ITS OWN diary.** Every incoming line must be signed (at the transport layer) by the same machine it claims to be from; a machine trying to pass off a third machine's history is rejected and counted. So one confused or compromised machine cannot rewrite everyone's records.
- **Every line is checked before it's saved** — right size, right sequence number (exactly the next one expected), valid shape. A corrupted line marks that one peer's stream "suspect" and stops there; it self-clears once the peer sends 20 clean lines in a row. A torn line from one peer can never poison the whole picture.
- **Restore-from-backup is caught.** If a machine comes back from an old backup with its diary rewound, the "edition number" changes, the old copy is set aside (at most two kept, so a flapping machine can't fill the disk), and it's flagged loudly — instead of silently swallowing the machine's real new history forever.
- **Gone-history is honest.** If a machine asks for diary lines that have aged out, it gets told "those were pruned" and records a visible gap, rather than asking forever for something that no longer exists.
- **A copy isn't trusted until it's truly on disk.** The receiver saves and force-flushes a batch BEFORE it reports success — so a crash mid-sync can never leave a machine believing it has lines it actually lost.

This PR is the engine and its 26 tests; the last wiring step — actually carrying the little "I'm at line N" notes on the existing 30-second machine check-in and pulling deltas — plus the live two-machine proof on your Laptop+Mini, is the closing step. The engine is deliberately built to be driven by that wiring without knowing anything about the network: pure, testable, and impossible to make the mistakes the review caught on paper.
