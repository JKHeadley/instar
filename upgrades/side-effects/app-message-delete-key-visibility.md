# Paired-key evidence revision for private Delete sync

The key ledger can provide a process-local revision for one stable, readable checkpoint. Missing, malformed and changing evidence yields no revision. The revision advances for accepted key records, file replacement and ledger restart. Duplicate replication retains the current value.

The existing verification view keeps its row parsing behavior. Public ledger rows are detached copies, so a caller cannot change the cached evidence. Production still needs machine trust, scope and access-policy checks. No HTTP route consumes this revision.

## 6b. Operator-surface quality

A client cannot resume under an old key-evidence revision after pairing records change.

## Framework generality

This revision belongs to the common paired-device ledger.
