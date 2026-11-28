# Side effects of durable relay pin custody

The dormant client parity store verifies an agent certificate against current signed evidence and the latest recorded pin in the same SQLite transaction. It preserves the owner head, serving epoch and per-machine TLS revision floors across restart.

- Refused evidence, a corrupt stored pin, or a failed persistence check cannot replace trust. A hostname belongs to its existing assignment and owner record. Repeat verification of unchanged evidence avoids rewriting the record.
- The dedicated client database stores public identity pins and digests only. It stores no certificate private keys, ownership credentials, relay codes or conversation contents.
- This is a client storage parity fixture. Native storage integration must preserve the same compare-and-update semantics and protect the trust database against restoration or removal of prior pins. This fixture assumes the local database file itself stays in trusted custody. It opens no listener, and no production app or agent is wired to it.
- Reverting does not require migrating or removing stored trust. Existing data stays in its private database.

## Class-Closure Declaration

- `unbounded-self-action`: closure n/a. Each check performs one caller-requested verification and optional local write.

Independent rereview concurred with latest-state verification and exact write/readback checks.
